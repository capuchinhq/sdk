// ── Approval policy ──────────────────────────────────────────────────────────
// A serializable human-in-the-loop policy that decides which tool calls PAUSE for
// an approve/deny (Principle 5). It's plain data so it lives safely in workflow
// state and replays deterministically. The `inherentlySafe` flag on a tool is a
// HINT — the policy is the authority.

export type ToolApprovalPolicy =
	/** Never pause — every tool runs immediately. */
	| { type: 'auto' }
	/** Pause every tool, regardless of `inherentlySafe`. */
	| { type: 'all' }
	/** Pause everything NOT in `autoApprove`. */
	| { type: 'allowlist'; autoApprove: string[] }
	/** Pause only the tools in `alwaysAsk` (e.g. R2: ['create_booking']). */
	| { type: 'denylist'; alwaysAsk: string[] };

/**
 * Pure, deterministic evaluator: does THIS tool call require human approval under
 * THIS policy? `inherentlySafe` is the tool's hint; the policy decides whether to
 * honor it. The rule (per the policy union):
 *
 *  - `auto`      → never pause.
 *  - `all`       → always pause (the hint is deliberately ignored — `all` means all).
 *  - `allowlist` → pause unless the tool is explicitly auto-approved OR inherently safe.
 *  - `denylist`  → pause only if the tool is listed (an explicit "always ask" that
 *                  wins over the safe hint); an unlisted tool never asks.
 *
 * No I/O, no clock, no randomness — safe to call inside the workflow. The body lives
 * in `../internal/approval-eval` (a dependency-free module importable as a VALUE from
 * the pure workflow bundle without crossing the type-only contract edge); this is the
 * public re-export for consumers.
 */
export { approvalRequired } from '../internal/approval-eval.js';
