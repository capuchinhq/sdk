package main

import (
	"context"
	"encoding/json"
	"fmt"
)

// The refund demo agent — the "tools + a prompt" example from the marketing page.
// lookupOrder is safe and runs immediately; issueRefund is on the approval denylist,
// so the workflow pauses durably until a human approves or denies it.

func refundAgent(conversationID string) AgentConfig {
	return AgentConfig{
		System: "You are a billing-support agent. Look up orders and issue refunds when they qualify. Never move money without approval.",
		Tools: []ToolDef{
			{
				Name:        "lookupOrder",
				Description: "Look up an order by id: item, amount, delivery status.",
				InputSchema: map[string]any{
					"type":       "object",
					"properties": map[string]any{"orderId": map[string]any{"type": "string"}},
					"required":   []any{"orderId"},
				},
				InherentlySafe: true,
			},
			{
				Name:        "issueRefund",
				Description: "Issue a refund for an order. Moves real money.",
				InputSchema: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"orderId":     map[string]any{"type": "string"},
						"amountCents": map[string]any{"type": "number"},
					},
					"required": []any{"orderId", "amountCents"},
				},
			},
		},
		// Only issueRefund gates — lookups run without a human.
		ApprovalPolicy: ApprovalPolicy{Type: "denylist", Tools: []string{"issueRefund"}},
		ConversationID: conversationID,
	}
}

// Tool handlers — worker-side activities (I/O is fine here). A real agent would hit
// a database / Stripe; the demo returns canned data.
func init() {
	toolRegistry["lookupOrder"] = func(ctx context.Context, input, injected map[string]any) (string, error) {
		id, _ := input["orderId"].(string)
		if id == "" {
			id = "A-1001"
		}
		order := map[string]any{
			"orderId":          id,
			"item":             "Trail Runner shoes",
			"amountCents":      4999,
			"status":           "delivered",
			"deliveredDaysAgo": 12,
		}
		b, err := json.Marshal(order)
		return string(b), err
	}

	toolRegistry["issueRefund"] = func(ctx context.Context, input, injected map[string]any) (string, error) {
		id, _ := input["orderId"].(string)
		cents, _ := input["amountCents"].(float64)
		// Pretend side effect. This is where a real Stripe call would live — note it
		// would use credentials from `injected`, never from model-visible input.
		return fmt.Sprintf("refund issued for order %s: $%.2f", id, cents/100), nil
	}
}
