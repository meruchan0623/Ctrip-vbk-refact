import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserTabs, tabLabel, displayAddress, webTabView, browserStage } from './browser-tabs.ts';
import { UiCommands, type UiBrowserTab } from '../../packages/ipc/src/client.ts';

const tab = (id: string, extra: Partial<UiBrowserTab> = {}): UiBrowserTab => ({ tab_id: id, account_id: 'a', url: `https://x.test/${id}?token=SECRET`, title: id, loading: false, ...extra });
function setup(opts: { invoke?: (c: string, p: any) => Promise<unknown> } = {}) {
  const st = { tabs: [] as UiBrowserTab[], active: null as string | null, covered: false };
  const calls: { c: string; p: any }[] = []; const notes: string[] = [];
  let rect = { x: 0.4, y: 40.6, width: 800.2, height: 600.7 };
  const el = { getBoundingClientRect: () => rect } as unknown as HTMLElement;
  const api = createBrowserTabs({
    invoke: opts.invoke ? (c, p) => { calls.push({ c, p }); return opts.invoke!(c, p); } : async (c, p) => { calls.push({ c, p }); return c === UiCommands.SHELL_OPEN_WEBVIEW ? tab('t1') : null; },
    get: () => st,
    patch: (p) => { if (p.webTabs) st.tabs = [...p.webTabs]; if (p.activeWeb !== undefined) st.active = p.activeWeb; },
    notify: (t) => notes.push(t), stage: () => el, schedule: (cb) => cb(),
  });
  return { st, calls, notes, api, setRect: (r: typeof rect) => { rect = r; } };
}
const shows = (calls: { c: string; p: any }[]) => calls.filter((x) => x.c === UiCommands.BROWSER_SHOW).map((x) => x.p);
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('open reuses an existing tab and activates it', async () => {
  const { st, api, calls } = setup();
  await api.open({ account_id: 'a' }, 'https://x.test/t1');
  await api.open({ account_id: 'a' }, 'https://x.test/t1');
  await tick();
  assert.equal(st.tabs.length, 1); assert.equal(st.active, 't1');
  assert.deepEqual(calls[0]!.p, { account: { account_id: 'a' }, url: 'https://x.test/t1' });
  assert.deepEqual(shows(calls)[0], { tab_id: 't1', bounds: { x: 0, y: 41, width: 800, height: 601 } });
});

test('open failure and malformed result notify', async () => {
  const a = setup({ invoke: async () => { throw new Error('x'); } });
  await a.api.open({}, 'u'); assert.equal(a.notes.length, 1);
  const b = setup({ invoke: async () => ({ nope: 1 }) });
  await b.api.open({}, 'u'); assert.equal(b.notes.length, 1); assert.equal(b.st.tabs.length, 0);
});

test('close activates the adjacent tab, then null', async () => {
  const { st, api } = setup();
  st.tabs = [tab('a'), tab('b'), tab('c')]; st.active = 'b';
  await api.close('b'); assert.equal(st.active, 'c');
  await api.close('c'); assert.equal(st.active, 'a');
  await api.close('a'); assert.equal(st.active, null); assert.equal(st.tabs.length, 0);
});

test('covered hides; unchanged rect is not resent; changed rect is', async () => {
  const { st, api, calls, setRect } = setup();
  st.tabs = [tab('a')]; st.active = 'a';
  await api.sync(); await api.sync();
  assert.equal(shows(calls).length, 1);
  setRect({ x: 0, y: 40, width: 700, height: 500 }); await api.sync();
  assert.equal(shows(calls).length, 2);
  st.covered = true; await api.sync();
  assert.deepEqual(shows(calls).at(-1), { tab_id: null });
  st.covered = false; st.active = null; await api.sync();
  assert.deepEqual(shows(calls).at(-1), { tab_id: null });
  assert.equal(shows(calls).length, 3);
});

test('in-flight sync is serialized and the last state wins', async () => {
  let release!: () => void; let first = true;
  const { st, api, calls } = setup({ invoke: (c) => (c === UiCommands.BROWSER_SHOW && first ? (first = false, new Promise<void>((r) => { release = r; })) : Promise.resolve(null)) });
  st.tabs = [tab('a')]; st.active = 'a';
  const p1 = api.sync();
  st.covered = true; void api.sync(); st.covered = false; void api.sync(); st.covered = true; void api.sync();
  assert.equal(shows(calls).length, 1);
  release(); await p1; await tick();
  assert.equal(shows(calls).length, 2);
  assert.deepEqual(shows(calls).at(-1), { tab_id: null });
});

test('events validate shape and tolerate unknown tabs', () => {
  const { st, api } = setup();
  api.receiveOpened({ tab_id: 1 }); api.receiveOpened(null); assert.equal(st.tabs.length, 0);
  api.receiveChanged(tab('ghost')); assert.equal(st.tabs.length, 0);
  api.receiveClosed({ tab_id: 'ghost' }); api.receiveClosed('x');
  api.receiveOpened(tab('a')); assert.equal(st.active, 'a');
  api.receiveChanged(tab('a', { title: 'new' })); assert.equal(st.tabs[0]!.title, 'new');
  api.receiveClosed({ tab_id: 'a' }); assert.equal(st.tabs.length, 0); assert.equal(st.active, null);
});

test('labels and address never expose the query', () => {
  assert.equal(tabLabel({ title: ' Hi ', url: 'https://a.b/c' }), 'Hi');
  assert.equal(tabLabel({ title: '', url: 'https://a.b/c?t=1' }), 'a.b');
  assert.equal(displayAddress('https://a.b/path/x?token=SECRET#f'), 'a.b/path/x');
  assert.equal(displayAddress('https://a.b/?token=SECRET'), 'a.b');
  const mk = (tag: string, props: any, ...kids: any[]) => ({ tag, props: props ?? {}, kids: kids.flat() }) as any;
  const icon = (p: string) => ({ icon: p }) as any;
  const v = browserStage(tab('a'), { onBack() {}, onForward() {}, onReload() {}, onExternal() {} }, mk, icon, () => {});
  assert.ok(!JSON.stringify(v).includes('SECRET'));
  const w: any = webTabView(tab('a', { loading: true }), true, '账号A', { onSelect() {}, onClose() {} }, mk, icon);
  assert.equal(w.props.class, 'tab web-tab on'); assert.equal(w.props.dataset.webTab, 'a');
  assert.ok(!JSON.stringify(w).includes('SECRET'));
});

test('web tab closes on middle click only', () => {
  const mk: any = (tag: string, props: any, ...children: any[]) => ({ tag, props: props ?? {}, children });
  const icon = (p: string) => ({ icon: p }) as any;
  let closed = 0; let selected = 0;
  const w: any = webTabView(tab('a'), false, '', { onSelect() { selected++; }, onClose() { closed++; } }, mk, icon);
  const ev = (button: number) => { const e = { button, prevented: false, stopped: false, preventDefault() { e.prevented = true; }, stopPropagation() { e.stopped = true; } }; return e; };
  const left = ev(0); w.props.onauxclick(left);
  assert.equal(closed, 0); assert.equal(left.prevented, false);
  const right = ev(2); w.props.onauxclick(right);
  assert.equal(closed, 0);
  const middle = ev(1); w.props.onauxclick(middle);
  assert.equal(closed, 1); assert.equal(selected, 0); assert.ok(middle.prevented && middle.stopped);
  const down = ev(1); w.props.onmousedown(down); assert.ok(down.prevented);
  const downLeft = ev(0); w.props.onmousedown(downLeft); assert.equal(downLeft.prevented, false);
});
