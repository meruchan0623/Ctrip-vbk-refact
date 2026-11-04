import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserLogin, shouldDiscoverBrowsers } from './browser-login.ts';
import { AccountCommands } from '../../packages/ipc/src/commands.ts';

test('sole browser offer requires explicit confirmation and no credential enters UI', async () => {
  const calls: unknown[] = [];
  const controller = createBrowserLogin({ attempt: () => 'attempt-1', update() {}, invoke: async (command, payload) => {
    calls.push([command, payload]);
    return command === AccountCommands.BROWSER_PROFILES ? [{ id: 'Default', label: 'Chrome' }] : null;
  } });
  await controller.discover();
  assert.deepEqual(calls, [[AccountCommands.BROWSER_PROFILES, {}]]);
  await controller.connect();
  assert.deepEqual(calls, [[AccountCommands.BROWSER_PROFILES, {}], [AccountCommands.BROWSER_CONNECT, { attempt_id: 'attempt-1', profile_id: 'Default' }]]);
  assert.equal(controller.state.message, '正在核验携程账号…');
});
test('multiple profiles never connect until one is selected', async () => {
  const calls: string[] = [];
  const controller = createBrowserLogin({ attempt: () => 'attempt-1', update() {}, invoke: async (command) => {
    calls.push(command); return [{ id: 'Default', label: 'Chrome' }, { id: 'Profile 2', label: 'Chrome 2' }];
  } });
  await controller.discover(); await controller.connect(); await controller.connect('../secret');
  assert.deepEqual(calls, [AccountCommands.BROWSER_PROFILES]);
  controller.select('Profile 2'); await controller.connect();
  assert.equal(calls[1], AccountCommands.BROWSER_CONNECT);
});
test('cancelling during discovery prevents late import', async () => {
  let resolve!: (value: unknown) => void;
  const calls: string[] = [];
  const controller = createBrowserLogin({ attempt: () => 'attempt-1', update() {}, invoke: async (command) => { calls.push(command); return new Promise(r => { resolve = r; }); } });
  const pending = controller.discover(); controller.cancel(); resolve([{ id: 'Default', label: 'Chrome' }]); await pending;
  assert.deepEqual(calls, [AccountCommands.BROWSER_PROFILES]);
});
test('failed import leaves official login fallback and hides backend details', async () => {
  const controller = createBrowserLogin({ attempt: () => 'attempt-1', update() {}, invoke: async (command) => {
    if (command === AccountCommands.BROWSER_PROFILES) return [{ id: 'Default', label: 'Chrome' }];
    throw new Error('sensitive backend detail');
  } });
  await controller.discover();
  await controller.connect();
  assert.equal(controller.state.busy, false);
  assert.match(controller.state.message, /官方登录页/);
  assert.doesNotMatch(controller.state.message, /sensitive/);
});
test('background discovery retains selection and does not import automatically', async () => {
  let choices = [{ id: 'one', label: 'Chrome · One' }, { id: 'two', label: 'Edge · Two' }];
  const calls: string[] = [];
  const controller = createBrowserLogin({ attempt: () => 'attempt', update() {}, invoke: async command => { calls.push(command); return choices; } });
  await controller.discover(); controller.select('two'); await controller.discover(true);
  assert.equal(controller.state.selected, 'two');
  assert.ok(calls.every(c => c === AccountCommands.BROWSER_PROFILES));
  choices = [];
  await controller.discover(true);
  assert.equal(controller.state.selected, '');
});
test('polling stops while official identity verification is pending', async () => {
  const calls: string[] = [];
  const controller = createBrowserLogin({ attempt: () => 'attempt', update() {}, invoke: async command => { calls.push(command); return [{ id: 'one', label: 'Chrome' }]; } });
  await controller.discover(); await controller.connect(); await controller.discover(true);
  assert.deepEqual(calls, [AccountCommands.BROWSER_PROFILES, AccountCommands.BROWSER_CONNECT]);
});


test('background discovery is single-flight and unchanged offers do not publish', async () => {
  let resolve!: (value: unknown) => void, invokes = 0, updates = 0;
  const controller = createBrowserLogin({ attempt: () => 'attempt', update() { updates++; }, invoke: () => { invokes++; return new Promise(r => { resolve = r; }); } });
  const pending = controller.discover(true);
  await controller.discover(true);
  assert.equal(invokes, 1);
  resolve([{ id: 'one', label: 'Chrome' }]); await pending;
  const initial = updates;
  const repeat = controller.discover(true); resolve([{ id: 'one', label: 'Chrome' }]); await repeat;
  assert.equal(updates, initial);
  const changed = controller.discover(true); resolve([{ id: 'one', label: 'Edge' }]); await changed;
  assert.equal(updates, initial + 1);
});
test('manual, closing and hidden windows suspend automatic discovery; visible resumes', () => {
  assert.equal(shouldDiscoverBrowsers('?browser=manual', 'visible', false), false);
  assert.equal(shouldDiscoverBrowsers('', 'visible', true), false);
  assert.equal(shouldDiscoverBrowsers('', 'hidden', false), false);
  assert.equal(shouldDiscoverBrowsers('', 'visible', false), true);
});


test('manual refresh adopts a pending background discovery and exposes its success or failure', async () => {
  for (const outcome of ['resolve', 'reject', 'cancel'] as const) {
    let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
    let invokes = 0, updates = 0, finished = false;
    const controller = createBrowserLogin({ attempt: () => 'attempt', update() { updates++; }, invoke: () => { invokes++; return new Promise((yes, no) => { resolve = yes; reject = no; }); } });
    const background = controller.discover(true);
    assert.equal(controller.state.busy, false);
    const manual = controller.discover().then(() => { finished = true; });
    assert.equal(invokes, 1);
    assert.equal(controller.state.busy, true);
    assert.match(controller.state.message, /正在查找/);
    await Promise.resolve(); assert.equal(finished, false);
    const beforeCompletion = updates;
    if (outcome === 'cancel') controller.cancel();
    if (outcome === 'reject') reject(new Error('private failure')); else resolve([{ id: 'one', label: 'Chrome' }]);
    await Promise.all([background, manual]);
    assert.equal(finished, true);
    assert.equal(invokes, 1);
    if (outcome === 'resolve') { assert.equal(controller.state.busy, false); assert.equal(controller.state.selected, 'one'); }
    else if (outcome === 'reject') { assert.equal(controller.state.busy, false); assert.match(controller.state.message, /未就绪/); assert.doesNotMatch(controller.state.message, /private failure/); }
    else { assert.equal(updates, beforeCompletion); assert.deepEqual(controller.state.choices, []); }
  }
});
