// ── Inline-tool registry (workflow-bundle module state) ──────────────────────
// An `InlineTool.run` is a FUNCTION, and `AgentConfig` is a Temporal workflow
// argument — workflow args are JSON-serialized, so a function can't survive the trip
// into `agentWorkflow(config)`. (The `AgentConfig.tools` entries therefore carry an
// inline tool's METADATA — name/description/schema/kind — but its `run` is dropped on
// the wire.) The deterministic `run` must instead live in code the workflow bundle
// already contains.
//
// So a consumer REGISTERS its inline tool runners in its `workflows.ts` (the module
// the worker bundles via `workflowsPath`) by calling `registerInlineTools(...)` at
// module top level. The registry is plain module state inside the workflow bundle —
// deterministic and present on every replay (the same code is always bundled), so
// looking a runner up by name is replay-safe. `run` must itself be deterministic
// (no I/O, no Date.now(), no random) exactly as `InlineTool.run` requires.
//
// If a config names an inline tool with no registered runner, the workflow turns it
// into an error tool_result (so the model can react) rather than crashing.

import type { InjectedParams } from '../activities-contract/index.js';

type InlineRun = (args: Record<string, unknown>, injected: InjectedParams) => unknown;

const registry = new Map<string, InlineRun>();

/**
 * Register inline-tool runners by name. Call this at the TOP LEVEL of the module the
 * worker bundles as `workflowsPath` (alongside `export { agentWorkflow }`), so the
 * runners are present in the bundle on every replay. Idempotent per name (last
 * registration wins) — but a consumer should register each name exactly once.
 */
export function registerInlineTools(tools: Record<string, InlineRun>): void {
	for (const [name, run] of Object.entries(tools)) {
		registry.set(name, run);
	}
}

/** Look up a registered inline runner (undefined if none). Used by the workflow. */
export function getInlineRun(name: string): InlineRun | undefined {
	return registry.get(name);
}

/** Test-only: clear the registry between scenarios. */
export function __clearInlineToolsForTest(): void {
	registry.clear();
}
