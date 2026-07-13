package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// initCmd — `capuchin init [dir]`: scaffold a runnable agent project. The template is
// the refund agent (the same one the built-in demo serves), so the scripted mock
// model drives it end-to-end with no API key.
func initCmd(args []string) error {
	dir := "."
	if len(args) > 0 {
		dir = args[0]
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
		return fmt.Errorf("%s already has a go.mod — refusing to overwrite an existing project", dir)
	}

	abs, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	module := moduleName(filepath.Base(abs))

	files := map[string]string{
		"go.mod":     fmt.Sprintf("module %s\n\ngo 1.24\n", module),
		"main.go":    templateMain,
		".gitignore": ".capuchin/\n",
		"README.md":  fmt.Sprintf(templateReadme, module),
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			return err
		}
		fmt.Println("  created", filepath.Join(dir, name))
	}

	// Resolve the SDK dependency for the user if the Go toolchain is around.
	if _, err := exec.LookPath("go"); err != nil {
		fmt.Println("\nGo isn't installed — install it (https://go.dev/dl), then run:")
		fmt.Println("  go get capuchin.dev/sdk@latest")
	} else {
		fmt.Println("  resolving dependencies (go get)...")
		get := exec.Command("go", "get", "capuchin.dev/sdk@latest")
		get.Dir = dir
		if out, err := get.CombinedOutput(); err != nil {
			fmt.Printf("  go get failed:\n%s\n  Run it manually in %s when you're online:\n    go get capuchin.dev/sdk@latest\n", indent(string(out)), dir)
		} else {
			tidy := exec.Command("go", "mod", "tidy")
			tidy.Dir = dir
			_ = tidy.Run()
		}
	}

	fmt.Println("\nNext:")
	if dir != "." {
		fmt.Println("  cd " + dir)
	}
	fmt.Println("  capuchin dev          # the whole stack, your agent, hot reload")
	fmt.Println("  capuchin chat         # talk to it (another terminal)")
	fmt.Println("\nNo API key needed — a scripted mock model runs the loop. Set ANTHROPIC_API_KEY for real responses.")
	return nil
}

// moduleName sanitizes a directory name into a usable module path segment.
func moduleName(base string) string {
	name := strings.ToLower(base)
	name = regexp.MustCompile(`[^a-z0-9._-]+`).ReplaceAllString(name, "-")
	name = strings.Trim(name, "-._")
	if name == "" {
		name = "my-agent"
	}
	return name
}

const templateMain = `package main

import (
	"encoding/json"
	"fmt"
	"log"

	"capuchin.dev/sdk"
)

// Tools are plain Go functions. Run executes worker-side, so any I/O is fine.
// NeedsApproval pauses the conversation durably — in the workflow engine, not in
// RAM — until a human approves or denies the call.

var lookupOrder = capuchin.Tool{
	Name:        "lookupOrder",
	Description: "Look up an order by id: item, amount, delivery status.",
	Input:       capuchin.Schema{"orderId": "string"},
	Run: func(a capuchin.Args, _ capuchin.Ctx) (string, error) {
		// Replace with a real lookup (database, API, ...).
		b, err := json.Marshal(map[string]any{
			"orderId":          a.String("orderId"),
			"item":             "Trail Runner shoes",
			"amountCents":      4999,
			"status":           "delivered",
			"deliveredDaysAgo": 12,
		})
		return string(b), err
	},
}

var issueRefund = capuchin.Tool{
	Name:          "issueRefund",
	Description:   "Issue a refund for an order. Moves real money.",
	Input:         capuchin.Schema{"orderId": "string", "amountCents": "number"},
	NeedsApproval: true,
	Run: func(a capuchin.Args, ctx capuchin.Ctx) (string, error) {
		// Real side effects go here — credentials belong in ctx.Injected,
		// never in model-visible input.
		return fmt.Sprintf("refund issued for order %s: $%.2f", a.String("orderId"), a.Float("amountCents")/100), nil
	},
}

var billing = capuchin.Agent{
	Name:   "billing",
	System: "You are a billing-support agent. Look up orders and issue refunds when they qualify. Never move money without approval.",
	Tools:  capuchin.Tools{lookupOrder, issueRefund},
}

func main() {
	if err := capuchin.Serve(billing); err != nil {
		log.Fatal(err)
	}
}
`

const templateReadme = `# %s

A [Capuchin](https://capuchin.dev) agent: tools + a prompt, running as a durable workflow.

## Run it

` + "```sh" + `
capuchin dev     # embedded Temporal + web UI + this worker, hot reload on save
capuchin chat    # talk to the agent (another terminal)
` + "```" + `

Works offline with a scripted mock model. Set ANTHROPIC_API_KEY for real responses.

Try: "I need a refund for order A-1001" — the lookup runs automatically, the refund
pauses for your approval. Kill capuchin dev mid-approval, restart, approve: the
conversation resumes exactly where it was.
`
