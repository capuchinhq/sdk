// ── Model-call activity contract ─────────────────────────────────────────────
// The harness DEFINES this interface; a consumer IMPLEMENTS it with its own LLM
// SDK and registers a matching activity on the worker. The workflow proxies it as
// `callModel` and the manual tool-use loop runs across durable model + tool
// activities. The harness ships no SDK, no key handling, no I/O — only the shape.

import type { AgentMessage } from './messages.js';
import type { InjectedParams, ToolSchema } from './tools.js';

/** Input to one model turn. `injected` is forwarded to the impl so it can scope
 *  metering/auth by tenant — it is NOT part of any `toolSchemas[].inputSchema` and
 *  the impl must never render it into the model-visible `system`/`messages`
 *  (Principle 4). `turnSeq` is the monotonic turn counter the impl uses to build an
 *  idempotency key (so a Temporal retry counts a usage event once). */
export interface CallModelInput {
	system: string;
	messages: AgentMessage[];
	toolSchemas: ToolSchema[];
	injected: InjectedParams;
	turnSeq: number;
	conversationId: string;
	/** The model this agent runs on, copied verbatim from `AgentConfig.model` by the
	 *  workflow. The harness never interprets it — the consumer's `CallModelActivity`
	 *  reads it and maps it to its own LLM SDK (and supplies a default when absent).
	 *  Optional and deterministic: an in-flight workflow started before this field
	 *  existed sends it absent and replays identically (the consumer falls back to its
	 *  own default), so it's replay-safe. */
	model?: string;
}

/** Why the model stopped this turn. `tool_use` → the workflow runs the requested
 *  tools and calls the model again; `end_turn` → the workflow awaits the next user
 *  message; `max_tokens`/`refusal` → terminal for the turn. */
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';

/** Result of one model turn. The activity returns ONCE with the authoritative final
 *  message (the impl may stream internally to assemble it — Principle 3 — but the
 *  workflow boundary is non-streaming). `tokenUsage` lets the consumer record usage
 *  events; the harness never inspects it. */
export interface CallModelResult {
	message: AgentMessage;
	stopReason: StopReason;
	tokenUsage: { input: number; output: number };
}

/** The model-call activity CONTRACT. A consumer implements this. */
export type CallModelActivity = (input: CallModelInput) => Promise<CallModelResult>;
