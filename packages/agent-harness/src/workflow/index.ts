// ── @simiancreative/agent-harness/workflow ───────────────────────────────────
// The PURE workflow entry. A consumer's worker bundles THIS module via
// `workflowsPath`; it must be webpack/determinism-clean — it imports ONLY
// `@temporalio/workflow` (values) and the type-only `./activities-contract` (the
// `./workflow` → `./activities-contract` edge is `import type`-only, enforced by the
// package's import-boundary lint). No `node:*`, no SDKs, no I/O, no wall-clock reads
// for real-world side effects.

export { agentWorkflow, type AgentConfig } from './agent-workflow.js';

// Inline-tool runners are registered into the workflow bundle (a function can't ride
// in a JSON workflow arg) — a consumer calls this at the top level of the module the
// worker bundles via `workflowsPath`. See inline-registry.ts.
export { registerInlineTools } from './inline-registry.js';

export {
	userMessageUpdate,
	approveToolUpdate,
	cancelSignal,
	getStateQuery,
	getEventsQuery,
	type ApproveToolInput,
	type UserMessageResult,
	type ApproveToolResult
} from './handlers.js';
