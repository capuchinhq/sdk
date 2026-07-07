import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { WorkflowHandle } from '@temporalio/client';
import type { AgentConfig, ApproveToolInput } from './workflow/index.js';
import type { AgentState } from './activities-contract/index.js';
import { endTurn, makeFakeModel, toolUse, type ScriptStep } from './test-support/fake-model.js';

/**
 * Replay coverage — the durability + cross-version replay gates (distinct claims).
 *
 *  - DURABILITY replay: run a conversation to completion, fetch its history, then
 *    `Worker.runReplayHistory` it against the BUILT `./workflow` bundle. A clean
 *    replay (no non-determinism error) proves the workflow's state derivation is
 *    deterministic — i.e. a worker restart mid-conversation resumes to the identical
 *    state. We also re-derive the final `AgentState` from a fresh query post-replay
 *    isn't possible (the replay env has no live mutable handle), so the gate is the
 *    no-throw replay itself, the SDK's own determinism check.
 *
 *  - CROSS-VERSION replay (H5 / risk 1): the `turn_start` event is a loop-behavior
 *    branch gated behind `config.loopFlags.emitTurnStart`. A history recorded with
 *    the flag ABSENT (the "pre-change" execution) is replayed against the CURRENT
 *    code (which contains the new branch). Because the gate reads immutable start
 *    config, the flag-absent history takes the OLD path on replay and does NOT emit
 *    the new event — so replay is determinism-clean. This is distinct from durability
 *    replay: it proves a NEW behavior shipped behind the seam can't break an old
 *    in-flight conversation.
 */

const workflowsPath = fileURLToPath(new URL('../dist/workflow/index.js', import.meta.url));

const UPDATE_USER_MESSAGE = 'userMessage';
const UPDATE_APPROVE_TOOL = 'approveTool';
const SIGNAL_CANCEL = 'cancel';
const QUERY_GET_STATE = 'getState';

let env: TestWorkflowEnvironment;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
}, 120_000);

afterAll(async () => {
	await env?.teardown();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ActivityFn = (...args: any[]) => Promise<unknown>;

async function withWorker<T>(
	taskQueue: string,
	activities: Record<string, ActivityFn>,
	fn: (taskQueue: string) => Promise<T>
): Promise<T> {
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowsPath,
		activities
	});
	return worker.runUntil(fn(taskQueue));
}

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		system: 'You are a helpful assistant.',
		tools: [],
		approvalPolicy: { type: 'auto' },
		injected: {},
		conversationId: overrides.conversationId ?? 'conv-replay',
		...overrides
	};
}

const sendMessage = (h: WorkflowHandle, text: string) =>
	h.executeUpdate(UPDATE_USER_MESSAGE, { args: [text] });
const approveTool = (h: WorkflowHandle, input: ApproveToolInput) =>
	h.executeUpdate(UPDATE_APPROVE_TOOL, { args: [input] });
const getState = (h: WorkflowHandle): Promise<AgentState> => h.query(QUERY_GET_STATE);

async function waitFor(
	h: WorkflowHandle,
	pred: (s: AgentState) => boolean,
	tries = 200
): Promise<AgentState> {
	for (let i = 0; i < tries; i += 1) {
		const s = await getState(h);
		if (pred(s)) return s;
		await env.sleep(50);
	}
	return getState(h);
}

