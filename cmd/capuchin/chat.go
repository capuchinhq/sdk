package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"capuchin.dev/sdk"
	"go.temporal.io/sdk/client"
)

// withRetry tolerates transient connection errors — including a `capuchin dev` restart
// mid-conversation (the durability demo: the workflow resumes from .capuchin/dev.db and
// the chat session just keeps going).
func withRetry[T any](f func() (T, error)) (T, error) {
	var last error
	for i := 0; i < 120; i++ {
		v, err := f()
		if err == nil {
			return v, nil
		}
		last = err
		time.Sleep(500 * time.Millisecond)
	}
	var zero T
	return zero, last
}

// chat — an interactive session with an agent (`capuchin chat [name]`; no name talks to
// the worker's default agent). Prints the durable event stream as it happens; prompts
// for approval when a gated tool wants to run.
func chat(args []string) error {
	agentName := ""
	if len(args) > 0 {
		agentName = args[0]
	}

	address := os.Getenv("TEMPORAL_ADDRESS")
	if address == "" {
		address = devAddr
	}
	c, err := client.Dial(client.Options{HostPort: address})
	if err != nil {
		return err
	}
	defer c.Close()

	ctx := context.Background()
	id := fmt.Sprintf("chat-%d", time.Now().UnixNano())
	we, err := c.ExecuteWorkflow(ctx, client.StartWorkflowOptions{
		ID:        "agent:" + id,
		TaskQueue: capuchin.TaskQueue,
	}, "agentWorkflow", capuchin.StartInput{Agent: agentName, ConversationID: id})
	if err != nil {
		return err
	}
	wfID := we.GetID()

	label := agentName
	if label == "" {
		label = "default agent"
	}
	fmt.Printf("capuchin chat — %s (durable workflow: %s)\n", label, wfID)
	fmt.Println(`Type a message — or "exit" to end.`)
	fmt.Println()

	scanner := bufio.NewScanner(os.Stdin)
	offset := 0
	answered := map[string]bool{}

	for {
		fmt.Print("you: ")
		if !scanner.Scan() {
			break
		}
		text := strings.TrimSpace(scanner.Text())
		if text == "" {
			continue
		}
		if text == "exit" || text == "quit" {
			break
		}

		_, err := withRetry(func() (client.WorkflowUpdateHandle, error) {
			return c.UpdateWorkflow(ctx, client.UpdateWorkflowOptions{
				WorkflowID:   wfID,
				UpdateName:   "userMessage",
				Args:         []any{text},
				WaitForStage: client.WorkflowUpdateStageCompleted,
			})
		})
		if err != nil {
			return fmt.Errorf("send message: %w", err)
		}

		// Follow the turn: print events as they land; handle approvals; stop at idle.
		// State is read BEFORE events on purpose: if state says idle, the events read
		// that follows is guaranteed to include the whole turn (no missed tail).
		sawEvents := false
		for {
			st, err := withRetry(func() (capuchin.AgentState, error) { return queryState(c, wfID) })
			if err != nil {
				return err
			}

			events, err := withRetry(func() ([]capuchin.Event, error) { return queryEvents(c, wfID, offset) })
			if err != nil {
				return err
			}
			if len(events) > 0 {
				sawEvents = true
				printEvents(events)
				offset += len(events)
			}

			if st.Status == "awaiting_approval" && len(st.PendingApprovals) > 0 {
				pending := false
				for _, p := range st.PendingApprovals {
					if answered[p.ToolUseID] {
						continue
					}
					pending = true
					fmt.Printf("approve %s? [y/N, or type a denial reason]: ", p.ToolName)
					if !scanner.Scan() {
						return nil
					}
					ans := strings.TrimSpace(scanner.Text())
					dec := capuchin.ApproveToolInput{ToolUseID: p.ToolUseID, Decision: "deny", Reason: "denied by user"}
					switch strings.ToLower(ans) {
					case "y", "yes":
						dec = capuchin.ApproveToolInput{ToolUseID: p.ToolUseID, Decision: "approve"}
					case "", "n", "no":
						// keep default deny
					default:
						dec.Reason = ans
					}
					_, err := withRetry(func() (client.WorkflowUpdateHandle, error) {
						return c.UpdateWorkflow(ctx, client.UpdateWorkflowOptions{
							WorkflowID:   wfID,
							UpdateName:   "approveTool",
							Args:         []any{dec},
							WaitForStage: client.WorkflowUpdateStageCompleted,
						})
					})
					if err != nil {
						return fmt.Errorf("send approval: %w", err)
					}
					answered[p.ToolUseID] = true
				}
				if pending {
					continue
				}
			}

			if st.Status == "idle" && sawEvents {
				break
			}
			if st.Status == "cancelled" || st.Status == "abandoned" || st.Status == "max_turns" {
				fmt.Println("conversation ended:", st.Status)
				return nil
			}
			time.Sleep(200 * time.Millisecond)
		}
	}

	_ = c.SignalWorkflow(ctx, wfID, "", "cancel", nil)
	fmt.Println("bye")
	return nil
}

func queryEvents(c client.Client, wfID string, since int) ([]capuchin.Event, error) {
	val, err := c.QueryWorkflow(context.Background(), wfID, "", "getEvents", since)
	if err != nil {
		return nil, err
	}
	var events []capuchin.Event
	err = val.Get(&events)
	return events, err
}

func queryState(c client.Client, wfID string) (capuchin.AgentState, error) {
	val, err := c.QueryWorkflow(context.Background(), wfID, "", "getState")
	if err != nil {
		return capuchin.AgentState{}, err
	}
	var st capuchin.AgentState
	err = val.Get(&st)
	return st, err
}

func printEvents(events []capuchin.Event) {
	for _, e := range events {
		switch e.Type {
		case "assistant_message":
			if strings.TrimSpace(e.Text) != "" {
				fmt.Println("agent:", e.Text)
			}
		case "tool_start":
			fmt.Printf("  [tool] %s running...\n", e.ToolName)
		case "tool_end":
			if e.IsError {
				fmt.Printf("  [tool] %s -> error/denied\n", e.ToolName)
			} else {
				fmt.Printf("  [tool] %s -> ok\n", e.ToolName)
			}
		case "approval_required":
			in, _ := json.Marshal(e.Input)
			fmt.Printf("  [approval required] %s %s\n", e.ToolName, in)
		}
	}
}
