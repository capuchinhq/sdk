import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { WorkflowHandle } from '@temporalio/client';
import type {
	AgentConfig,
	ApproveToolInput,
	ApproveToolResult,
	UserMessageResult
} from './workflow/index.js';
import type { AgentEvent, AgentState, CallModelResult } from './activities-contract/index.js';
import { endTurn, makeFakeModel, toolUse, type ScriptStep } from './test-support/fake-model.js';

/**
 * R-harness acceptance suite. We register `agentWorkflow` via `workflowsPath`
 * pointing at the BUILT `./workflow` artifact (dist/workflow/index.js) — NOT raw TS.
 * This is the determinism gate: the SDK webpack-bundles the built artifact at worker
 * boot, so a build-step purity leak (a node-builtin or SDK import dragged into the
 * workflow bundle, or a value import across the type-only contract edge) fails HERE.
 * `callModel` activity is a scripted FAKE; no real model, no product code.
 */

// The built artifact (proven import-clean by the package build + the boundary lint).
const workflowsPath = fileURLToPath(new URL('../dist/workflow/index.js', import.meta.url));

// A consumer-shaped `workflowsPath` fixture: re-exports `agentWorkflow` AND registers
// inline-tool runners at module load (a function can't ride in a JSON workflow arg —
// inline runners live IN the bundle). Inline-tool scenarios bundle THIS instead.
const inlineWorkflowsPath = fileURLToPath(
	new URL('../dist/test-support/test-workflows.js', import.meta.url)
);

// Update/signal/query names — must match the `define*` calls in workflow/handlers.ts.
const UPDATE_USER_MESSAGE = 'userMessage';
const UPDATE_APPROVE_TOOL = 'approveTool';
const SIGNAL_CANCEL = 'cancel';
const QUERY_GET_STATE = 'getState';
const QUERY_GET_EVENTS = 'getEvents';

// The fake model + any tool activities a scenario registers. Activity impls take
// concretely-typed args, so the value type is intentionally loose (any async fn) to
// avoid parameter-contravariance friction at the registration site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ActivityFn = (...args: any[]) => Promise<unknown>;
interface ScriptedActivities {
	callModel: ActivityFn;
	[k: string]: ActivityFn;
}

let env: TestWorkflowEnvironment;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
}, 120_000);

afterAll(async () => {
	await env?.teardown();
});

/** Run `fn` against a fresh worker on its own task queue (so parallel scenarios
 *  never collide on a worker registration), with the supplied activities. */
async function withWorker<T>(
	taskQueue: string,
	activities: ScriptedActivities,
	fn: (taskQueue: string) => Promise<T>,
	bundlePath: string = workflowsPath
): Promise<T> {
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowsPath: bundlePath,
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
		conversationId: overrides.conversationId ?? 'conv-1',
		...overrides
	};
}

async function startAgent(taskQueue: string, workflowId: string, config: AgentConfig) {
	return env.client.workflow.start('agentWorkflow', {
		taskQueue,
		workflowId,
		args: [config]
	});
}

const sendMessage = (h: WorkflowHandle, text: string): Promise<UserMessageResult> =>
	h.executeUpdate<UserMessageResult, [string]>(UPDATE_USER_MESSAGE, { args: [text] });

const approveTool = (h: WorkflowHandle, input: ApproveToolInput): Promise<ApproveToolResult> =>
	h.executeUpdate<ApproveToolResult, [ApproveToolInput]>(UPDATE_APPROVE_TOOL, { args: [input] });

const getEvents = (h: WorkflowHandle, since = 0): Promise<AgentEvent[]> =>
	h.query<AgentEvent[], [number]>(QUERY_GET_EVENTS, since);

const getState = (h: WorkflowHandle): Promise<AgentState> => h.query<AgentState>(QUERY_GET_STATE);

/** Assert event offsets are gap-free and strictly monotonic (0,1,2,…). */
function assertMonotonicOffsets(events: AgentEvent[]): void {
	events.forEach((e, i) => expect(e.offset).toBe(i));
}

/** Poll the state query until `pred` holds (time-skipping advances on its own; this
 *  just lets us wait for an async turn to settle without sleeping wall-clock). */
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