describe('agentWorkflow replay (durability + cross-version)', () => {
	it('durability: a multi-turn + approval conversation replays its history identically', async () => {
		// A non-trivial history: a gated tool turn (model→approval→tool→model→end).
		const script: ScriptStep[] = [
			toolUse([{ toolUseId: 'tu-r', name: 'act', input: { n: 7 } }]),
			endTurn('All done')
		];
		const fake = makeFakeModel(script);
		const config = baseConfig({
			conversationId: 'conv-dur',
			approvalPolicy: { type: 'all' },
			tools: [{ name: 'act', description: 'x', inputSchema: {}, kind: 'activity' }]
		});

		const wfId = 'replay-dur';
		await withWorker(
			'rp-dur',
			{ callModel: fake.callModel, act: async () => 'ok' },
			async (taskQueue) => {
				const h = await env.client.workflow.start('agentWorkflow', {
					taskQueue,
					workflowId: wfId,
					args: [config]
				});
				await sendMessage(h, 'do it');
				await waitFor(h, (st) => st.status === 'awaiting_approval');
				await approveTool(h, { toolUseId: 'tu-r', decision: 'approve' });
				await waitFor(h, (st) => st.status === 'idle' && st.turnSeq >= 2);
				await h.signal(SIGNAL_CANCEL);
				await h.result();
			}
		);

		// Fetch the recorded history and replay it against the built bundle. A
		// non-determinism break (a purity leak, a non-deterministic decision) throws.
		const handle = env.client.workflow.getHandle(wfId);
		const history = await handle.fetchHistory();
		await Worker.runReplayHistory({ workflowsPath }, history);
		// Reaching here = the SDK's determinism check passed on every event.
		expect(history.events && history.events.length).toBeGreaterThan(0);
	});

	it('cross-version: a flag-absent (pre-change) history replays clean against new-branch code', async () => {
		// Record a history with `loopFlags.emitTurnStart` ABSENT → the OLD path (no
		// turn_start event). This stands in for a conversation started before the
		// turn_start branch shipped.
		const fake = makeFakeModel([endTurn('hi')]);
		const config = baseConfig({ conversationId: 'conv-xv' }); // no loopFlags
		const wfId = 'replay-xv';
		let recorded: AgentState | undefined;
		await withWorker('rp-xv', { callModel: fake.callModel }, async (taskQueue) => {
			const h = await env.client.workflow.start('agentWorkflow', {
				taskQueue,
				workflowId: wfId,
				args: [config]
			});
			await sendMessage(h, 'hi');
			recorded = await waitFor(h, (st) => st.status === 'idle' && st.turnSeq >= 1);
			await h.signal(SIGNAL_CANCEL);
			await h.result();
		});

		// The pre-change execution took the OLD path: NO turn_start event.
		expect(recorded?.events.some((e) => e.type === 'turn_start')).toBe(false);

		// Replay that flag-absent history against the CURRENT code (which contains the
		// new, flag-gated turn_start branch). Because the gate reads immutable start
		// config (flag absent → old path), the new branch is never taken on replay, so
		// there is no non-determinism. A throw here would mean the seam failed.
		const handle = env.client.workflow.getHandle(wfId);
		const history = await handle.fetchHistory();
		await Worker.runReplayHistory({ workflowsPath }, history);
		expect(history.events && history.events.length).toBeGreaterThan(0);
	});

	it('cross-version: a flag-PRESENT (new) execution emits the new branch and also replays clean', async () => {
		// The complement: a NEW execution (flag set) takes the new path AND replays
		// deterministically — proving the seam is correct in both directions.
		const fake = makeFakeModel([endTurn('hi')]);
		const config = baseConfig({
			conversationId: 'conv-xv2',
			loopFlags: { emitTurnStart: true }
		});
		const wfId = 'replay-xv2';
		let recorded: AgentState | undefined;
		await withWorker('rp-xv2', { callModel: fake.callModel }, async (taskQueue) => {
			const h = await env.client.workflow.start('agentWorkflow', {
				taskQueue,
				workflowId: wfId,
				args: [config]
			});
			await sendMessage(h, 'hi');
			recorded = await waitFor(h, (st) => st.status === 'idle' && st.turnSeq >= 1);
			await h.signal(SIGNAL_CANCEL);
			await h.result();
		});

		// New path: the turn_start event IS present.
		expect(recorded?.events.some((e) => e.type === 'turn_start')).toBe(true);

		const handle = env.client.workflow.getHandle(wfId);
		const history = await handle.fetchHistory();
		await Worker.runReplayHistory({ workflowsPath }, history);
		expect(history.events && history.events.length).toBeGreaterThan(0);
	});
});
