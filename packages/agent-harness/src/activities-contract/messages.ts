// ── Transcript shape ─────────────────────────────────────────────────────────
// Serializable conversation entries. These cross the workflow↔activity boundary
// (they ride in `CallModelInput` / `CallModelResult` and live in workflow state),
// so every field MUST be plain JSON — no class instances, no Dates, no functions.
// The shape is deliberately model-vendor-neutral: a text block, a tool_use block
// (the model asks to run a tool), and a tool_result block (the workflow's answer).
// A consumer's `CallModelActivity` maps these to/from its concrete SDK's types.

/** A model-authored or workflow-authored span of plain text. */
export interface TextBlock {
	type: 'text';
	text: string;
}

/**
 * The model's request to run a tool. `toolUseId` is the model-assigned correlation
 * id; the workflow keys approvals and tool_results to it (Principle 5 — approvals
 * are keyed to a SPECIFIC toolUseId so multiple pending calls in one turn each wait
 * on their own id). `input` is the model-visible arguments only — it NEVER carries
 * injected params (Principle 4).
 */
export interface ToolUseBlock {
	type: 'tool_use';
	toolUseId: string;
	name: string;
	input: Record<string, unknown>;
}

/**
 * The workflow's answer to a `tool_use`, fed back into the next model turn. On a
 * DENY, `content` carries the structured deny `reason` and `isError` is true so the
 * model can re-propose rather than halt (Principle 5, the deny-with-reason loop).
 */
export interface ToolResultBlock {
	type: 'tool_result';
	toolUseId: string;
	content: string;
	isError?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

/** Who authored a transcript entry. `tool` entries carry tool_result blocks. */
export type MessageRole = 'user' | 'assistant' | 'tool';

/** One serializable transcript entry (role + content blocks). */
export interface AgentMessage {
	role: MessageRole;
	content: ContentBlock[];
}

/** Narrowing helpers — handy in both workflow and consumer code, value-safe. */
export function isToolUseBlock(b: ContentBlock): b is ToolUseBlock {
	return b.type === 'tool_use';
}
export function isTextBlock(b: ContentBlock): b is TextBlock {
	return b.type === 'text';
}
