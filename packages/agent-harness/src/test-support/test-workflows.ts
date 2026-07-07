// ── Test workflows entry (a CONSUMER-shaped `workflowsPath` module) ──────────
// This is exactly the shape a real consumer's `workflows.ts` takes: it re-exports
// the harness `agentWorkflow` (so the worker bundles it) AND registers its inline
// tool runners at module top level (so the deterministic `run` lives IN the workflow
// bundle, present on every replay — a function can't ride in a JSON workflow arg).
// The R-harness inline-tool tests bundle the BUILT version of this file via
// `workflowsPath`. A consumer does the identical thing with its own inline tools.

export { agentWorkflow } from '../workflow/index.js';
import { registerInlineTools } from '../workflow/index.js';

registerInlineTools({
	// Mirrors the `echo` inline tool the (b) scenario configures: deterministic,
	// no I/O / Date.now() / random.
	echo: (args: Record<string, unknown>) => `echoed:${String(args.value)}`,
	// The maxTurns scenario's looping inline tool.
	loop: () => 'again'
});
