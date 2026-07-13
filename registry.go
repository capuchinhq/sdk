package capuchin

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

// TaskQueue is the Temporal task queue every capuchin worker serves.
const TaskQueue = "capuchin"

// DefaultAddress is where `capuchin dev` runs Temporal; Serve dials it unless
// TEMPORAL_ADDRESS overrides.
const DefaultAddress = "127.0.0.1:7233"

// toolHandler runs worker-side (it's an activity), so it may do I/O freely.
type toolHandler func(ctx context.Context, input, injected map[string]any) (string, error)

// registry holds what a worker serves: lowered agent configs by name, plus tool
// handlers by name (handlers never serialize — the workflow dispatches by name
// through the runTool activity).
type registry struct {
	configs     map[string]AgentConfig
	defaultName string
	tools       map[string]toolHandler
}

func newRegistry(agents []Agent) (*registry, error) {
	if len(agents) == 0 {
		return nil, errors.New("no agents to serve")
	}
	r := &registry{configs: map[string]AgentConfig{}, tools: map[string]toolHandler{}}
	for i, a := range agents {
		name := agentName(a, len(agents))
		if name == "" {
			return nil, fmt.Errorf("agent %d has no Name — names are required when serving multiple agents", i)
		}
		if _, dup := r.configs[name]; dup {
			return nil, fmt.Errorf("duplicate agent name %q", name)
		}
		for _, t := range a.Tools {
			if t.Name == "" {
				return nil, fmt.Errorf("agent %q has a tool with no Name", name)
			}
			if t.Run == nil {
				return nil, fmt.Errorf("tool %q has no Run function", t.Name)
			}
			if _, dup := r.tools[t.Name]; dup {
				return nil, fmt.Errorf("duplicate tool name %q (tool names are worker-global for now)", t.Name)
			}
			run := t.Run
			r.tools[t.Name] = func(ctx context.Context, input, injected map[string]any) (string, error) {
				return run(Args(input), Ctx{Context: ctx, Injected: injected})
			}
		}
		r.configs[name] = a.config()
		if i == 0 {
			r.defaultName = name
		}
	}
	return r, nil
}

// agentName resolves an agent's serve name: a single unnamed agent becomes "agent";
// multiple agents must be named ("" means invalid, caller errors).
func agentName(a Agent, total int) string {
	if a.Name != "" {
		return a.Name
	}
	if total == 1 {
		return "agent"
	}
	return ""
}

// getAgentConfig — activity. The workflow's first step: resolve the named agent (or
// the default) to its full config, pinning it in durable history.
func (r *registry) getAgentConfig(ctx context.Context, name string) (AgentConfig, error) {
	if name == "" {
		name = r.defaultName
	}
	cfg, ok := r.configs[name]
	if !ok {
		names := make([]string, 0, len(r.configs))
		for n := range r.configs {
			names = append(names, n)
		}
		sort.Strings(names)
		return AgentConfig{}, fmt.Errorf("no agent named %q on this worker (available: %s)", name, strings.Join(names, ", "))
	}
	return cfg, nil
}

// runTool — the tool-dispatch activity. Injected params arrive here, never through
// the model-visible input.
func (r *registry) runTool(ctx context.Context, in RunToolInput) (string, error) {
	h, ok := r.tools[in.Name]
	if !ok {
		return "", fmt.Errorf("no tool registered: %q", in.Name)
	}
	return h(ctx, in.Input, in.Injected)
}

// callModel — the model activity. Dispatches to the Anthropic adapter when
// credentials are present, else the scripted mock (keyless demo). Force with
// CAPUCHIN_MODEL=mock|anthropic.
func callModel(ctx context.Context, input CallModelInput) (CallModelResult, error) {
	switch os.Getenv("CAPUCHIN_MODEL") {
	case "mock":
		return mockCallModel(input)
	case "anthropic":
		return anthropicCallModel(ctx, input)
	}
	if anthropicConfigured() {
		return anthropicCallModel(ctx, input)
	}
	return mockCallModel(input)
}

// StartWorker registers the harness workflow and activities for the given agents on
// a non-blocking worker attached to an existing client. Most programs want Serve;
// the capuchin CLI uses this to host its embedded demo.
func StartWorker(c client.Client, agents ...Agent) (worker.Worker, error) {
	r, err := newRegistry(agents)
	if err != nil {
		return nil, err
	}
	w := worker.New(c, TaskQueue, worker.Options{})
	w.RegisterWorkflowWithOptions(agentWorkflow, workflow.RegisterOptions{Name: "agentWorkflow"})
	w.RegisterActivityWithOptions(callModel, activity.RegisterOptions{Name: "callModel"})
	w.RegisterActivityWithOptions(r.runTool, activity.RegisterOptions{Name: "runTool"})
	w.RegisterActivityWithOptions(r.getAgentConfig, activity.RegisterOptions{Name: "getAgentConfig"})
	return w, w.Start()
}

// Serve is the agent-project entry point: dial Temporal (TEMPORAL_ADDRESS, or the
// `capuchin dev` default), serve the given agents, and block until interrupted.
func Serve(agents ...Agent) error {
	addr := os.Getenv("TEMPORAL_ADDRESS")
	if addr == "" {
		addr = DefaultAddress
	}

	var c client.Client
	var err error
	for i := 0; i < 20; i++ { // `capuchin dev` may still be booting Temporal
		c, err = client.Dial(client.Options{HostPort: addr})
		if err == nil {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if err != nil {
		return fmt.Errorf("connect to temporal at %s (is `capuchin dev` running?): %w", addr, err)
	}
	defer c.Close()

	w, err := StartWorker(c, agents...)
	if err != nil {
		return err
	}
	defer w.Stop()

	names := make([]string, 0, len(agents))
	for _, a := range agents {
		names = append(names, agentName(a, len(agents)))
	}
	fmt.Printf("capuchin worker — serving %s on %s (task queue %q)\n", strings.Join(names, ", "), addr, TaskQueue)

	<-worker.InterruptCh()
	return nil
}
