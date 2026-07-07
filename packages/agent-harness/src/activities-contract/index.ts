// ── @simiancreative/agent-harness/activities-contract ────────────────────────
// TYPES + pure evaluators only. Safe to import from BOTH the workflow bundle and a
// consumer's activity code. Contains ZERO runtime dependency on `@temporalio/*` or
// any SDK — the only value exports are pure, deterministic helpers (block-narrowing
// and the approval evaluator), so importing this never drags I/O into either side.

export type {
	TextBlock,
	ToolUseBlock,
	ToolResultBlock,
	ContentBlock,
	MessageRole,
	AgentMessage
} from './messages.js';
export { isToolUseBlock, isTextBlock } from './messages.js';

export type { InjectedParams, AgentTool, InlineTool, AnyTool, ToolSchema } from './tools.js';

export type { ToolApprovalPolicy } from './approval.js';
export { approvalRequired } from './approval.js';

export type { CallModelInput, CallModelResult, CallModelActivity, StopReason } from './model.js';

export type {
	AgentEventType,
	TurnStartEvent,
	AssistantMessageEvent,
	ToolStartEvent,
	ToolEndEvent,
	ApprovalRequiredEvent,
	MaxTurnsReachedEvent,
	AgentEvent,
	AgentStatus,
	AgentState
} from './events.js';
