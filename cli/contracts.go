package main

// Contracts — the language-neutral JSON shapes, ported from the TS harness
// (activities-contract). Everything here crosses the workflow/activity boundary and
// lives in durable history, so it's all plain JSON: no functions, no time.Time.

// ContentBlock is one span of a message. Go has no unions, so this is a flat struct;
// Type picks which fields are meaningful ("text" | "tool_use" | "tool_result").
type ContentBlock struct {
	Type      string         `json:"type"`
	Text      string         `json:"text,omitempty"`
	ToolUseID string         `json:"toolUseId,omitempty"`
	Name      string         `json:"name,omitempty"`    // tool_use: which tool
	Input     map[string]any `json:"input,omitempty"`   // tool_use: model-visible args only
	Content   string         `json:"content,omitempty"` // tool_result payload (or deny reason)
	IsError   bool           `json:"isError,omitempty"` // tool_result: error / denied
}

// Message is one transcript entry. Roles: user | assistant | tool.
type Message struct {
	Role    string         `json:"role"`
	Content []ContentBlock `json:"content"`
}

// ToolDef is the model-visible tool description plus gating metadata. Handlers are
// NOT here (functions don't serialize) — they live in the worker's tool registry and
// are dispatched by name through the runTool activity.
type ToolDef struct {
	Name           string         `json:"name"`
	Description    string         `json:"description"`
	InputSchema    map[string]any `json:"inputSchema"`
	InherentlySafe bool           `json:"inherentlySafe,omitempty"`
}

// ApprovalPolicy decides which tool calls pause for a human:
//
//	auto      — nothing gates
//	all       — every tool call gates
//	allowlist — listed tools run without approval; everything else gates
//	denylist  — listed tools gate; everything else runs
type ApprovalPolicy struct {
	Type  string   `json:"type"`
	Tools []string `json:"tools,omitempty"`
}

// approvalRequired is the pure policy evaluator. It runs inside the workflow, so it
// must stay deterministic (no I/O, no clock).
func approvalRequired(p ApprovalPolicy, tool string) bool {
	switch p.Type {
	case "all":
		return true
	case "allowlist":
		for _, t := range p.Tools {
			if t == tool {
				return false
			}
		}
		return true
	case "denylist":
		for _, t := range p.Tools {
			if t == tool {
				return true
			}
		}
		return false
	default: // "auto"
		return false
	}
}

// AgentConfig is the uniform agent input contract: tools + a prompt.
type AgentConfig struct {
	System         string         `json:"system"`
	Tools          []ToolDef      `json:"tools,omitempty"`
	ApprovalPolicy ApprovalPolicy `json:"approvalPolicy"`
	Injected       map[string]any `json:"injected,omitempty"` // model-hidden per-call context
	ConversationID string         `json:"conversationId"`
	// Model is an opaque pass-through: the workflow copies it into every
	// CallModelInput; the adapter interprets it (and supplies a default when empty).
	Model             string `json:"model,omitempty"`
	MaxTurns          int    `json:"maxTurns,omitempty"`          // model calls per user message
	ApprovalTimeoutMs int64  `json:"approvalTimeoutMs,omitempty"` // pending-approval abandon bound
}

// Event is one entry in the offset-keyed, replay-identical event log — the resume
// cursor for clients (the chat REPL polls getEvents(sinceOffset)).
type Event struct {
	Offset     int            `json:"offset"`
	Type       string         `json:"type"` // turn_start|assistant_message|tool_start|tool_end|approval_required|max_turns_reached
	TurnSeq    int            `json:"turnSeq,omitempty"`
	Text       string         `json:"text,omitempty"`
	StopReason string         `json:"stopReason,omitempty"`
	ToolUseID  string         `json:"toolUseId,omitempty"`
	ToolName   string         `json:"toolName,omitempty"`
	Input      map[string]any `json:"input,omitempty"`
	IsError    bool           `json:"isError,omitempty"`
}

// PendingApproval surfaces a paused tool call so a client can prompt the human.
type PendingApproval struct {
	ToolUseID string         `json:"toolUseId"`
	ToolName  string         `json:"toolName"`
	Input     map[string]any `json:"input"`
}

// AgentState is the full serializable state — the getState query payload and the
// workflow return value.
type AgentState struct {
	ConversationID   string            `json:"conversationId"`
	Status           string            `json:"status"` // idle|thinking|awaiting_approval|cancelled|abandoned|max_turns
	Messages         []Message         `json:"messages"`
	Events           []Event           `json:"events"`
	TurnSeq          int               `json:"turnSeq"`
	PendingApprovals []PendingApproval `json:"pendingApprovals"`
}

// CallModelInput / CallModelResult — the model activity contract. The harness defines
// the shape; an adapter (mock, Anthropic, …) implements it.
type CallModelInput struct {
	System         string    `json:"system"`
	Messages       []Message `json:"messages"`
	Tools          []ToolDef `json:"tools,omitempty"`
	TurnSeq        int       `json:"turnSeq"`
	ConversationID string    `json:"conversationId"`
	Model          string    `json:"model,omitempty"` // pass-through from AgentConfig.Model
}

type CallModelResult struct {
	Message    Message `json:"message"`
	StopReason string  `json:"stopReason"` // end_turn | tool_use | max_tokens | refusal
}

// RunToolInput — the tool-dispatch activity contract. Injected params ride here,
// never in the model-visible Input.
type RunToolInput struct {
	Name     string         `json:"name"`
	Input    map[string]any `json:"input"`
	Injected map[string]any `json:"injected,omitempty"`
}

// Update payloads/acks.
type UserMessageResult struct {
	Accepted bool `json:"accepted"`
}

type ApproveToolInput struct {
	ToolUseID string `json:"toolUseId"`
	Decision  string `json:"decision"` // approve | deny
	Reason    string `json:"reason,omitempty"`
}

type ApproveToolResult struct {
	Ok bool `json:"ok"`
}
