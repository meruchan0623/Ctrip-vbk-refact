import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { h, rerender, cx } from '../../packages/ui-kit/src/h.ts';
import { ALARM_STRINGS } from './strings.ts';

import { installFakeDom, fakeDocument, readCounters, resetCounters } from '../../tests/fake-dom.ts';

const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
function fixture(busy = false) {
  const calls: unknown[] = [];
  const patches: unknown[] = [];
  const row = { key: 'a:g:r', entry: { gid: 'g', round_id: 'r', version: 7 }, label: '客户', waitedText: '30s' };
  const deps = {
    h: (tag: string, props: any, ...children: unknown[]) => ({ tag, props, children }), cx,
    S: ALARM_STRINGS, store: { patch: (p: unknown) => patches.push(p) },
    act: (entry: unknown, action: unknown) => calls.push({ entry, action }),
    avatarColor: () => '', initialOf: () => '', subLine: () => [], icon: () => '',
    IC: {},
  };
  const start = source.indexOf('function renderRow('), end = source.indexOf('\nfunction render(', start);
  const render = new Function(...Object.keys(deps), stripTypeScriptTypes(source.slice(start, end)) + '\nreturn renderRow;')(...Object.values(deps));
  const tree = render(row, { busy: busy ? row.key : null });
  return { calls, patches, tree, row };
}

test('one click on an alarm row directly opens that customer', () => {
  const f = fixture(); f.tree.props.onclick();
  assert.deepEqual(f.calls, [{ entry: f.row.entry, action: { kind: 'open' } }]);
});

test('Enter and Space open the row once; nested controls and busy rows do not navigate', () => {
  for (const key of ['Enter', ' ']) {
    const f = fixture(); const row = {};
    let prevented = false;
    f.tree.props.onkeydown({ key, target: row, currentTarget: row, preventDefault: () => { prevented = true; } });
    assert.equal(f.calls.length, 1); assert.equal(prevented, true);
    f.tree.props.onkeydown({ key, target: {}, currentTarget: row });
    assert.equal(f.calls.length, 1);
  }
  const f = fixture(true); f.tree.props.onclick();
  assert.equal(f.calls.length, 0);
  let stopped = false;
  const actions = f.tree.children.find((n: any) => n?.props?.class === 'arow-acts') as any;
  actions.props.onclick({ stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true);
});


test('snapshot ticks retain focused row controls and update their version-bound handlers', () => {
  const { root } = installFakeDom();
  const calls: { entry: { version: number }; action: unknown }[] = [];
  const deps = {
    h, cx, S: ALARM_STRINGS, store: { patch: () => {} },
    act: (entry: { version: number }, action: unknown) => calls.push({ entry, action }),
    avatarColor: () => '', initialOf: () => '', subLine: () => [], icon: () => '',
    IC: {},
  };
  const start = source.indexOf('function renderRow('), end = source.indexOf('\nfunction render(', start);
  const render = new Function(...Object.keys(deps), stripTypeScriptTypes(source.slice(start, end)) + '\nreturn renderRow;')(...Object.values(deps));
  const row = { key: '["production","a",2,"g","r"]', entry: { gid: 'g', round_id: 'r', version: 7 }, label: '客户', waitedText: '30s' };
  const dom = root as unknown as Element;
  const draw = (version: number) => rerender(dom, () => h('div', { dataset: { keepScroll: 'alarm' } }, render({ ...row, entry: { ...row.entry, version }, waitedText: `${version}s` }, { busy: null })), { morph: true });
  draw(7);
  const hide = root.querySelector('[data-act="hide"]')!;
  hide.focus();
  resetCounters();
  draw(8);
  assert.equal(root.querySelector('[data-act="hide"]'), hide);
  assert.equal(fakeDocument.activeElement, hide);
  assert.equal(hide.isConnected, true);
  assert.equal(readCounters().detached, 0);
  hide.dispatch('click');
  assert.equal(calls[0]?.entry.version, 8, 'retained controls use the latest snapshot version');
  assert.match(source, /subscribeBatched\(store, \(s\) => rerender\(root, \(\) => render\(s\), \{ morph: true \}\)\)/);
});
