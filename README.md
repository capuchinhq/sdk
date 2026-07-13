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

## Layout

| Path | What |
|---|---|
| `cli/` | The `grove` CLI + Go agent harness (Go-first platform) |
| `packages/agent-harness` | TypeScript agent harness (the TS SDK) |

## Development status

Early. The platform is Go-first; the TypeScript harness is the second SDK. This repo
is a read-only mirror published from a private monorepo — issues and discussions are
welcome here; the code syncs one-way.

## License

[Apache-2.0](LICENSE)
