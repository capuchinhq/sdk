package capuchin

import (
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

const (
	defaultMaxTurns        = 8
	defaultApprovalTimeout = 24 * time.Hour
)

// agentWorkflow — the agent loop as a durable Temporal workflow (the Go port of the
// TS harness's agentWorkflow). Conversation transcript, the event log, and pending
// approvals live in replay-safe workflow state; the model call and every tool run
// are activities. The approval wait is a workflow Await — it burns no activity
// timeout while a human decides, and it survives worker restarts (this is the
// durability demo: kill `capuchin dev` at the approval prompt, restart, approve).
//
// The input is just {agent, conversationId}; the full AgentConfig comes from the
// worker's registry via the getAgentConfig activity, recorded in history so replay
// never re-reads live code.
//
// TODO: continue-as-new for very long conversations (history growth is unbounded).
func agentWorkflow(ctx workflow.Context, start StartInput) (AgentState, error) {
	state := AgentState{
		ConversationID:   start.ConversationID,
		Status:           "idle",
		PendingApprovals: []PendingApproval{},
	}

	var pendingMsgs []string
	cancelled := false
	approvals := map[string]ApproveToolInput{}

	if err := workflow.SetUpdateHandler(ctx, "userMessage",
		func(ctx workflow.Context, text string) (UserMessageResult, error) {
			pendingMsgs = append(pendingMsgs, text)
			return UserMessageResult{Accepted: true}, nil
		}); err != nil {
		return state, err
	}

	if err := workflow.SetUpdateHandler(ctx, "approveTool",
		func(ctx workflow.Context, in ApproveToolInput) (ApproveToolResult, error) {
			found := false
			for _, p := range state.PendingApprovals {
				if p.ToolUseID == in.ToolUseID {
					found = true
					break
				}
			}
			if !found {
				return ApproveToolResult{Ok: false}, nil
			}
			approvals[in.ToolUseID] = in
			return ApproveToolResult{Ok: true}, nil
		}); err != nil {
		return state, err
	}

	_ = workflow.SetQueryHandler(ctx, "getEvents", func(since int) ([]Event, error) {
		out := []Event{}
		for _, e := range state.Events {
			if e.Offset >= since {
				out = append(out, e)
			}
		}
		return out, nil
	})
	_ = workflow.SetQueryHandler(ctx, "getState", func() (AgentState, error) { return state, nil })

	cancelCh := workflow.GetSignalChannel(ctx, "cancel")
	workflow.Go(ctx, func(gctx workflow.Context) {
		cancelCh.Receive(gctx, nil)
		cancelled = true
	})

	// Resolve the agent config AFTER the handlers are up (a client may send its first
	// userMessage the instant the workflow starts — handlers must already exist). The
	// activity result is recorded in history, so replay never re-reads live code.
	cfgCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 10 * time.Second,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 3},
	})
	var config AgentConfig
	if err := workflow.ExecuteActivity(cfgCtx, "getAgentConfig", start.Agent).Get(ctx, &config); err != nil {
		return state, err
	}
	config.ConversationID = start.ConversationID

	maxTurns := config.MaxTurns
	if maxTurns == 0 {
		maxTurns = defaultMaxTurns
	}
	approvalTimeout := defaultApprovalTimeout
	if config.ApprovalTimeoutMs > 0 {
		approvalTimeout = time.Duration(config.ApprovalTimeoutMs) * time.Millisecond
	}

	modelCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 10 * time.Minute, // a model turn is slow
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 2},
	})
	toolCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: time.Minute,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 3},
	})

	emit := func(e Event) {
		e.Offset = len(state.Events)
		state.Events = append(state.Events, e)
	}

	for {
		if err := workflow.Await(ctx, func() bool { return len(pendingMsgs) > 0 || cancelled }); err != nil {
			return state, err
		}
		if cancelled {
			state.Status = "cancelled"
			return state, nil
		}
		text := pendingMsgs[0]
		pendingMsgs = pendingMsgs[1:]
		state.Messages = append(state.Messages, Message{Role: "user", Content: []ContentBlock{{Type: "text", Text: text}}})

		// The turn loop for this user message: model → tools → model … until end_turn.
		turnsThisMessage := 0
		for {
			if cancelled {
				state.Status = "cancelled"
				return state, nil
			}
			if turnsThisMessage >= maxTurns {
				emit(Event{Type: "max_turns_reached", TurnSeq: state.TurnSeq})
				state.Status = "max_turns"
				return state, nil
			}
			turnsThisMessage++
			state.TurnSeq++
			state.Status = "thinking"
			emit(Event{Type: "turn_start", TurnSeq: state.TurnSeq})

			var result CallModelResult
			input := CallModelInput{
				System:         config.System,
				Messages:       state.Messages,
				Tools:          config.Tools,
				TurnSeq:        state.TurnSeq,
				ConversationID: config.ConversationID,
				Model:          config.Model,
			}
			if err := workflow.ExecuteActivity(modelCtx, "callModel", input).Get(ctx, &result); err != nil {
				return state, err
			}
			state.Messages = append(state.Messages, result.Message)
			emit(Event{Type: "assistant_message", TurnSeq: state.TurnSeq, Text: textOf(result.Message), StopReason: result.StopReason})

			if result.StopReason != "tool_use" {
				break
			}

			// Run each requested tool, gating per the approval policy.
			results := []ContentBlock{}
			for _, b := range result.Message.Content {
				if b.Type != "tool_use" {
					continue
				}
				if approvalRequired(config.ApprovalPolicy, b.Name) {
					state.PendingApprovals = append(state.PendingApprovals, PendingApproval{ToolUseID: b.ToolUseID, ToolName: b.Name, Input: b.Input})
					state.Status = "awaiting_approval"
					emit(Event{Type: "approval_required", ToolUseID: b.ToolUseID, ToolName: b.Name, Input: b.Input})

					// The durable pause: no activity in flight, no timeout burning.
					ok, err := workflow.AwaitWithTimeout(ctx, approvalTimeout, func() bool {
						_, decided := approvals[b.ToolUseID]
						return decided || cancelled
					})
					state.PendingApprovals = removePending(state.PendingApprovals, b.ToolUseID)
					if err != nil {
						return state, err
					}
					if cancelled {
						state.Status = "cancelled"
						return state, nil
					}
					if !ok { // timed out — abandoned
						state.Status = "abandoned"
						return state, nil
					}
					if d := approvals[b.ToolUseID]; d.Decision != "approve" {
						// Deny-with-reason: the reason goes back to the model as an
						// error tool_result so it can re-propose rather than halt.
						reason := d.Reason
						if reason == "" {
							reason = "denied by user"
						}
						results = append(results, ContentBlock{Type: "tool_result", ToolUseID: b.ToolUseID, Content: reason, IsError: true})
						emit(Event{Type: "tool_end", ToolUseID: b.ToolUseID, ToolName: b.Name, IsError: true})
						continue
					}
					state.Status = "thinking"
				}

				emit(Event{Type: "tool_start", ToolUseID: b.ToolUseID, ToolName: b.Name})
				var out string
				err := workflow.ExecuteActivity(toolCtx, "runTool", RunToolInput{Name: b.Name, Input: b.Input, Injected: config.Injected}).Get(ctx, &out)
				if err != nil {
					results = append(results, ContentBlock{Type: "tool_result", ToolUseID: b.ToolUseID, Content: err.Error(), IsError: true})
					emit(Event{Type: "tool_end", ToolUseID: b.ToolUseID, ToolName: b.Name, IsError: true})
				} else {
					results = append(results, ContentBlock{Type: "tool_result", ToolUseID: b.ToolUseID, Content: out})
					emit(Event{Type: "tool_end", ToolUseID: b.ToolUseID, ToolName: b.Name})
				}
			}
			state.Messages = append(state.Messages, Message{Role: "tool", Content: results})
		}
		state.Status = "idle"
	}
}

func textOf(m Message) string {
	out := ""
	for _, b := range m.Content {
		if b.Type == "text" {
			if out != "" {
				out += "\n"
			}
			out += b.Text
		}
	}
	return out
}

func removePending(list []PendingApproval, id string) []PendingApproval {
	out := make([]PendingApproval, 0, len(list))
	for _, p := range list {
		if p.ToolUseID != id {
			out = append(out, p)
		}
	}
	return out
}
