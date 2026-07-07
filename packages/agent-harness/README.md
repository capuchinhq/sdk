# @simiancreative/agent-harness

A reusable, **product-agnostic** Temporal agent harness: the agent **is** a Temporal
workflow, and the model call + every tool call are durable Temporal **activities**.
Conversation history, the tool-call ledger, pending approvals, and an offset-keyed
event log all live in replay-safe workflow state, so a conversation survives a worker
restart and replays identically.

This package ships **no worker, no LLM SDK, no DB, no auth, no HTTP** — it is workflow
code + types + a model-call _interface_. A consumer implements `CallModelActivity`
with its own LLM SDK, supplies its own tools + `AgentConfig`, and hosts its own worker
(see plan `docs/plans/0006-frnly-ai-agent.md`).

## Subpath exports

| Import                                              | Contents                                                                                                                                          | Safe to import from                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `@simiancreative/agent-harness/workflow`            | `agentWorkflow`, `AgentConfig`, the signal/update/query handler definitions, `registerInlineTools`                                                | a worker's `workflowsPath` module (PURE — webpack/determinism-clean) |
| `@simiancreative/agent-harness/activities-contract` | all types (`AgentTool`, `InlineTool`, `CallModelActivity`, `AgentMessage`, `AgentEvent`, `AgentState`, …) + the pure `approvalRequired` evaluator | both the workflow bundle AND a consumer's activity code              |

The `./workflow` entry imports **only** `@temporalio/workflow` (values) and the
type-only `./activities-contract`. The `./workflow` → `./activities-contract` edge is
`import type`-only.

## The turn loop (exact behavior)

On `userMessageUpdate`: append the user message, wake the loop. Then: call `callModel`
→ emit `assistant_message`. If `stopReason==='tool_use'`, for **each** tool_use block:
emit `tool_start`; consult the `ToolApprovalPolicy` (+ the tool's `inherentlySafe`
hint); if approval is required, emit `approval_required` (carrying **that** `toolUseId`)
and `await condition(() => approvals.has(toolUseId) || cancelled, approvalTimeoutMs)` —
no activity timeout burns. `cancelSignal` escapes; the no-progress timeout abandons a
stale approval and ends gracefully. On **approve**, run the tool (a proxied activity for
`kind:'activity'`; the registered inline runner for `kind:'inline'`), append the
`tool_result`, loop back to the model. On **deny**, the structured `reason` becomes the
tool's error `tool_result` fed into the next model turn so the model can **re-propose**
(not halt). On `end_turn`, await the next `userMessageUpdate`. `maxTurns` exhaustion is
terminal + graceful: emit `max_turns_reached` and end the turn (never a thrown error).

Injected params (`AgentConfig.injected`) are **never** in any `toolSchemas[].inputSchema`
sent to the model, nor in the rendered `system` string — they are forwarded to the tool
activity as `(modelArgs, injected)` for tenant scoping.

### Inline tools

An `InlineTool.run` is a function, so it cannot ride in a JSON workflow argument. A
consumer registers inline runners in its `workflowsPath` module:

```ts
// workflows.ts (the module the worker bundles)
export { agentWorkflow } from '@simiancreative/agent-harness/workflow';
import { registerInlineTools } from '@simiancreative/agent-harness/workflow';

registerInlineTools({
	my_inline_tool: (args, injected) => deterministicCompute(args) // no I/O, no Date.now(), no random
});
```

## Cross-version replay safety

Any new loop-behavior branch is gated behind an `AgentConfig.loopFlags` flag (absent →
old path) — the same input-gating discipline an entity workflow uses for an
`initialPending`-style field — and/or `patched()` / `deprecatePatch()` from
`@temporalio/workflow`. Both seams are demonstrated in `src/workflow/agent-workflow.ts`
(`maybeEmitTurnStart` for the flag seam; the deny-default-message for the `patched()`
seam) and covered by `src/replay.test.ts`.

## Scripts / gates

```sh
pnpm --filter @simiancreative/agent-harness build   # tsc → import-clean dist/
pnpm --filter @simiancreative/agent-harness lint    # eslint, incl. the import boundary
pnpm --filter @simiancreative/agent-harness test    # time-skipping suite vs the BUILT artifact
```

### Import-boundary lint (CI note)

`eslint.config.js` enforces, on `src/workflow/**`, that the pure bundle may not import
`node:*`/`@anthropic-ai/*` and that the `./workflow` → `./activities-contract` edge is
`import type`-only (`no-restricted-imports` + `@typescript-eslint/consistent-type-imports`).
A `lint` run **fails** if a value import is added across that edge — verified by
temporarily adding `import { approvalRequired } from '../activities-contract/index.js';`
to a workflow file (eslint exits non-zero with the `no-restricted-imports` error), then
reverting. CI runs the package `lint` to keep the determinism boundary honest.

The tests register `agentWorkflow` via `workflowsPath` pointing at the **built**
`dist/workflow/index.js` (not raw TS), so the SDK's webpack bundling at worker boot is
itself the determinism gate — a build-step purity leak fails the suite.
