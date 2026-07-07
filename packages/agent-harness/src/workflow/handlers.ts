// ── Workflow handler definitions ─────────────────────────────────────────────
// The signal/update/query channels the stateless client drives the agent through,
// built with `defineUpdate`/`defineSignal`/`defineQuery` (the same primitives a
// long-lived entity workflow uses for its reschedule/cancel/getState surface).
// Updates return an ack so the client knows the message landed; signals are
// fire-and-forget; queries are read-only projections of workflow state.

import { defineSignal, defineUpdate, defineQuery } from '@temporalio/workflow';
// The handler-definition return types (`UpdateDefinition`/`SignalDefinition`/
// `QueryDefinition`) live in `@temporalio/common` and are NOT re-exported from
// `@temporalio/workflow`; declaration emit (`declaration: true`) needs them named
// explicitly or TS can't write a portable `.d.ts` (TS2883). We pull them as a
// type-only import — no runtime edge is added (this file already imports the
// `define*` VALUES from `@temporalio/workflow`, which itself re-exports them from
// common, so the workflow bundle is unaffected).
import type { UpdateDefinition, SignalDefinition, QueryDefinition } from '@temporalio/common';
import type { AgentEvent, AgentState } from '../activities-contract/index.js';

/** The stateless client's approve/deny payload for a pending tool call. Keyed to a
 *  SPECIFIC `toolUseId` so a turn with several pending calls resolves the right one
 *  (Principle 5). A DENY may carry a structured `reason` that becomes the tool's
 *  error tool_result on the next model turn (the deny-with-reason re-propose loop). */
export interface ApproveToolInput {
	toolUseId: string;
	decision: 'approve' | 'deny';
	reason?: string;
}

/** Ack returned by `userMessageUpdate`. `accepted` is false if the conversation has
 *  already ended (cancelled / abandoned / max-turns) and can't take more input. */
export interface UserMessageResult {
	accepted: boolean;
}

/** Ack returned by `approveToolUpdate`. `ok` is false if the `toolUseId` isn't a
 *  currently-pending approval (already resolved, unknown, or never gated). */
export interface ApproveToolResult {
	ok: boolean;
}

/** The stateless client sends a user message; the workflow appends it and wakes the
 *  turn loop. An Update (not a signal) so the client gets an ack. */
export const userMessageUpdate: UpdateDefinition<UserMessageResult, [string]> = defineUpdate<
	UserMessageResult,
	[string]
>('userMessage');

/** Resolve a pending tool approval, keyed to a specific `toolUseId`. */
export const approveToolUpdate: UpdateDefinition<ApproveToolResult, [ApproveToolInput]> =
	defineUpdate<ApproveToolResult, [ApproveToolInput]>('approveTool');

/** End the conversation — escapes any pending approval `condition()` cleanly. */
export const cancelSignal: SignalDefinition<[]> = defineSignal('cancel');

/** Read the current lifecycle state (the full serializable `AgentState`). */
export const getStateQuery: QueryDefinition<AgentState, []> = defineQuery<AgentState>('getState');

/** Resumable event stream: returns the event-log tail with `offset >= sinceOffset`.
 *  The SSE bridge polls this and re-emits; a dropped+reopened connection resumes
 *  from its last offset with no missed/duplicate events. */
export const getEventsQuery: QueryDefinition<AgentEvent[], [number]> = defineQuery<
	AgentEvent[],
	[number]
>('getEvents');
