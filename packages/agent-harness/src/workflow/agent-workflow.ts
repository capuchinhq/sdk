// ── agentWorkflow — the reusable agent core ──────────────────────────────────
// The agent IS a Temporal workflow. Conversation history, the running tool-call
// ledger, pending approvals, and the offset-keyed event log all live in durable,
// replay-safe workflow state, so they survive worker restart and replay
// deterministically (the same property a long-lived booking/onboarding entity
// workflow has). All non-determinism — the model call, activity-backed tool calls —
// is pushed into activities (`proxyActivities`); the approval wait is an in-workflow
// `condition()` (Principle 5) so no activity timeout burns while a human decides.
//
// This file is PURE workflow code: it imports ONLY `@temporalio/workflow` (values)
// and the type-only `./activities-contract` (no SDK, no node:*, no I/O). The
// import-boundary lint enforces it.

import { proxyActivities, setHandler, condition, patched } from '@temporalio/workflow';
// VALUE import — the pure, dependency-free evaluator (no `@temporalio/*`, no SDK, no
// node:*). It deliberately does NOT come from `../activities-contract` so the
// `./workflow` → `./activities-contract` edge stays `import type`-only (AQ-BUNDLE).
import { approvalRequired } from '../internal/approval-eval.js';
import { getInlineRun } from './inline-registry.js';
import type {
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentStatus,
	AnyTool,
	CallModelActivity,
	ContentBlock,
	InjectedParams,
	ToolApprovalPolicy,
	ToolResultBlock,
	ToolSchema,
	ToolUseBlock
} from '../activities-contract/index.js';
import {
	approveToolUpdate,
	cancelSignal,
	getEventsQuery,
	getStateQuery,
	userMessageUpdate,
	type ApproveToolInput
} from './handlers.js';

/**
 * The uniform agent input contract — the reusability property. A consumer builds
 * one of these per conversation, injecting its tenant/auth context into `injected`
 * (never a model-choosable field — Principle 4). `system`/`tools`/`approvalPolicy`
 * shape the agent; `maxTurns`/`approvalTimeoutMs` bound the loop; `loopFlags` is the
 * cross-version replay seam (see REPLAY SAFETY below).
 */
export interface AgentConfig {
	system: string;
	tools: AnyTool[];
	approvalPolicy: ToolApprovalPolicy;
	/** Workflow-supplied, model-hidden per-call context (tenant, acting user, …). */
	injected: InjectedParams;
	conversationId: string;
	/** The model this agent runs on — an opaque pass-through string the workflow copies
	 *  into every `CallModelInput.model`. The harness stays product/provider-agnostic:
	 *  it never interprets this value; the consumer's `CallModelActivity` interprets it
	 *  (and supplies its own default when unset). When absent the field is simply omitted
	 *  from `CallModelInput` (→ old behavior, replay-safe — it's a deterministic input). */
	model?: string;
	/** Safety bound on model turns per user message (default DEFAULT_MAX_TURNS). On
	 *  exhaustion the workflow emits `max_turns_reached` and ends the turn gracefully
	 *  — NOT a thrown error. */
	maxTurns?: number;
	/** No-progress bound (ms) on an abandoned approval. When a pending approval is
	 *  neither approved/denied nor cancelled within this window, the workflow treats
	 *  it as abandoned and ends gracefully (default DEFAULT_APPROVAL_TIMEOUT_MS). */
	approvalTimeoutMs?: number;
	/**
	 * Loop-behavior flags — the cross-version replay seam (risk 1 / H5). Any NEW
	 * loop-behavior branch is gated behind a flag here: an in-flight workflow started
	 * before the change carries the flag absent (→ the old path) and replays
	 * identically; new workflows set it true. This mirrors the input-gating discipline
	 * a booking workflow uses for `initialPending`/`suppressReminderOnSilence`. For
	 * changes made AFTER deploy (no new config field possible) the harness uses
	 * `patched()` from `@temporalio/workflow` instead; both seams are demonstrated in
	 * `maybeEmitTurnStart` below.
	 */
	loopFlags?: Record<string, boolean>;
}

/** A model turn is invoked through this proxied activity. The harness does NOT
 *  implement it — a consumer registers a matching `callModel` activity (and the
 *  R-harness tests supply a fake). A long `startToCloseTimeout` because a model turn
 *  is slow and the impl may stream internally over the whole turn; few retries
 *  because the paid call is not retry-idempotent (only the consumer's usage COUNT is
 *  — that's the consumer's idempotency-key concern, not the harness's). */
const { callModel } = proxyActivities<{ callModel: CallModelActivity }>({
	startToCloseTimeout: '10 minutes',
	retry: { maximumAttempts: 2 }
});

