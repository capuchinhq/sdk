// ── Tool contract ────────────────────────────────────────────────────────────
// Two tool kinds: an `AgentTool` whose execution is a durable Temporal activity
// (side-effects / external calls — the consumer registers a matching activity on
// the worker), and an `InlineTool` that is pure compute run inside the workflow
// (deterministic, no I/O). Both expose the SAME model-visible `inputSchema`; the
// kind only changes HOW the workflow dispatches the call.

/** Per-call context the model must NEVER choose — tenant id, acting user, auth
 *  scope. Supplied by the workflow from `AgentConfig.injected` and hidden from
 *  every tool's JSON schema sent to the model (Principle 4). It is an arbitrary
 *  bag of keys; the harness never inspects a specific key (no `providerId`
 *  hardcoded — that's a consumer concern). */
export interface InjectedParams {
	[k: string]: unknown;
}

/**
 * A tool whose execution is a durable Temporal activity (side-effects / external
 * calls). The consumer registers an activity named `${name}` on the worker; the
 * workflow proxies and invokes it as `(modelArgs, injected)`.
 */
export interface AgentTool<Args = unknown, Out = unknown> {
	name: string;
	description: string;
	/** JSON Schema the MODEL sees. MUST NOT contain injected fields (Principle 4). */
	inputSchema: Record<string, unknown>;
	/** Hint only — the ToolApprovalPolicy decides (Principle 5). */
	inherentlySafe?: boolean;
	kind: 'activity';
	/** Phantom markers so `Args`/`Out` are not erased to `unknown` at call sites;
	 *  never read at runtime, present only for inference on the consumer side. */
	readonly __args?: Args;
	readonly __out?: Out;
}

/**
 * A tool that is pure compute inside the workflow (no side-effects, deterministic).
 * `run` executes IN the workflow — it MUST be deterministic: no I/O, no `Date.now()`,
 * no randomness, no SDK calls. It receives the model-visible args plus the hidden
 * `injected` bag (so an inline tool can still scope by tenant without the model
 * seeing the scope).
 */
export interface InlineTool<Args = unknown, Out = unknown> {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	inherentlySafe?: boolean;
	kind: 'inline';
	/** Deterministic — runs in the workflow. No I/O, no Date.now(), no random. */
	run(args: Args, injected: InjectedParams): Out;
}

/** A tool of either kind. */
export type AnyTool<Args = unknown, Out = unknown> = AgentTool<Args, Out> | InlineTool<Args, Out>;

/**
 * The model-visible projection of a tool — exactly what is sent to the model. It is
 * the tool's `name`/`description`/`inputSchema` and NOTHING ELSE: no `kind`, no
 * `inherentlySafe`, and never the injected bag (Principle 4). The workflow derives
 * these from the configured tools before each model call.
 */
export interface ToolSchema {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}
