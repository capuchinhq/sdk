package main

import (
	"context"
	"fmt"
	"os"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

// CallModel — the model activity. Dispatches to the Anthropic adapter when
// credentials are present, else the scripted mock (keyless demo). Force with
// GROVE_MODEL=mock|anthropic.
func CallModel(ctx context.Context, input CallModelInput) (CallModelResult, error) {
	switch os.Getenv("GROVE_MODEL") {
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

// toolHandler runs worker-side (it's an activity), so it may do I/O freely.
type toolHandler func(ctx context.Context, input map[string]any, injected map[string]any) (string, error)

// toolRegistry maps tool name → handler. Tools register here (see example_refund.go);
// the workflow dispatches by name so no function ever rides in workflow state.
var toolRegistry = map[string]toolHandler{}

// RunTool — the tool-dispatch activity. Injected params arrive here, never through
// the model-visible input.
func RunTool(ctx context.Context, in RunToolInput) (string, error) {
	h, ok := toolRegistry[in.Name]
	if !ok {
		return "", fmt.Errorf("no tool registered: %q", in.Name)
	}
	return h(ctx, in.Input, in.Injected)
}

const taskQueue = "grove"

// startWorker runs the agent worker in-process — in this same binary.
func startWorker(c client.Client) (worker.Worker, error) {
	w := worker.New(c, taskQueue, worker.Options{})
	w.RegisterWorkflowWithOptions(AgentWorkflow, workflow.RegisterOptions{Name: "agentWorkflow"})
	w.RegisterActivityWithOptions(CallModel, activity.RegisterOptions{Name: "callModel"})
	w.RegisterActivityWithOptions(RunTool, activity.RegisterOptions{Name: "runTool"})
	return w, w.Start()
}