/** Activity-backed tools dispatch through this proxy. The activity is named after
 *  the tool (`activities[toolName]`); a consumer registers one activity per
 *  `kind:'activity'` tool. Standard fast-activity timeout + retry. */
const toolActivities = proxyActivities<Record<string, (...args: unknown[]) => Promise<unknown>>>({
	startToCloseTimeout: '1 minute',
	retry: { maximumAttempts: 3 }
});

/** Omit that distributes over a union, preserving each member's discriminant
 *  (`Omit<Union, K>` collapses a union to its common keys). */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

const DEFAULT_MAX_TURNS = 16;
const DEFAULT_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h no-progress bound

/** Concatenate the text blocks of a message — the convenience `text` on the
 *  `assistant_message` event. */
function messageText(message: AgentMessage): string {
	return message.content
		.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
		.map((b) => b.text)
		.join('');
}

/** The model-visible projection of the configured tools — name/description/schema
 *  ONLY. Never the `kind`, the `inherentlySafe` hint, or the injected bag
 *  (Principle 4). This is exactly what is sent to the model each turn. */
function toolSchemasFor(tools: AnyTool[]): ToolSchema[] {
	return tools.map((t) => ({
		name: t.name,
		description: t.description,
		inputSchema: t.inputSchema
	}));
}

