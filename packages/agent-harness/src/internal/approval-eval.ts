// ── Pure approval evaluator (shared, dependency-free) ─────────────────────────
// Lives in `internal/` so it can be imported as a VALUE from BOTH the pure workflow
// bundle and the activities-contract without violating the `./workflow` →
// `./activities-contract` type-only edge (AQ-BUNDLE). It has ZERO imports — no
// `@temporalio/*`, no SDK, no node:* — so it's safe in the workflow bundle. The
// activities-contract re-exports it as the public `approvalRequired`.

import type { ToolApprovalPolicy } from '../activities-contract/approval.js';

/**
 * Pure, deterministic: does THIS tool call require human approval under THIS policy?
 * `inherentlySafe` is the tool's hint; the policy decides whether to honor it (see
 * `ToolApprovalPolicy` for the per-type semantics). No I/O, no clock, no randomness.
 */
export function approvalRequired(
	policy: ToolApprovalPolicy,
	toolName: string,
	inherentlySafe: boolean
): boolean {
	switch (policy.type) {
		case 'auto':
			return false;
		case 'all':
			// `all` is the strong form: pause everything, the safe hint notwithstanding.
			return true;
		case 'allowlist':
			// Auto-approve the listed names; everything else asks unless inherently safe.
			if (policy.autoApprove.includes(toolName)) return false;
			return !inherentlySafe;
		case 'denylist':
			// Only the listed names ask; the list is an explicit "always ask" so it wins
			// over the safe hint. Unlisted tools never pause.
			return policy.alwaysAsk.includes(toolName);
	}
}
