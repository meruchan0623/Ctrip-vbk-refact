/** Picks the host IPC when running inside Tauri, otherwise the deterministic mock. */

import type { IpcClient } from '../../packages/ipc/src/client.ts';
import { createTauriIpc, hasTauri } from '../../packages/ipc/src/client.ts';
import { createMockIpc, scenarioFromLocation } from '../../packages/ipc/src/mock.ts';
import type { MockIpc } from '../../packages/ipc/src/mock.ts';

export interface SelectedIpc {
  readonly ipc: IpcClient;
  readonly mock: MockIpc | null;
}

export function selectIpc(): SelectedIpc {
  if (hasTauri()) return { ipc: createTauriIpc(), mock: null };
  const mock = createMockIpc(scenarioFromLocation());
  return { ipc: mock, mock };
}

/** Attach the mock to `window` for smoke tests; a no-op in the host. */
export function exposeForTests(sel: SelectedIpc, extra: Record<string, unknown> = {}): void {
  if (!sel.mock) return;
  (window as unknown as Record<string, unknown>)['__vbkMock'] = sel.mock;
  for (const [k, v] of Object.entries(extra)) (window as unknown as Record<string, unknown>)[k] = v;
}