export async function agentWorkflow(config: AgentConfig): Promise<AgentState> {
	const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
	const approvalTimeoutMs = config.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
	const toolsByName = new Map(config.tools.map((t) => [t.name, t]));
	const toolSchemas = toolSchemasFor(config.tools);

	// ── Durable workflow state (the system of record while live) ───────────────
	const messages: AgentMessage[] = [];
	const events: AgentEvent[] = [];
	let status: AgentStatus = 'idle';
	let turnSeq = 0;

	// Resolved approvals, keyed strictly to a `toolUseId` (Principle 5): a turn with
	// several pending calls each waits on its OWN id. A denial records its structured
	// reason so the loop can turn it into an error tool_result.
	const approvals = new Map<string, { decision: 'approve' | 'deny'; reason?: string }>();
	// Currently-pending approval ids (so `approveToolUpdate` can ack ok=false for an
	// id that isn't actually awaiting a decision).
	const pendingApprovals = new Set<string>();

	let cancelled = false;
	// Wakes the top-level driver when a new user message arrives.
	let pendingUserSeq = 0;
	let consumedUserSeq = 0;

	const getStatus = (): AgentStatus => status;

	const snapshot = (): AgentState => ({
		conversationId: config.conversationId,
		status,
		messages,
		events,
		turnSeq
	});

	/** Append an event with the next monotonic offset. Offsets are gap-free and
	 *  assigned in append order, so they replay identically and the SSE bridge can
	 *  resume from any `sinceOffset`. `DistributiveOmit` preserves the discriminated
	 *  union (a plain `Omit<Union, 'offset'>` would collapse to the common keys). */
	function emit(event: DistributiveOmit<AgentEvent, 'offset'>): void {
		events.push({ ...event, offset: events.length } as AgentEvent);
	}

	/**
	 * CROSS-VERSION REPLAY SEAM (H5 / risk 1). Emitting the `turn_start` event is a
	 * NEW loop-behavior branch — a command-emitting decision added after the harness's
	 * first release. Deploying it while conversations are in-flight could make replay
	 * non-deterministic (an old history has no `turn_start`; new code would expect
	 * one). It is gated behind `config.loopFlags?.emitTurnStart` — the SAME
	 * input-gating discipline a booking workflow uses for `initialPending` /
	 * `suppressReminderOnSilence`: a workflow STARTED before the flag existed carries
	 * it absent (→ the old path, no event) and replays identically; only workflows
	 * started AFTER the change set it true. Because the gate reads immutable start
	 * `config`, the decision is stable across every replay of a given execution.
	 *
	 * For a change that CANNOT add a new start-config field (e.g. a fix to already-
	 * running executions), the harness's evolution tool is `patched()` /
	 * `deprecatePatch()` from `@temporalio/workflow` (imported above): wrap the new
	 * branch in `if (patched('some-change-id')) { …new… } else { …old… }`, ship,
	 * let pre-patch histories drain, then `deprecatePatch('some-change-id')` and
	 * finally delete the old branch. We do NOT call `patched()` unconditionally here —
	 * that would write a marker into every history and is reserved for an actual
	 * post-deploy change; the flag is the seam exercised by the cross-version test.
	 */
	function maybeEmitTurnStart(seq: number): void {
		if (config.loopFlags?.emitTurnStart === true) emit({ type: 'turn_start', turnSeq: seq });
	}

	setHandler(getStateQuery, snapshot);
	setHandler(getEventsQuery, (sinceOffset: number) =>
		events.filter((e) => e.offset >= sinceOffset)
	);
	setHandler(cancelSignal, () => {
		cancelled = true;
	});

	// A user message is an Update so the client gets an ack. Once the conversation
	// has terminally ended (cancelled / abandoned / max_turns), further input is
	// rejected with accepted=false rather than silently dropped.
	setHandler(userMessageUpdate, (text: string) => {
		if (cancelled || status === 'abandoned' || status === 'max_turns') {
			return { accepted: false };
		}
		messages.push({ role: 'user', content: [{ type: 'text', text }] });
		pendingUserSeq += 1;
		return { accepted: true };
	});

	// Approvals are keyed to a specific toolUseId. We only accept a decision for an
	// id the loop is actually waiting on (pending) and hasn't already resolved — so a
	// stray/duplicate ack returns ok=false and never corrupts state.
	setHandler(approveToolUpdate, (input: ApproveToolInput) => {
		if (!pendingApprovals.has(input.toolUseId) || approvals.has(input.toolUseId)) {
			return { ok: false };
		}
		approvals.set(input.toolUseId, { decision: input.decision, reason: input.reason });
		return { ok: true };
	});

	/**
	 * Run one tool call (already approved). `kind:'inline'` runs deterministically in
	 * the workflow with `(args, injected)`; `kind:'activity'` dispatches to the
	 * proxied activity named after the tool with `(args, injected)`. Returns the
	 * string content for the tool_result block.
	 */
	async function runTool(tool: AnyTool, block: ToolUseBlock): Promise<string> {
		if (tool.kind === 'inline') {
			// `tool.run` does NOT survive workflow-arg serialization (a function can't be
			// JSON), so the deterministic runner is looked up from the workflow-bundle
			// registry the consumer populated via `registerInlineTools` (see
			// inline-registry.ts). A direct in-process caller (e.g. a unit test) may still
			// pass a live `run`, so we honor that as a fallback.
			const run = getInlineRun(tool.name) ?? tool.run;
			if (typeof run !== 'function') {
				throw new Error(
					`Inline tool "${tool.name}" has no registered runner — call registerInlineTools(...) in your workflowsPath module.`
				);
			}
			const out = run(block.input, config.injected);
			return typeof out === 'string' ? out : JSON.stringify(out);
		}
		const out = await toolActivities[tool.name](block.input, config.injected);
		return typeof out === 'string' ? out : JSON.stringify(out);
	}

	/**
	 * Drive one user message to completion: call the model, run any requested tools
	 * (gating per the approval policy), feed results back, loop — until `end_turn`,
	 * cancellation, an abandoned approval, or `maxTurns`. Returns when the turn is
	 * settled; the outer driver then awaits the next user message.
	 */
	async function runTurn(): Promise<void> {
		let modelTurns = 0;
		for (;;) {
			if (cancelled) return;
			if (modelTurns >= maxTurns) {
				// EXHAUSTION is terminal + graceful: emit the event, mark state, end the
				// turn. NOT a thrown error (a runaway loop must not crash the workflow).
				emit({ type: 'max_turns_reached', turnSeq });
				status = 'max_turns';
				return;
			}

			modelTurns += 1;
			turnSeq += 1;
			status = 'thinking';
			maybeEmitTurnStart(turnSeq);

			const result = await callModel({
				system: config.system,
				messages,
				toolSchemas,
				injected: config.injected,
				turnSeq,
				conversationId: config.conversationId,
				// Pass-through only: copy the configured model verbatim so the consumer's
				// activity can route on it. Omitted when unset (replay-safe; old behavior).
				model: config.model
			});

			messages.push(result.message);
			emit({
				type: 'assistant_message',
				turnSeq,
				text: messageText(result.message),
				stopReason: result.stopReason
			});

			if (result.stopReason !== 'tool_use') {
				// end_turn / max_tokens / refusal → the turn is over; await more input.
				status = 'idle';
				return;
			}

			// Collect the requested tool_use blocks (model-visible input only).
			const toolUses = result.message.content.filter(
				(b): b is ToolUseBlock => b.type === 'tool_use'
			);

			// Run each requested tool, gating per the policy. A turn with several tool
			// calls processes them in order; each approval waits on its OWN toolUseId.
			const toolResults: ToolResultBlock[] = [];
			for (const block of toolUses) {
				if (cancelled) return;
				const tool = toolsByName.get(block.name);
				if (!tool) {
					// The model named a tool we don't have — feed back an error result so
					// it can correct, rather than crash the workflow.
					const content = `Unknown tool: ${block.name}`;
					emit({ type: 'tool_start', toolUseId: block.toolUseId, toolName: block.name });
					emit({
						type: 'tool_end',
						toolUseId: block.toolUseId,
						toolName: block.name,
						isError: true
					});
					toolResults.push({
						type: 'tool_result',
						toolUseId: block.toolUseId,
						content,
						isError: true
					});
					continue;
				}

				emit({ type: 'tool_start', toolUseId: block.toolUseId, toolName: block.name });

				const mustApprove = approvalRequired(
					config.approvalPolicy,
					tool.name,
					tool.inherentlySafe ?? false
				);

				if (mustApprove) {
					// Pause IN-WORKFLOW on a `condition()` keyed to THIS toolUseId — no
					// activity timeout burns (Principle 5). The `approval_required` event
					// carries the id + the model-visible input so the UI approves the right
					// pending call. `cancelSignal` escapes; the no-progress timeout abandons
					// a stale approval and ends the turn gracefully (risk 4).
					pendingApprovals.add(block.toolUseId);
					status = 'awaiting_approval';
					emit({
						type: 'approval_required',
						toolUseId: block.toolUseId,
						toolName: tool.name,
						input: block.input
					});
					const resolved = await condition(
						() => approvals.has(block.toolUseId) || cancelled,
						approvalTimeoutMs
					);
					pendingApprovals.delete(block.toolUseId);
					if (cancelled) return;
					if (!resolved) {
						// Abandoned — no decision within the no-progress window. End gracefully.
						status = 'abandoned';
						return;
					}
					status = 'thinking';

					const decision = approvals.get(block.toolUseId)!;
					if (decision.decision === 'deny') {
						// DENY → the structured `reason` becomes an ERROR tool_result fed into
						// the NEXT model turn so the model can RE-PROPOSE (not halt). This is
						// the deny-with-reason loop (Principle 5).
						//
						// EVOLUTION-TOOL DEMONSTRATION (H5): the fallback wording when a deny
						// carries no reason was improved post-release. Because this string is fed
						// back to the model (a command-affecting decision), the change is gated
						// with `patched()` so an in-flight execution's replayed history takes the
						// OLD wording while new executions take the new one; once pre-patch
						// histories drain, a consumer calls
						// `deprecatePatch('agent-deny-default-msg')` and deletes the old branch.
						// (This is the `patched()`/`deprecatePatch()` evolution tool the plan
						// requires; together with the flag seam above these are the two
						// disciplines for any loop-behavior change.)
						const defaultDenyMsg = patched('agent-deny-default-msg')
							? 'The user declined this action and gave no reason. Propose an alternative.'
							: 'The user declined this action.';
						const content = decision.reason ?? defaultDenyMsg;
						emit({
							type: 'tool_end',
							toolUseId: block.toolUseId,
							toolName: tool.name,
							isError: true
						});
						toolResults.push({
							type: 'tool_result',
							toolUseId: block.toolUseId,
							content,
							isError: true
						});
						continue;
					}
					// approve → fall through and run the tool.
				}

				// Run the tool (inline in-workflow, or activity-backed). A thrown error
				// becomes an error tool_result so the model can react, not a crash.
				try {
					const content = await runTool(tool, block);
					emit({
						type: 'tool_end',
						toolUseId: block.toolUseId,
						toolName: tool.name,
						isError: false
					});
					toolResults.push({ type: 'tool_result', toolUseId: block.toolUseId, content });
				} catch (err) {
					const content = err instanceof Error ? err.message : String(err);
					emit({
						type: 'tool_end',
						toolUseId: block.toolUseId,
						toolName: tool.name,
						isError: true
					});
					toolResults.push({
						type: 'tool_result',
						toolUseId: block.toolUseId,
						content,
						isError: true
					});
				}
			}

			if (cancelled) return;
			// Feed all tool results back as one `tool`-role message, then loop to the
			// model again (the classic manual tool-use loop).
			messages.push({ role: 'tool', content: toolResults });
		}
	}

	// ── Driver: process each user message, then await the next ──────────────────
	// The conversation is long-lived: it runs turns as user messages arrive and
	// parks on a `condition()` between them. `cancelSignal` ends it; a terminal turn
	// outcome (abandoned / max_turns) also ends it.
	for (;;) {
		if (cancelled) {
			status = 'cancelled';
			break;
		}
		if (pendingUserSeq !== consumedUserSeq) {
			consumedUserSeq = pendingUserSeq;
			await runTurn();
			// `runTurn` mutates `status` through the closure; `getStatus()` reads the live
			// value so control-flow analysis can't narrow it to the pre-call literal.
			const settled = getStatus();
			if (settled === 'abandoned' || settled === 'max_turns') break;
			continue;
		}
		// Idle — wait for the next user message or a cancel.
		await condition(() => pendingUserSeq !== consumedUserSeq || cancelled);
	}

	return snapshot();
}
