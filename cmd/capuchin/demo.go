package main

import (
	"encoding/json"
	"fmt"

	"capuchin.dev/sdk"
)

// demoAgent — the built-in refund demo `capuchin dev` serves when the current directory
// isn't a capuchin project. It's the same agent `capuchin init` scaffolds, defined through
// the same public API a user project uses. lookupOrder runs freely; issueRefund
// pauses durably for human approval.
func demoAgent() capuchin.Agent {
	lookupOrder := capuchin.Tool{
		Name:        "lookupOrder",
		Description: "Look up an order by id: item, amount, delivery status.",
		Input:       capuchin.Schema{"orderId": "string"},
		Run: func(a capuchin.Args, _ capuchin.Ctx) (string, error) {
			id := a.String("orderId")
			if id == "" {
				id = "A-1001"
			}
			b, err := json.Marshal(map[string]any{
				"orderId":          id,
				"item":             "Trail Runner shoes",
				"amountCents":      4999,
				"status":           "delivered",
				"deliveredDaysAgo": 12,
			})
			return string(b), err
		},
	}

	issueRefund := capuchin.Tool{
		Name:          "issueRefund",
		Description:   "Issue a refund for an order. Moves real money.",
		Input:         capuchin.Schema{"orderId": "string", "amountCents": "number"},
		NeedsApproval: true,
		Run: func(a capuchin.Args, _ capuchin.Ctx) (string, error) {
			// Pretend side effect. A real agent would call Stripe here — with
			// credentials from ctx.Injected, never from model-visible input.
			return fmt.Sprintf("refund issued for order %s: $%.2f", a.String("orderId"), a.Float("amountCents")/100), nil
		},
	}

	return capuchin.Agent{
		Name:   "billing",
		System: "You are a billing-support agent. Look up orders and issue refunds when they qualify. Never move money without approval.",
		Tools:  capuchin.Tools{lookupOrder, issueRefund},
	}
}
