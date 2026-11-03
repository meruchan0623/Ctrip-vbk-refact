/**
 * Single indirection between the window entries and the deterministic mock
 * IPC (`packages/ipc/src/mock.ts`).
 *
 * In source and in the Playwright smoke run this module simply re-exports the
 * mock. `ui/tools/bundle.mjs` replaces the compiled `mock-loader.js` with a
 * data-free stub and drops `mock.js` from `ui/bundle/`, so the release
 * `frontendDist` carries neither the fake accounts nor the demo order
 * samples (plan I-29 "bundle 剔除 mock.js"; `tools/release-scan.mjs` asserts
 * it). Nothing else may import `mock.ts` from non-test runtime code.
 */
export { createMockIpc, scenarioFromLocation, MOCK_ORDER_SAMPLES } from '../../packages/ipc/src/mock.ts';
export type { MockIpc } from '../../packages/ipc/src/mock.ts';
