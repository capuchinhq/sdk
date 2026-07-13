// The grove CLI: scaffold agent projects, run the local durable-agent stack, and
// talk to agents. The agent harness itself lives in the parent package
// (github.com/rossnelson/grove-sdk/grove) — user projects import that.
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
		fmt.Println("grove " + version)
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
	fmt.Print(`grove — durable AI agents

Usage:
  grove init [dir]    Scaffold a new agent project (Go)
  grove dev           Start the local stack: Temporal + web UI + your agent worker
  grove chat [agent]  Talk to an agent (needs 'grove dev' running)
  grove version       Print the CLI version
  grove --help        Show this help

In a directory scaffolded by 'grove init', 'grove dev' builds and runs YOUR worker
with hot reload. Anywhere else it serves a built-in refund demo agent, so the whole
loop works with nothing installed and no API key.
`)
}
