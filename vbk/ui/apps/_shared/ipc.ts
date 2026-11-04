import { installEditingContextMenu } from '../../packages/ui-kit/src/context-menu.ts';
/** Picks the host IPC when running inside Tauri, otherwise the deterministic mock. */

import type { IpcClient } from '../../packages/ipc/src/client.ts';
import { createTauriIpc, hasTauri } from '../../packages/ipc/src/client.ts';
import { createMockIpc, scenarioFromLocation } from './mock-loader.ts';
import type { MockIpc } from './mock-loader.ts';

export interface SelectedIpc {
  readonly ipc: IpcClient;
  readonly mock: MockIpc | null;
}

let editingInstalled = false;
function editing(ipc: IpcClient, native: boolean): void {
  if (editingInstalled || typeof document === 'undefined') return;
  editingInstalled = true;
  installEditingContextMenu({
    read: () => native ? ipc.invoke<string>('shell_read_clipboard_text') : navigator.clipboard.readText(),
    write: text => native ? ipc.invoke('shell_write_clipboard_text', {text}) : navigator.clipboard.writeText(text),
  });
}
export function selectIpc(): SelectedIpc {
  if (hasTauri()) { const ipc = createTauriIpc(); editing(ipc, true); return { ipc, mock: null }; }
  const mock = createMockIpc(scenarioFromLocation());
  editing(mock, false);
  return { ipc: mock, mock };
}

/** Attach the mock to `window` for smoke tests; a no-op in the host. */
export function exposeForTests(sel: SelectedIpc, extra: Record<string, unknown> = {}): void {
  if (!sel.mock) return;
  (window as unknown as Record<string, unknown>)['__vbkMock'] = sel.mock;
  for (const [k, v] of Object.entries(extra)) (window as unknown as Record<string, unknown>)[k] = v;
}
