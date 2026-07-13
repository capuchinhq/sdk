// Package grove is the Grove agent SDK: define tools and agents in plain Go and run
// them as durable Temporal workflows. Conversations survive restarts and deploys, and
// any tool marked NeedsApproval pauses durably until a human approves or denies it.
//
// A minimal agent:
//
//	var refund = grove.Tool{
//		Name:          "issueRefund",
//		Input:         grove.Schema{"orderId": "string", "cents": "int"},
//		NeedsApproval: true,
//		Run: func(a grove.Args, ctx grove.Ctx) (string, error) {
//			return doRefund(a.String("orderId"), a.Int("cents"))
//		},
//	}
//
//	var billing = grove.Agent{
//		Name:   "billing",
//		System: "You handle billing disputes.",
//		Tools:  grove.Tools{refund},
//	}
//
//	func main() { log.Fatal(grove.Serve(billing)) }
//
// Run `grove dev` in the project directory to bring up the local stack (embedded
// Temporal + web UI) and build/run this worker with hot reload; `grove chat` talks
// to the agent.
package grove

import (
	"context"
	"sort"
)

// Args is a tool call's model-provided input, decoded from JSON.
type Args map[string]any

// String returns the named argument as a string ("" if absent or another type).
func (a Args) String(k string) string { s, _ := a[k].(string); return s }

// Float returns the named argument as a float64 (JSON numbers decode as float64).
func (a Args) Float(k string) float64 {
	switch v := a[k].(type) {
	case float64:
		return v
	case int:
		return float64(v)
	}
	return 0
}

// Int returns the named argument as an int (0 if absent or not a number).
func (a Args) Int(k string) int { return int(a.Float(k)) }

// Bool returns the named argument as a bool (false if absent or another type).
func (a Args) Bool(k string) bool { b, _ := a[k].(bool); return b }

// Ctx is the worker-side context a tool runs with. Injected carries model-hidden
// per-call values (tenant, credentials) — the model can neither see nor forge them;
// they arrive through the serving seam, never through Args.
type Ctx struct {
	Context  context.Context
	Injected map[string]any
}

// Schema declares a tool's input fields. Values are either a JSON type name
// ("string", "int", "number", "bool") or a full JSON-schema property map for
// anything richer. All declared fields are required.
type Schema map[string]any

// Tool is one capability an agent can call. Run executes worker-side as a Temporal
// activity, so I/O is fine. NeedsApproval gates the call behind a durable human
// approve/deny pause.
type Tool struct {
	Name          string
	Description   string
	Input         Schema
	NeedsApproval bool
	Run           func(Args, Ctx) (string, error)
}

// Tools is a list of Tool — sugar for agent literals.
type Tools []Tool

// Price is marketplace listing metadata. Nothing is billed locally; this is recorded
// when the agent is pushed to a marketplace.
type Price struct {
	Type string  `json:"type"`
	USD  float64 `json:"usd"`
}

// PerCall prices an agent at a flat USD amount per conversation-turn call.
func PerCall(usd float64) Price { return Price{Type: "per_call", USD: usd} }

// Agent is tools + a prompt. Everything else — durability, approval gating,
// metering, replayable history — is inherited from the harness.
type Agent struct {
	Name     string // how `grove chat <name>` addresses it; defaults to "agent" when serving a single agent
	System   string
	Tools    Tools
	Model    string // optional model override, passed through to the adapter (e.g. "claude-opus-4-8")
	MaxTurns int    // model calls per user message (default 8)
	Price    Price  // marketplace metadata only
}

// config lowers the public Agent to the serializable harness contract.
func (a Agent) config() AgentConfig {
	defs := make([]ToolDef, 0, len(a.Tools))
	var gated []string
	for _, t := range a.Tools {
		defs = append(defs, ToolDef{
			Name:           t.Name,
			Description:    t.Description,
			InputSchema:    t.Input.jsonSchema(),
			InherentlySafe: !t.NeedsApproval,
		})
		if t.NeedsApproval {
			gated = append(gated, t.Name)
		}
	}
	policy := ApprovalPolicy{Type: "auto"}
	if len(gated) > 0 {
		policy = ApprovalPolicy{Type: "denylist", Tools: gated}
	}
	return AgentConfig{
		System:         a.System,
		Tools:          defs,
		ApprovalPolicy: policy,
		Model:          a.Model,
		MaxTurns:       a.MaxTurns,
	}
}

// jsonSchema expands the shorthand Schema into a JSON-schema object. Keys are sorted
// so the lowered config is stable.
func (s Schema) jsonSchema() map[string]any {
	keys := make([]string, 0, len(s))
	for k := range s {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	props := map[string]any{}
	required := make([]any, 0, len(keys))
	for _, k := range keys {
		switch v := s[k].(type) {
		case string:
			props[k] = map[string]any{"type": jsonType(v)}
		case map[string]any:
			props[k] = v
		default:
			props[k] = map[string]any{"type": "string"}
		}
		required = append(required, k)
	}
	return map[string]any{"type": "object", "properties": props, "required": required}
}

func jsonType(t string) string {
	switch t {
	case "int", "integer":
		return "integer"
	case "float", "number":
		return "number"
	case "bool", "boolean":
		return "boolean"
	default:
		return "string"
	}
}
