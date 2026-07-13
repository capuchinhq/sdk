// The capuchin CLI: scaffold agent projects, run the local durable-agent stack, and
// talk to agents. The agent harness itself lives in the parent package
// (capuchin.dev/sdk) — user projects import that.
package main

import (
	"fmt"
	"os"
)

// version is injected at release time via -ldflags "-X main.version=X.Y.Z".
var version = "dev"

func main() {
	cmd := ""
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	switch cmd {
	case "version", "--version", "-v":
		fmt.Println("capuchin " + version)
	case "init":
		if err := initCmd(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
	case "dev":
		if err := dev(); err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
	case "chat":
		if err := chat(os.Args[2:]); err != nil {
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
	fmt.Print(`capuchin — durable AI agents

Usage:
  capuchin init [dir]    Scaffold a new agent project (Go)
  capuchin dev           Start the local stack: Temporal + web UI + your agent worker
  capuchin chat [agent]  Talk to an agent (needs 'capuchin dev' running)
  capuchin version       Print the CLI version
  capuchin --help        Show this help

In a directory scaffolded by 'capuchin init', 'capuchin dev' builds and runs YOUR worker
with hot reload. Anywhere else it serves a built-in refund demo agent, so the whole
loop works with nothing installed and no API key.
`)
}
