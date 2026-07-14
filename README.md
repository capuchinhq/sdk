# Capuchin SDK

Durable AI agents. Write a tool and a prompt — inherit durability, human approval
gating, metering, and replay from the harness. The agent is a [Temporal](https://temporal.io)
workflow: conversations survive restarts, deploys, and crashes, and risky tool calls
pause durably for human approval.

Named for the capuchin — the helper monkey that runs errands and, historically,
performed tasks for coins. A [Simian Creative](https://simiancreative.com) project.

## Install

```sh
brew install capuchinhq/tap/sdk
```

Or grab a binary from [Releases](https://github.com/capuchinhq/sdk/releases). No npm.

## Quickstart

```sh
capuchin dev     # one command: embedded Temporal + web UI + agent worker + mock model
capuchin chat    # talk to the demo agent (in another terminal)
```

`capuchin dev` needs nothing pre-installed — no Docker, no Node, no API key. It embeds a
Temporal dev server (downloaded on first run, state persisted to `.capuchin/`) and runs
the agent worker in-process. Set `ANTHROPIC_API_KEY` for real model responses; without
it a scripted mock keeps the whole loop working offline.

The demo agent handles refunds: `lookupOrder` runs automatically, `issueRefund` pauses
for your approval in the terminal. Kill `capuchin dev` while an approval is pending,
restart it, approve — the conversation resumes exactly where it was. That's the point.

## Write your own agent

```sh
capuchin init my-agent && cd my-agent
capuchin dev     # builds and runs YOUR worker, hot reload on save
capuchin chat    # talk to it (another terminal)
```

An agent is tools + a prompt, in plain Go:

```go
import "capuchin.dev/sdk" // package capuchin

var issueRefund = capuchin.Tool{
	Name:          "issueRefund",
	Input:         capuchin.Schema{"orderId": "string", "amountCents": "number"},
	NeedsApproval: true, // pauses durably for a human
	Run: func(a capuchin.Args, ctx capuchin.Ctx) (string, error) {
		return refund(a.String("orderId"), a.Float("amountCents"))
	},
}

var billing = capuchin.Agent{
	Name:   "billing",
	System: "You handle billing disputes.",
	Tools:  capuchin.Tools{issueRefund},
}

func main() { log.Fatal(capuchin.Serve(billing)) }
```

Durability, the approval gate, replayable history, and the event stream are inherited —
your code is just the tools and the prompt. Building your own agent needs Go 1.24+
(`go.dev/dl`); the built-in demo doesn't.

## Layout

This repo IS the Go module: `capuchin.dev/sdk` (package `capuchin`) at the root, the
`capuchin` CLI at `cmd/capuchin`. `go install capuchin.dev/sdk/cmd/capuchin@latest`
works too.

## Development status

Early. The platform is Go-first; a TypeScript SDK follows. This repo is a read-only
mirror published from a private monorepo — issues and discussions are welcome here;
the code syncs one-way.

## License

[Apache-2.0](LICENSE)
