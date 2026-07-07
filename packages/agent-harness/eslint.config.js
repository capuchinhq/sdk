import js from '@eslint/js';
import ts from 'typescript-eslint';

// ── Import-boundary lint (the determinism guardrail, AQ-BUNDLE) ───────────────
// The `./workflow` entry and everything it imports must be webpack/determinism-safe:
// a consumer's worker bundles it via `workflowsPath`, and any `node:*`/SDK/runtime
// import dragged into that bundle is a determinism break. Two rules enforce this on
// `src/workflow/**`:
//
//   1. `no-restricted-imports` forbids runtime modules in the workflow bundle —
//      `node:*`, `@anthropic-ai/sdk`, and the activities-contract VALUE edge (the
//      `./workflow` → `./activities-contract` import MUST be `import type`-only).
//   2. `@typescript-eslint/consistent-type-imports` forces type-only imports to use
//      `import type`, so a value import across the contract edge is a hard error
//      (rule 1's `allowTypeImports: true` lets the type edge through, rule 2 makes
//      sure it's actually `import type`).
//
// A deliberate VALUE import of the contract from a workflow file fails lint — proven
// in CI / locally by adding such an import and watching `pnpm --filter
// @simiancreative/agent-harness lint` fail, then reverting.

export default ts.config(
	{
		ignores: ['dist/**', 'node_modules/**']
	},
	js.configs.recommended,
	...ts.configs.recommended,
	{
		files: ['src/**/*.ts'],
		languageOptions: {
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
		},
		rules: {
			'@typescript-eslint/consistent-type-imports': [
				'error',
				{ prefer: 'type-imports', fixStyle: 'inline-type-imports' }
			]
		}
	},
	{
		// The pure workflow bundle: the strict import boundary lives here.
		files: ['src/workflow/**/*.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							// Anything that is NOT `@temporalio/workflow` and NOT a relative
							// import: block runtime SDK/node modules from the workflow bundle.
							// `@temporalio/common` is allowed ONLY as a type import (the handler
							// definition types live there); the consistent-type-imports rule + the
							// allowTypeImports flag below keep that edge type-only.
							group: ['node:*', '@anthropic-ai/*'],
							message:
								'The pure `./workflow` bundle may not import node:* or any SDK — push I/O into an activity (AQ-BUNDLE).'
						},
						{
							// The `./workflow` → `./activities-contract` edge MUST be type-only.
							// A VALUE import here is the exact violation the boundary guards
							// against; `allowTypeImports` lets `import type` through.
							group: ['**/activities-contract', '**/activities-contract/*'],
							allowTypeImports: true,
							message:
								'Import the activities-contract as `import type` only — the `./workflow` → `./activities-contract` edge is type-only (AQ-BUNDLE).'
						}
					]
				}
			]
		}
	},
	{
		// Tests + test-support: drive a real worker/env, so they legitimately use the
		// SDK + node built-ins and the contract's value exports. Boundary rules off.
		files: ['src/**/*.test.ts', 'src/test-support/**/*.ts'],
		rules: {
			'no-restricted-imports': 'off'
		}
	}
);
