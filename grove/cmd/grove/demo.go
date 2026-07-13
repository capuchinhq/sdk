package main

import (
	"encoding/json"
	"fmt"

	"github.com/rossnelson/grove-sdk/grove"
)

// demoAgent — the built-in refund demo `grove dev` serves when the current directory
// isn't a grove project. It's the same agent `grove init` scaffolds, defined through
// the same public API a user project uses. lookupOrder runs freely; issueRefund
// pauses durably for human approval.
func demoAgent() grove.Agent {
	lookupOrder := grove.Tool{
		Name:        "lookupOrder",
		Description: "Look up an order by id: item, amount, delivery status.",
		Input:       grove.Schema{"orderId": "string"},
		Run: func(a grove.Args, _ grove.Ctx) (string, error) {
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

	issueRefund := grove.Tool{
		Name:          "issueRefund",
		Description:   "Issue a refund for an order. Moves real money.",
		Input:         grove.Schema{"orderId": "string", "amountCents": "number"},
		NeedsApproval: true,
		Run: func(a grove.Args, _ grove.Ctx) (string, error) {
			// Pretend side effect. A real agent would call Stripe here — with
			// credentials from ctx.Injected, never from model-visible input.
			return fmt.Sprintf("refund issued for order %s: $%.2f", a.String("orderId"), a.Float("amountCents")/100), nil
		},
	}

	return grove.Agent{
		Name:   "billing",
		System: "You are a billing-support agent. Look up orders and issue refunds when they qualify. Never move money without approval.",
		Tools:  grove.Tools{lookupOrder, issueRefund},
	}
}