describe('agentWorkflow (R-harness acceptance, built ./workflow artifact)', () => {
	// (a) plain text turn ─────────────────────────────────────────────────────
	it('(a) runs a plain text turn and ends idle', async () => {
		const fake = makeFakeModel([endTurn('Hello there.')]);
		await withWorker('ah-a', { callModel: fake.callModel }, async (taskQueue) => {
			const h = await startAgent(taskQueue, 'ah-a', baseConfig());
			const ack = await sendMessage(h, 'Hi');
			expect(ack.accepted).toBe(true);
			const s = await waitFor(h, (st) => st.status === 'idle' && st.turnSeq >= 1);
			expect(s.status).toBe('idle');
			expect(s.messages.at(-1)?.role).toBe('assistant');
			const events = await getEvents(h);
			expect(events.map((e) => e.type)).toContain('assistant_message');
			assertMonotonicOffsets(events);
			await h.signal(SIGNAL_CANCEL);
			await h.result();
		});
	});

	// (b) auto-approved tool turn ───────────────────────────────────────────────
	it('(b) runs an auto-approved tool turn (inline tool) without pausing', async () => {
		// Turn 1: model asks to run `echo`; turn 2: model ends with the result.
		const script: ScriptStep[] = [
			toolUse([{ name: 'echo', input: { value: 'hi' } }]),
			endTurn('Done: hi')
		];
		const fake = makeFakeModel(script);
		const config = baseConfig({
			conversationId: 'conv-b',
			approvalPolicy: { type: 'auto' },
			tools: [
				{
					name: 'echo',
					description: 'Echo a value',
					inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
					kind: 'inline',
					run: (args: { value: string }) => `echoed:${args.value}`
				}
			]
		});
		await withWorker(
			'ah-b',
			{ callModel: fake.callModel },
			async (taskQueue) => {
				const h = await startAgent(taskQueue, 'ah-b', config);
				await sendMessage(h, 'echo hi');
				const s = await waitFor(h, (st) => st.status === 'idle' && st.turnSeq >= 2);
				const events = await getEvents(h);
				const types = events.map((e) => e.type);
				expect(types).toContain('tool_start');
				expect(types).toContain('tool_end');
				// No approval was required under the `auto` policy.
				expect(types).not.toContain('approval_required');
				// The tool_result was fed back: a `tool`-role message exists with the echo.
				const toolMsg = s.messages.find((m) => m.role === 'tool');
				expect(JSON.stringify(toolMsg)).toContain('echoed:hi');
				assertMonotonicOffsets(events);
				await h.signal(SIGNAL_CANCEL);
				await h.result();
			},
			inlineWorkflowsPath
		);
	});

	// (c) policy that PAUSES until approveToolUpdate arrives, then proceeds ──────
	it('(c) `all` policy pauses at condition() until approval, then runs the tool', async () => {
		const script: ScriptStep[] = [
			toolUse([{ toolUseId: 'tu-x', name: 'act', input: { n: 1 } }]),
			endTurn('Finished')
		];
		const fake = makeFakeModel(script);
		const ran: number[] = [];
		const config = baseConfig({
			conversationId: 'conv-c',
			approvalPolicy: { type: 'all' },
			tools: [
				{
					name: 'act',
					description: 'A gated action',
					inputSchema: { type: 'object', properties: { n: { type: 'number' } } },
					kind: 'activity'
				}
			]
		});
		const activities: ScriptedActivities = {
			callModel: fake.callModel,
			act: async (args: { n: number }) => {
				ran.push(args.n);
				return `ran:${args.n}`;
			}
		};
		await withWorker('ah-c', activities, async (taskQueue) => {
			const h = await startAgent(taskQueue, 'ah-c', config);
			await sendMessage(h, 'do it');
			// Pauses awaiting approval; the activity must NOT have run yet.
			const paused = await waitFor(h, (st) => st.status === 'awaiting_approval');
			expect(paused.status).toBe('awaiting_approval');
			expect(ran).toEqual([]);
			const reqEvent = paused.events.find((e) => e.type === 'approval_required');
			expect(reqEvent).toBeTruthy();
			expect(reqEvent && 'toolUseId' in reqEvent && reqEvent.toolUseId).toBe('tu-x');
			// Approve → the tool runs and the turn finishes.
			const ack = await approveTool(h, { toolUseId: 'tu-x', decision: 'approve' });
			expect(ack.ok).toBe(true);
			const done = await waitFor(h, (st) => st.status === 'idle' && st.turnSeq >= 2);
			expect(ran).toEqual([1]);
			assertMonotonicOffsets(done.events);
			await h.signal(SIGNAL_CANCEL);
			await h.result();
		});
	});

	// (d) DENY-WITH-REASON → reason reaches the next model turn → re-propose ─────
	it('(d) deny-with-reason flows the reason into the next CallModelInput (re-propose)', async () => {
		// Turn 1: propose `book` (gated, denied). Turn 2: the fake asserts it SAW the
		// deny reason as a tool_result, then proposes again. Turn 3: ends.
		let sawReasonOnTurn2 = false;
		const script: ScriptStep[] = [
			toolUse([{ toolUseId: 'tu-deny', name: 'book', input: { slot: 'A' } }]),
			(input): CallModelResult => {
				// The previous turn's tool_result (the deny reason) must be in messages.
				const flat = JSON.stringify(input.messages);
				if (flat.includes('client prefers mornings')) sawReasonOnTurn2 = true;
				return toolUse([{ toolUseId: 'tu-2', name: 'book', input: { slot: 'B' } }]);
			},
			endTurn('Booked B')
		];
		const fake = makeFakeModel(script);
		const config = baseConfig({
			conversationId: 'conv-d',
			approvalPolicy: { type: 'denylist', alwaysAsk: ['book'] },
			tools: [
				{
					name: 'book',
					description: 'Book a slot',
					inputSchema: { type: 'object', properties: { slot: { type: 'string' } } },
					inherentlySafe: false,
					kind: 'activity'
				}
			]
		});
		const activities: ScriptedActivities = {
			callModel: fake.callModel,
			book: async (args: { slot: string }) => `booked:${args.slot}`
		};
		await withWorker('ah-d', activities, async (taskQueue) => {
			const h = await startAgent(taskQueue, 'ah-d', config);
			await sendMessage(h, 'book me a slot');
			await waitFor(h, (st) => st.status === 'awaiting_approval');
			// Deny the first proposal WITH a structured reason.
			await approveTool(h, {
				toolUseId: 'tu-deny',
				decision: 'deny',
				reason: 'client prefers mornings'
			});
			// The model re-proposes (slot B), which is gated again — approve it.
			await waitFor(
				h,
				(st) =>
					st.status === 'awaiting_approval' &&
					st.events.some((e) => e.type === 'approval_required' && e.toolUseId === 'tu-2')
			);
			await approveTool(h, { toolUseId: 'tu-2', decision: 'approve' });
			const done = await waitFor(h, (st) => st.status === 'idle' && st.turnSeq >= 3);
			expect(sawReasonOnTurn2).toBe(true);
			// The denied call's tool_result is an error carrying the reason.
			const flat = JSON.stringify(done.messages);
			expect(flat).toContain('client prefers mornings');
			assertMonotonicOffsets(done.events);
			await h.signal(SIGNAL_CANCEL);
			await h.result();
		});
	});

	// (e) cancelSignal escapes a pending approval cleanly ───────────────────────
	it('(e) cancelSignal escapes a pending approval and ends cancelled', async () => {
		const script: ScriptStep[] = [toolUse([{ toolUseId: 'tu-c', name: 'act' }])];
		const fake = makeFakeModel(script);
		const ran: string[] = [];
		const config = baseConfig({
			conversationId: 'conv-e',
			approvalPolicy: { type: 'all' },
			tools: [{ name: 'act', description: 'x', inputSchema: {}, kind: 'activity' }]
		});
		const activities: ScriptedActivities = {
			callModel: fake.callModel,
			act: async () => {
				ran.push('ran');
				return 'ok';
			}
		};
		await withWorker('ah-e', activities, async (taskQueue) => {
			const h = await startAgent(taskQueue, 'ah-e', config);
			await sendMessage(h, 'do');
			await waitFor(h, (st) => st.status === 'awaiting_approval');
			await h.signal(SIGNAL_CANCEL);
			const result = (await h.result()) as AgentState;
			expect(result.status).toBe('cancelled');
			// The gated tool never ran (we cancelled at the condition()).
			expect(ran).toEqual([]);
			assertMonotonicOffsets(result.events);
		});
	});

	// (f) abandoned approval hits approvalTimeoutMs → ends gracefully ────────────
	it('(f) an abandoned approval times out and ends gracefully (abandoned)', async () => {
		const script: ScriptStep[] = [toolUse([{ toolUseId: 'tu-f', name: 'act' }])];
		const fake = makeFakeModel(script);
		const config = baseConfig({
			conversationId: 'conv-f',
			approvalPolicy: { type: 'all' },
			approvalTimeoutMs: 60_000, // 1 min no-progress bound (time-skipping advances it)
			tools: [{ name: 'act', description: 'x', inputSchema: {}, kind: 'activity' }]
		});
		await withWorker(
			'ah-f',
			{ callModel: fake.callModel, act: async () => 'ok' },
			async (taskQueue) => {
				const h = await startAgent(taskQueue, 'ah-f', config);
				await sendMessage(h, 'do');
				// Never approve — time-skipping skips past the 1-min timeout; the workflow
				// abandons the stale approval and ends gracefully (NOT a thrown error).
				const result = (await h.result()) as AgentState;
				expect(result.status).toBe('abandoned');
				assertMonotonicOffsets(result.events);
			}
		);
	});

	// toolUseId keying: TWO pending calls, approving one resolves only that call ──
	it('keys approval to a specific toolUseId (two pending → approving one runs only that)', async () => {
		// One turn requests TWO gated tool calls. Approving only `tu-A` must run only A;
		// the loop processes calls in order, so it then waits on `tu-B`.
		const script: ScriptStep[] = [
			toolUse([
				{ toolUseId: 'tu-A', name: 'act', input: { id: 'A' } },
				{ toolUseId: 'tu-B', name: 'act', input: { id: 'B' } }
			]),
			endTurn('both done')
		];
		const fake = makeFakeModel(script);
		const ran: string[] = [];
		const config = baseConfig({
			conversationId: 'conv-key',
			approvalPolicy: { type: 'all' },
			tools: [{ name: 'act', description: 'x', inputSchema: {}, kind: 'activity' }]
		});
		const activities: ScriptedActivities = {
			callModel: fake.callModel,
			act: async (args: { id: string }) => {
				ran.push(args.id);
				return `ran:${args.id}`;
			}
		};
		await withWorker('ah-key', activities, async (taskQueue) => {
			const h = await startAgent(taskQueue, 'ah-key', config);
			await sendMessage(h, 'do both');
			// First pending call is tu-A.
			await waitFor(
				h,
				(st) =>
					st.status === 'awaiting_approval' &&
					st.events.some((e) => e.type === 'approval_required' && e.toolUseId === 'tu-A')
			);
			// Approving tu-A must NOT resolve tu-B. A stray approve for an unknown id is ok=false.
			const stray = await approveTool(h, { toolUseId: 'tu-unknown', decision: 'approve' });
			expect(stray.ok).toBe(false);
			await approveTool(h, { toolUseId: 'tu-A', decision: 'approve' });
			// Only A has run; the loop now waits on tu-B.
			await waitFor(
				h,
				(st) =>
					st.status === 'awaiting_approval' &&
					st.events.some((e) => e.type === 'approval_required' && e.toolUseId === 'tu-B')
			);
			expect(ran).toEqual(['A']);
			await approveTool(h, { toolUseId: 'tu-B', decision: 'approve' });
			const done = await waitFor(h, (st) => st.status === 'idle' && st.turnSeq >= 2);
			expect(ran).toEqual(['A', 'B']);
			assertMonotonicOffsets(done.events);
			await h.signal(SIGNAL_CANCEL);
			await h.result();
		});
	});

	// per-job model: config.model threads through to every CallModelInput.model ──────
	it('threads config.model through to CallModelInput.model (per-job model pass-through)', async () => {
		const fake = makeFakeModel([endTurn('drafted')]);
		const config = baseConfig({
			conversationId: 'conv-model',
			model: 'claude-haiku-4-5' // an opaque string the harness must pass through verbatim
		});
		await withWorker('ah-model', { callModel: fake.callModel }, async (taskQueue) => {
			const h = await startAgent(taskQueue, 'ah-model', config);
			await sendMessage(h, 'draft something');
			await waitFor(h, (st) => st.status === 'idle' && st.turnSeq >= 1);
			expect(fake.calls.length).toBeGreaterThanOrEqual(1);
			// The configured model reached the activity verbatim (harness never interprets it).
			expect(fake.calls[0].model).toBe('claude-haiku-4-5');
			await h.signal(SIGNAL_CANCEL);
			await h.result();
		});
	});

	// model unset: CallModelInput.model is absent (old behavior, replay-safe) ─────────
	it('omits model from CallModelInput when config.model is unset (default-behavior path)', async () => {
		const fake = makeFakeModel([endTurn('drafted')]);
		const config = baseConfig({ conversationId: 'conv-nomodel' }); // no model set
		await withWorker('ah-nomodel', { callModel: fake.callModel }, async (taskQueue) => {
			const h = await startAgent(taskQueue, 'ah-nomodel', config);
			await sendMessage(h, 'draft something');
			await waitFor(h, (st) => st.status === 'idle' && st.turnSeq >= 1);
			expect(fake.calls[0].model).toBeUndefined();
			await h.signal(SIGNAL_CANCEL);
			await h.result();
		});
	});

	// injected hidden: never in toolSchemas[].inputSchema NOR the rendered system ──
	it('hides injected params from tool schemas AND the system prompt seen by the model', async () => {
		const fake = makeFakeModel([toolUse([{ name: 'lookup', input: { q: 'x' } }]), endTurn('ok')]);
		const config = baseConfig({
			conversationId: 'conv-inj',
			system: 'You help with lookups.', // contains NO providerId
			approvalPolicy: { type: 'auto' },
			injected: { providerId: 'prov-SECRET-123', actingUserId: 'user-SECRET-456' },
			tools: [
				{
					name: 'lookup',
					description: 'Look something up',
					inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
					kind: 'activity'
				}
			]
		});
		let toolReceivedInjected = false;
		const activities: ScriptedActivities = {
			callModel: fake.callModel,
			lookup: async (_args: unknown, injected: { providerId?: string }) => {
				// The TOOL activity DOES receive injected (it scopes by tenant) …
				if (injected?.providerId === 'prov-SECRET-123') toolReceivedInjected = true;
				return 'result';
			}
		};
		await withWorker('ah-inj', activities, async (taskQueue) => {
			const h = await startAgent(taskQueue, 'ah-inj', config);
			await sendMessage(h, 'look up x');
			await waitFor(h, (st) => st.turnSeq >= 2 && st.status === 'idle');
			// Every CallModelInput the model saw: injected fields absent from schemas …
			expect(fake.calls.length).toBeGreaterThanOrEqual(1);
			for (const call of fake.calls) {
				const schemaJson = JSON.stringify(call.toolSchemas);
				expect(schemaJson).not.toContain('prov-SECRET-123');
				expect(schemaJson).not.toContain('providerId');
				expect(schemaJson).not.toContain('actingUserId');
				// … and absent from the rendered system string (tenant safety + cache hits).
				expect(call.system).not.toContain('prov-SECRET-123');
				expect(call.system).not.toContain('providerId');
			}
			// … but the tool activity still received the injected bag (consumer scoping).
			expect(toolReceivedInjected).toBe(true);
			await h.signal(SIGNAL_CANCEL);
			await h.result();
		});
	});

	// max_turns exhaustion is terminal + graceful ───────────────────────────────
	it('reaches max_turns gracefully (emits max_turns_reached, ends — not a throw)', async () => {
		// The model keeps asking for a tool forever; maxTurns:2 bounds the loop.
		const config = baseConfig({
			conversationId: 'conv-mt',
			maxTurns: 2,
			approvalPolicy: { type: 'auto' },
			tools: [
				{ name: 'loop', description: 'x', inputSchema: {}, kind: 'inline', run: () => 'again' }
			]
		});
		// Always request the tool → never end_turn → exhausts maxTurns.
		const fake = makeFakeModel([toolUse([{ name: 'loop' }])]);
		await withWorker(
			'ah-mt',
			{ callModel: fake.callModel },
			async (taskQueue) => {
				const h = await startAgent(taskQueue, 'ah-mt', config);
				await sendMessage(h, 'go');
				const result = (await h.result()) as AgentState;
				expect(result.status).toBe('max_turns');
				expect(result.events.some((e) => e.type === 'max_turns_reached')).toBe(true);
				assertMonotonicOffsets(result.events);
			},
			inlineWorkflowsPath
		);
	});
});
