import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { messageToolsText } from '../../packages/ui-kit/src/message-tools/strings.ts';

// Exercise the real controllers against a minimal DOM; writes remain synthetic.
class El {
  children: El[] = []; props: Record<string, any>; tag: string; textContent = ''; value = ''; open = false; disabled = false; isConnected = true;
  constructor(tag: string, props: Record<string, any> = {}, children: unknown[] = []) {
    this.tag = tag; this.props = props; this.value = props.value ?? ''; this.disabled = props.disabled === true;
    this.append(...children);
  }
  append(...items: unknown[]) { for (const item of items.flat(Infinity)) { if (item instanceof El) this.children.push(item); else if (typeof item === 'string') this.textContent += item; } }
  replaceChildren(...items: unknown[]) { this.children = []; this.textContent = ''; this.append(...items); }
  addEventListener(name: string, fn: Function) { this.props[`on${name}`] = fn; }
  querySelector<T extends El>(selector: string): T | null { return this.all().find(node => selector.split(', ').some(s => s.startsWith('.') ? String(node.props.class ?? '').split(' ').includes(s.slice(1)) : node.tag === s)) as T ?? null; }
  all(): El[] { return [this, ...this.children.flatMap(child => child.all())]; }
  focus() {} showModal() { this.open = true; } close() { this.open = false; } remove() { this.isConnected = false; }
}
const h = (tag: string, props: Record<string, any> | null, ...children: unknown[]) => new El(tag, props ?? {}, children);
const documentStub = { body: new El('body'), activeElement: null as El | null };
const source = readFileSync(new URL('./message-tools.ts', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
const controllers = new Function('h', 'document', 't', stripTypeScriptTypes(source) + '\nreturn { createForwardDialog, createSavedEmojiPanel };')(h, documentStub, messageToolsText);
const account = { account_id: 'a', environment: 'test', session_generation: 1 };
const conversation = (gid: string, revision = gid) => ({ gid, account, status: 'active', title: gid, assistant_context_revision: revision });
const message = { gid: 'source', message_id: 'm1', kind: 'text', text: 'Hello' };
const emoji = { id: 'e1', name: '喜悦', url: 'https://a.ctrip.com/1.png', thumbnail: null, rank: 1, created_at_ms: 1 };
const settle = () => new Promise(resolve => setImmediate(resolve));
function byClass(root: El, name: string): El { const item = root.all().find(node => String(node.props.class ?? '').split(' ').includes(name)); assert.ok(item, name); return item; }
function button(root: El, text: string): El { const item = root.all().find(node => node.tag === 'button' && node.textContent === text); assert.ok(item, text); return item; }
function newestDialog(): El { const node = [...documentStub.body.children].reverse().find(child => child.tag === 'dialog' && child.isConnected); assert.ok(node); return node; }

test('forward sends each selected target once and stops after account change during an in-flight write', async () => {
  let current = true, release!: (v: unknown) => void;
  const calls: any[] = [];
  const deps = { current: () => current, conversations: () => [conversation('source'), conversation('A'), conversation('B')],
    nextLocalId: () => `id-${calls.length}`, toast() {}, invoke: (command: string, payload: unknown) => { calls.push({command, payload}); return new Promise(resolve => { release = resolve; }); } };
  const control = controllers.createForwardDialog(deps); control.open(message, account);
  const dialog = newestDialog();
  for (const gid of ['A', 'B']) {
    const row = dialog.all().find(node => node.props.dataset?.gid === gid)!;
    row.children.find(node => node.tag === 'input')!.props.onchange({target: {checked: true}});
  }
  const send = byClass(dialog, 'message-tools-send'); send.props.onclick(); send.props.onclick();
  assert.equal(calls.length, 1); assert.equal(calls[0].payload.gid, 'A');
  current = false; release({kind: 'confirmed', server_message_id: '1', server_time_ms: 1}); await settle();
  assert.equal(calls.length, 1, 'stale account cannot dispatch the next target');
  control.close();
});

test('forward unknown outcome stays visible and cannot be resent from the same operation', async () => {
  const calls: any[] = [];
  const deps = { current: () => true, conversations: () => [conversation('source'), conversation('A')], nextLocalId: () => 'local-1', toast() {},
    invoke: async (command: string, payload: unknown) => { calls.push({command, payload}); return {kind: 'unknown'}; } };
  const control = controllers.createForwardDialog(deps); control.open(message, account); const dialog = newestDialog();
  const row = dialog.all().find(node => node.props.dataset?.gid === 'A')!; row.children.find(node => node.tag === 'input')!.props.onchange({target: {checked: true}});
  byClass(dialog, 'message-tools-send').props.onclick(); await settle();
  assert.equal(calls.length, 1); assert.ok(dialog.all().some(node => node.textContent.includes('结果未知')));
  byClass(dialog, 'message-tools-send').props.onclick(); await settle(); assert.equal(calls.length, 1);
  control.close();
});

test('emoji unknown send is not repeated and stale account blocks later actions', async () => {
  let current = true; const calls: any[] = [];
  const deps = { current: () => current, conversations: () => [conversation('A')], nextLocalId: () => 'emoji-1', toast() {},
    invoke: async (command: string, payload: unknown) => { calls.push({command, payload}); return command === 'im_saved_emojis' ? [emoji] : {kind: 'unknown'}; } };
  const control = controllers.createSavedEmojiPanel(deps); await control.open(account, 'A'); const dialog = newestDialog();
  const item = byClass(dialog, 'saved-emoji-item'); item.props.onclick(); await settle();
  item.props.onclick(); await settle(); assert.equal(calls.filter(c => c.command === 'im_send_saved_emoji').length, 1);
  current = false; await control.add({...message, kind: 'image'}, account); assert.equal(calls.length, 2);
  control.close();
});

test('double click forwards to just one selected active conversation', async () => {
  const calls: any[] = [], notices: string[] = [];
  const deps = { current: () => true, conversations: () => [conversation('source'), conversation('A'), conversation('B')], nextLocalId: () => 'double-1', toast: (text: string) => notices.push(text),
    invoke: async (command: string, payload: unknown) => { calls.push({command, payload}); return {kind: 'confirmed', server_message_id: '1', server_time_ms: 1}; } };
  const control = controllers.createForwardDialog(deps); control.open(message, account); const dialog = newestDialog();
  const row = dialog.all().find(node => node.props.dataset?.gid === 'B')!;
  row.props.ondblclick({preventDefault() {}}); await settle();
  assert.equal(calls.length, 1); assert.equal(calls[0].payload.gid, 'B'); assert.ok(!dialog.isConnected); assert.ok(notices[0]?.includes('1'));
});

test('destination revision change prevents dispatch', async () => {
  const calls: any[] = []; let rev = 'A';
  const deps = { current: () => true, conversations: () => [conversation('source'), conversation('A', rev)], nextLocalId: () => 'local-1', toast() {},
    invoke: async (command: string, payload: unknown) => { calls.push({command, payload}); return {kind: 'unknown'}; } };
  const control = controllers.createForwardDialog(deps); control.open(message, account); const dialog = newestDialog();
  const row = dialog.all().find(node => node.props.dataset?.gid === 'A')!; row.children.find(node => node.tag === 'input')!.props.onchange({target: {checked: true}});
  rev = 'new-context'; byClass(dialog, 'message-tools-send').props.onclick(); await settle();
  assert.equal(calls.length, 0); assert.ok(dialog.all().some(node => node.textContent.includes('会话已变化')));
  control.close();
});
