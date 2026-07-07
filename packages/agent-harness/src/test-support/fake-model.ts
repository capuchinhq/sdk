// ── Test-support: a scripted FAKE model activity ─────────────────────────────
// The R-harness tests register THIS as the `callModel` activity (the harness ships
// no real model). It returns canned `tool_use`/`end_turn` results from a script and
// records every `CallModelInput` it was called with, so a test can assert what the
// model saw (e.g. injected fields absent from tool schemas + system prompt, deny
// reasons arriving on the next turn). This module is NOT part of the published
// surface (excluded from the build); it is test scaffolding only.

import type {
	AgentMessage,
	CallModelInput,
	CallModelResult,
	StopReason,
	ToolUseBlock
} from '../activities-contract/index.js';

/** One scripted model turn: either a function of the input (so a step can react to
 *  what the model saw — e.g. the deny reason) or a static result. */
export type ScriptStep = CallModelResult | ((input: CallModelInput) => CallModelResult);

/** A recording fake `callModel`. `calls` captures every input in order; `script`
 *  is consumed one step per turn (the last step repeats if the loop overruns, which
 *  keeps a misbehaving test from hanging on an empty script). */
export interface FakeModel {
	callModel: (input: CallModelInput) => Promise<CallModelResult>;
	calls: CallModelInput[];
}

/** Build an assistant message with a single text block. */
export function assistantText(text: string): AgentMessage {
	return { role: 'assistant', content: [{ type: 'text', text }] };
}

/** Build an assistant message requesting one or more tool calls (optionally with
 *  leading text). Each tool use gets a deterministic toolUseId unless supplied. */
export function assistantToolUse(
	toolUses: Array<{ toolUseId?: string; name: string; input?: Record<string, unknown> }>,
	leadingText?: string
): AgentMessage {
	const blocks: AgentMessage['content'] = [];
	if (leadingText) blocks.push({ type: 'text', text: leadingText });
	toolUses.forEach((t, i) => {
		const block: ToolUseBlock = {
			type: 'tool_use',
			toolUseId: t.toolUseId ?? `tu-${i + 1}`,
			name: t.name,
			input: t.input ?? {}
		};
		blocks.push(block);
	});
	return { role: 'assistant', content: blocks };
}

/** A `CallModelResult` whose message ends the turn. */
export function endTurn(text: string): CallModelResult {
	return {
		message: assistantText(text),
		stopReason: 'end_turn',
		tokenUsage: { input: 10, output: 10 }
	};
}

/** A `CallModelResult` requesting tools (stopReason 'tool_use'). */
export function toolUse(
	toolUses: Array<{ toolUseId?: string; name: string; input?: Record<string, unknown> }>,
	leadingText?: string,
	stopReason: StopReason = 'tool_use'
): CallModelResult {
	return {
		message: assistantToolUse(toolUses, leadingText),
		stopReason,
		tokenUsage: { input: 10, output: 10 }
	};
}

/** Build a recording fake from an ordered script. */
export function makeFakeModel(script: ScriptStep[]): FakeModel {
	const calls: CallModelInput[] = [];
	let i = 0;
	return {
		calls,
		callModel: async (input: CallModelInput): Promise<CallModelResult> => {
			calls.push(structuredClone(input));
			const step = script[Math.min(i, script.length - 1)];
			i += 1;
			return typeof step === 'function' ? step(input) : step;
		}
	};
}
