import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

// Execute the actual UI callback without booting a Tauri window. Only its
// environment is injected; the function under test is read from main.ts.
const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const start = source.indexOf('async function runPreviewTranslation():');
const end = source.indexOf('\nfunction setDraft(', start);
assert.ok(start >= 0 && end > start);
const body = stripTypeScriptTypes(source.slice(start, end));

for (const outcome of ['success', 'failure'] as const) {
  for (const changed of [true, false]) {
  test(changed ? `preview ${outcome} cannot replace the new draft during the translation debounce window` : `preview ${outcome} still settles for the current draft`, async () => {
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const pending = new Promise((a, b) => { resolve = a; reject = b; });
    const state = { activeGid: 'synthetic-room', draftVersion: 7, draft: 'synthetic old draft', translation: { status: 'idle', draftVersion: 7, gid: 'synthetic-room' } };
    const patches: unknown[] = [];
    const env = {
      activeAccount: () => ({ context: { account_id: 'synthetic-account', environment: 'synthetic', session_generation: 1 } }),
      S: () => state,
      activeConv: () => ({ gid: 'synthetic-room' }),
      translationTarget: () => 'en',
      store: { patch: (patch: object) => { patches.push(patch); Object.assign(state, patch); } },
      ipc: { invoke: () => pending },
      UiCommands: { ASSIST_TRANSLATE: 'assistant_translate' },
      stillActive: () => true,
      translationApplies: (tr: { gid: string; draftVersion: number }, gid: string, version: number) => tr.gid === gid && tr.draftVersion === version,
      isAppError: () => false,
      t: () => 'synthetic error',
      errorMessage: () => 'synthetic error',
    };
    const run = new Function(...Object.keys(env), body + '\nreturn runPreviewTranslation;')(...Object.values(env)) as () => Promise<void>;
    const finished = run();
    assert.equal(patches.length, 1, 'initial busy state is expected');
    if (changed) { state.draftVersion = 8; state.draft = 'synthetic new draft'; }
    // The debounce has not yet scheduled the next translation: translation
    // still describes version 7 while the actual editor is already version 8.
    if (outcome === 'success') resolve({ draft_version: 7, text: 'synthetic old translation' });
    else reject(new Error('synthetic old failure'));
    await finished;
    assert.equal(patches.length, changed ? 1 : 2, 'only the current draft may publish completion');
    assert.equal(state.draft, changed ? 'synthetic new draft' : 'synthetic old draft');
    assert.equal(state.draftVersion, changed ? 8 : 7);
    if (!changed) assert.equal(state.translation.status, outcome === 'success' ? 'done' : 'error');
  });
}
}
