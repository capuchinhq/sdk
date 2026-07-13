# Grove SDK

Durable AI agents. Write a tool and a prompt — inherit durability, human approval
gating, metering, and replay from the harness. The agent is a [Temporal](https://temporal.io)
workflow: conversations survive restarts, deploys, and crashes, and risky tool calls
pause durably for human approval.

> **Working name.** "Grove" is a placeholder while the project is pre-release.

## Install

```sh
brew install rossnelson/tap/grove
```

Or grab a binary from [Releases](https://github.com/rossnelson/grove-sdk/releases). No npm.

## Quickstart

```sh
grove dev     # one command: embedded Temporal + web UI + agent worker + mock model
grove chat    # talk to the demo agent (in another terminal)
```

`grove dev` needs nothing pre-installed — no Docker, no Node, no API key. It embeds a
Temporal dev server (downloaded on first run, state persisted to `.grove/`) and runs
the agent worker in-process. Set `ANTHROPIC_API_KEY` for real model responses; without
it a scripted mock keeps the whole loop working offline.

The demo agent handles refunds: `lookupOrder` runs automatically, `issueRefund` pauses
for your approval in the terminal. Kill `grove dev` while an approval is pending,
restart it, approve — the conversation resumes exactly where it was. That's the point.

## Write your own agent

```sh
grove init my-agent && cd my-agent
grove dev     # builds and runs YOUR worker, hot reload on save
grove chat    # talk to it (another terminal)
```

An agent is tools + a prompt, in plain Go:

```go
var issueRefund = grove.Tool{
	Name:          "issueRefund",
	Input:         grove.Schema{"orderId": "string", "amountCents": "number"},
	NeedsApproval: true, // pauses durably for a human
	Run: func(a grove.Args, ctx grove.Ctx) (string, error) {
		return refund(a.String("orderId"), a.Float("amountCents"))
	},
}

var billing = grove.Agent{
	Name:   "billing",
	System: "You handle billing disputes.",
	Tools:  grove.Tools{issueRefund},
}

func main() { log.Fatal(grove.Serve(billing)) }
```

Durability, the approval gate, replayable history, and the event stream are inherited —
your code is just the tools and the prompt. Building your own agent needs Go 1.24+
(`go.dev/dl`); the built-in demo doesn't.

## Layout

| Path | What |
|---|---|
| `grove/` | The Go SDK (`github.com/rossnelson/grove-sdk/grove`) and the `grove` CLI (`grove/cmd/grove`) |
| `packages/agent-harness` | TypeScript agent harness (the TS SDK) |

## Development status

Early. The platform is Go-first; the TypeScript harness is the second SDK. This repo
is a read-only mirror published from a private monorepo — issues and discussions are
welcome here; the code syncs one-way.

## License

[Apache-2.0](LICENSE)
