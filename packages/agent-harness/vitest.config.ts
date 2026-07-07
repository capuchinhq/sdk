import { defineConfig } from 'vitest/config';

// The harness test suite drives a real time-skipping `TestWorkflowEnvironment`
// (worker boot bundles the BUILT `./workflow` artifact via `workflowsPath`), so the
// suite needs the node environment and a generous timeout for env startup + the
// webpack bundle. No SvelteKit plugin — this is a standalone library.
export default defineConfig({
	test: {
		include: ['src/**/*.{test,spec}.ts'],
		environment: 'node',
		testTimeout: 120_000,
		hookTimeout: 120_000
	}
});
