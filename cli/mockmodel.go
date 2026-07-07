package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// mockCallModel — the built-in, keyless model. It's SCRIPTED to behave like a
// refund agent (lookup → refund → confirm; apologize on deny) so the demo shows
// tools + approval gating deterministically with no API key. A real adapter
// replaces this; the workflow doesn't care which one answered.
func mockCallModel(input CallModelInput) (CallModelResult, error) {
	// Scope the script to the CURRENT user turn: only look at what happened after
	// the last user message, so each message restarts the decision tree.
	tail := input.Messages
	for i := len(input.Messages) - 1; i >= 0; i-- {
		if input.Messages[i].Role == "user" {
			tail = input.Messages[i:]
			break
		}
	}
	lastUser := ""
	for _, b := range tail[0].Content {
		if b.Type == "text" {
			lastUser = b.Text
		}
	}

	// Did this turn already attempt a refund? Then report its outcome.
	if use := lastToolUse(tail, "issueRefund"); use != nil {
		if res := resultFor(tail, use.ToolUseID); res != nil {
			if res.IsError {
				return endTurn(fmt.Sprintf("Understood — I won't issue that refund (%s). Anything else I can help with?", res.Content)), nil
			}
			return endTurn(fmt.Sprintf("Done: %s. Anything else I can help with?", res.Content)), nil
		}
	}

	// Did we already look the order up this turn? Then propose the refund.
	if use := lastToolUse(tail, "lookupOrder"); use != nil {
		if res := resultFor(tail, use.ToolUseID); res != nil && !res.IsError {
			var order struct {
				OrderID     string  `json:"orderId"`
				AmountCents float64 `json:"amountCents"`
			}
			_ = json.Unmarshal([]byte(res.Content), &order)
			return CallModelResult{
				StopReason: "tool_use",
				Message: Message{Role: "assistant", Content: []ContentBlock{
					{Type: "text", Text: fmt.Sprintf("Order %s qualifies — issuing a refund of $%.2f.", order.OrderID, order.AmountCents/100)},
					{Type: "tool_use", ToolUseID: fmt.Sprintf("tu-%d-refund", input.TurnSeq), Name: "issueRefund",
						Input: map[string]any{"orderId": order.OrderID, "amountCents": order.AmountCents}},
				}},
			}, nil
		}
	}

	// Fresh request mentioning a refund/order → look it up first.
	if lower := strings.ToLower(lastUser); strings.Contains(lower, "refund") || strings.Contains(lower, "order") {
		orderID := "A-1001"
		if m := regexp.MustCompile(`[A-Za-z]+-\d+|\d{3,}`).FindString(lastUser); m != "" {
			orderID = m
		}
		return CallModelResult{
			StopReason: "tool_use",
			Message: Message{Role: "assistant", Content: []ContentBlock{
				{Type: "text", Text: "Let me pull up that order."},
				{Type: "tool_use", ToolUseID: fmt.Sprintf("tu-%d-lookup", input.TurnSeq), Name: "lookupOrder",
					Input: map[string]any{"orderId": orderID}},
			}},
		}, nil
	}

	return endTurn("I'm the billing-support demo agent (scripted mock — no API key needed). Try: \"I need a refund for order A-1001\"."), nil
}

func endTurn(text string) CallModelResult {
	return CallModelResult{
		StopReason: "end_turn",
		Message:    Message{Role: "assistant", Content: []ContentBlock{{Type: "text", Text: text}}},
	}
}

func lastToolUse(msgs []Message, name string) *ContentBlock {
	for i := len(msgs) - 1; i >= 0; i-- {
		for _, b := range msgs[i].Content {
			if b.Type == "tool_use" && b.Name == name {
				return &b
			}
		}
	}
	return nil
}

func resultFor(msgs []Message, toolUseID string) *ContentBlock {
	for i := len(msgs) - 1; i >= 0; i-- {
		for _, b := range msgs[i].Content {
			if b.Type == "tool_result" && b.ToolUseID == toolUseID {
				return &b
			}
		}
	}
	return nil
}
