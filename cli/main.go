package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/testsuite"
)

const devAddr = "127.0.0.1:7233"

// version is injected at release time via -ldflags "-X main.version=X.Y.Z".
var version = "dev"

func main() {
	cmd := ""
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	switch cmd {
	case "version", "--version", "-v":
		fmt.Println("grove " + version)
	case "dev":
		if err := dev(); err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
	case "chat":
		if err := chat(); err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
	case "", "-h", "--help", "help":
		help()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n", cmd)
		help()
		os.Exit(1)
	}
}

func help() {
	fmt.Print(`grove — durable AI agents (Go prototype)

Usage:
  grove dev      Start the whole local stack: Temporal + UI + worker (mock model)
  grove chat     Talk to the refund demo agent (needs 'grove dev' running)
  grove version  Print the CLI version
  grove --help   Show this help
`)
}

func portInUse(addr string) bool {
	conn, err := net.DialTimeout("tcp", addr, 300*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// dev starts the entire local stack from this one binary. If nothing is on the
// Temporal port it embeds a dev server (downloading it on first run) with the web UI;
// if Temporal is already running there it reuses it. The worker runs in-process.
// State persists to .grove/dev.db — delete the dir for a clean slate.
func dev() error {
	fmt.Println("grove dev — starting the local stack...")

	var c client.Client
	if portInUse(devAddr) {
		cc, err := client.Dial(client.Options{HostPort: devAddr})
		if err == nil {
			_, err = cc.CheckHealth(context.Background(), &client.CheckHealthRequest{})
		}
		if err != nil {
			return fmt.Errorf("%s is in use but not reachable as Temporal — free it (`lsof -ti :7233 | xargs kill`) and retry: %w", devAddr, err)
		}
		fmt.Println("  (reusing the Temporal already running on " + devAddr + ")")
		c = cc
		defer c.Close()
	} else {
		if err := os.MkdirAll(".grove", 0o755); err != nil {
			return fmt.Errorf("create .grove dir: %w", err)
		}
		server, err := testsuite.StartDevServer(context.Background(), testsuite.DevServerOptions{
			ClientOptions: &client.Options{HostPort: devAddr},
			DBFilename:    ".grove/dev.db",
			EnableUI:      true,
			LogLevel:      "error",
		})
		if err != nil {
			return fmt.Errorf("start temporal dev server: %w", err)
		}
		defer server.Stop()
		c = server.Client()
	}

	w, err := startWorker(c) // worker runs in-process, in this binary
	if err != nil {
		return err
	}
	defer w.Stop()

	fmt.Println()
	fmt.Println("  temporal    " + devAddr)
	fmt.Println("  web ui      http://localhost:8233")
	fmt.Println("  worker      running (task queue \"grove\")")
	fmt.Println("  model       " + activeModelLabel())
	fmt.Println()
	fmt.Println("  Try:  ./grove chat   (in another terminal)")
	fmt.Println("  Ctrl-C to stop.")

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	fmt.Println("\nstopping...")
	return nil
}

// withRetry tolerates transient connection errors — including a `grove dev` restart
// mid-conversation (the durability demo: the workflow resumes from .grove/dev.db and
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

// chat — an interactive session with the refund demo agent. Prints the durable event
// stream as it happens; prompts for approval when a gated tool wants to run.
func chat() error {
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
		TaskQueue: taskQueue,
	}, "agentWorkflow", refundAgent(id))
	if err != nil {
		return err
	}
	wfID := we.GetID()

	fmt.Println("grove chat — refund demo agent (durable workflow: " + wfID + ")")
	fmt.Println(`Try: "I need a refund for order A-1001" — type "exit" to end.`)
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
			st, err := withRetry(func() (AgentState, error) { return queryState(c, wfID) })
			if err != nil {
				return err
			}

			events, err := withRetry(func() ([]Event, error) { return queryEvents(c, wfID, offset) })
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
					dec := ApproveToolInput{ToolUseID: p.ToolUseID, Decision: "deny", Reason: "denied by user"}
					switch strings.ToLower(ans) {
					case "y", "yes":
						dec = ApproveToolInput{ToolUseID: p.ToolUseID, Decision: "approve"}
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

func queryEvents(c client.Client, wfID string, since int) ([]Event, error) {
	val, err := c.QueryWorkflow(context.Background(), wfID, "", "getEvents", since)
	if err != nil {
		return nil, err
	}
	var events []Event
	err = val.Get(&events)
	return events, err
}

func queryState(c client.Client, wfID string) (AgentState, error) {
	val, err := c.QueryWorkflow(context.Background(), wfID, "", "getState")
	if err != nil {
		return AgentState{}, err
	}
	var st AgentState
	err = val.Get(&st)
	return st, err
}

func printEvents(events []Event) {
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
