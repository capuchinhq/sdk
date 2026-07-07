// ── Event log + agent state ──────────────────────────────────────────────────
// The agent loop appends `AgentEvent`s to workflow state as it progresses; a
// `getEventsQuery(sinceOffset)` returns the tail past a resumable offset, and a
// server-layer SSE bridge polls + re-emits them (Principle 6 / AQ-STREAM). There is
// deliberately NO `text_delta` event — token deltas are a server-side concern, out
// of scope for the workflow. Every event carries a monotonic `offset`.

import type { AgentMessage } from './messages.js';

/** Discriminant tags for the event union. */
export type AgentEventType =
	| 'turn_start'
	| 'assistant_message'
	| 'tool_start'
	| 'tool_end'
	| 'approval_required'
	| 'max_turns_reached';

interface BaseEvent {
	/** Monotonic, gap-free sequence number (0-based) — the resume cursor for the
	 *  events query. Assigned in append order; replays identically. */
	offset: number;
	type: AgentEventType;
}

/** A model turn is beginning. `turnSeq` mirrors the model-call's turn counter. */
export interface TurnStartEvent extends BaseEvent {
	type: 'turn_start';
	turnSeq: number;
}

/** The model returned a (possibly tool-requesting) assistant message. `text` is the
 *  concatenated text blocks for convenience; `stopReason` mirrors the model result. */
export interface AssistantMessageEvent extends BaseEvent {
	type: 'assistant_message';
	turnSeq: number;
	text: string;
	stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';
}

/** A tool call is about to run (after any approval cleared). */
export interface ToolStartEvent extends BaseEvent {
	type: 'tool_start';
	toolUseId: string;
	toolName: string;
}

/** A tool call finished. `isError` true when the result is an error (incl. a deny
 *  that became an error tool_result fed back to the model). */
export interface ToolEndEvent extends BaseEvent {
	type: 'tool_end';
	toolUseId: string;
	toolName: string;
	isError: boolean;
}

/** A tool call is paused awaiting a human approve/deny. Carries the SPECIFIC
 *  `toolUseId` so the UI approves the right pending call when a turn has several,
 *  plus the model-visible `input` so the human can judge the call. */
export interface ApprovalRequiredEvent extends BaseEvent {
	type: 'approval_required';
	toolUseId: string;
	toolName: string;
	input: Record<string, unknown>;
}

/** The `maxTurns` safety bound was reached; the turn ends gracefully (not an error). */
export interface MaxTurnsReachedEvent extends BaseEvent {
	type: 'max_turns_reached';
	turnSeq: number;
}

export type AgentEvent =
	| TurnStartEvent
	| AssistantMessageEvent
	| ToolStartEvent
	| ToolEndEvent
	| ApprovalRequiredEvent
	| MaxTurnsReachedEvent;

/** The lifecycle phase the workflow is in — surfaced by `getStateQuery`. */
export type AgentStatus =
	/** Idle, awaiting the next user message. */
	| 'idle'
	/** A model turn is in flight (model call or tool run). */
	| 'thinking'
	/** Paused on at least one pending tool approval. */
	| 'awaiting_approval'
	/** The conversation was cancelled via `cancelSignal`. */
	| 'cancelled'
	/** A pending approval was abandoned past `approvalTimeoutMs`; ended gracefully. */
	| 'abandoned'
	/** `maxTurns` was reached on the active turn; ended gracefully. */
	| 'max_turns';

/** The full, serializable agent state — the workflow return value AND the
 *  `getStateQuery` payload. The transcript is the system of record while live. */
export interface AgentState {
	conversationId: string;
	status: AgentStatus;
	/** The full conversation transcript (user/assistant/tool messages). */
	messages: AgentMessage[];
	/** The offset-keyed event log (the SSE feed source). */
	events: AgentEvent[];
	/** Turn counter — how many model calls have been issued. */
	turnSeq: number;
}
