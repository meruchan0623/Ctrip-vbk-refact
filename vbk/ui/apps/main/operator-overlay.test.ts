import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOperatorOverlay, operatorGrant, operatorRect, OPERATOR_ORIGIN, OPERATOR_TIMEOUT_MS } from './operator-overlay.ts';
import type { UiTsimOperatorGrant } from '../../packages/ipc/src/client.ts';

class Events {
  listeners = new Map<string, Set<(value: any) => void>>();
  addEventListener(type: string, fn: (value: any) => void) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(fn); }
  removeEventListener(type: string, fn: (value: any) => void) { this.listeners.get(type)?.delete(fn); }
  dispatch(type: string, data: unknown = {}) { for (const fn of this.listeners.get(type) ?? []) fn(data); }
}
class Element extends Events {
  children: Element[] = []; parent: Element | null = null; style: Record<string, string> = {}; id = ''; title = ''; type = ''; src = ''; referrerPolicy = ''; textContent = '';
  attributes = new Map<string, string>(); outbox: { value: Record<string, unknown>; target: string }[] = [];
  contentWindow = { postMessage: (value: Record<string, unknown>, target: string) => this.outbox.push({ value, target }) };
  readonly owner: FakeDocument;
  constructor(owner: FakeDocument) { super(); this.owner = owner; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  append(...items: Element[]) { for (const item of items) { item.remove(); item.parent = this; this.children.push(item); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); this.parent = null; }
  get isConnected() { return this.parent !== null; }
  focus() { this.owner.activeElement = this; }
}
class View extends Events {
  innerWidth = 1200; innerHeight = 800; timers = new Map<number, () => void>();
  setTimeout(fn: () => void, _ms: number) { const id = this.timers.size + 1; this.timers.set(id, fn); return id; }
  clearTimeout(id?: number) { if (id !== undefined) this.timers.delete(id); }
  advance(_ms: number) { for (const [id,fn] of [...this.timers]) { this.timers.delete(id); fn(); } }
}
class FakeDocument extends Events {
  defaultView = new View(); body = new Element(this); activeElement: Element | null = null; visibilityState = 'visible';
  createElement(_tag: string) { return new Element(this); }
}
const request = '00000000-0000-4000-8000-000000000001';
const grant: UiTsimOperatorGrant = { url: `${OPERATOR_ORIGIN}/embed/operator?source=travel-merchant-companion&session=handoff&identifier=1234567890&identifierType=order_number&requestId=${request}`, identifier: '1234567890', request_id: request, session_epoch: 2, access_token: 'synthetic-no-real-token', session_ref: null };
function fixture() {
  const doc = new FakeDocument(), overlay = createOperatorOverlay(doc as unknown as Document);
  let current = true;
  overlay.open(grant, () => current);
  const frame = overlay.frame as unknown as Element;
  const send = (data: Record<string, unknown>, origin = OPERATOR_ORIGIN, source: unknown = frame.contentWindow) => doc.defaultView.dispatch('message', { data, origin, source });
  const needs = { type: 'TSIM_OPERATOR_NEEDS_SESSION', version: 2, identifier: grant.identifier, requestId: request };
  return { doc, overlay, frame, send, needs, invalidate: () => { current = false; } };
}

test('grant validation rejects wrong destinations, credentials in URL, extra/duplicate parameters and mismatched scope', () => {
  assert.ok(operatorGrant(grant));
  const iccid = '8965012512295895417', iccidGrant = { ...grant, identifier: iccid, url: grant.url.replace('identifier=1234567890', `identifier=${iccid}`).replace('order_number', 'iccid') };
  assert.ok(operatorGrant(iccidGrant), 'ICCID grant with identifierType=iccid');
  assert.ok(!operatorGrant({ ...iccidGrant, url: iccidGrant.url.replace('iccid&', 'order_number&') }), 'type must match the identifier');
  assert.ok(!operatorGrant({ ...grant, url: grant.url.replace('order_number', 'iccid') }), 'order number cannot masquerade as iccid');
  for (const invalid of [{ ...grant, url: grant.url.replace(OPERATOR_ORIGIN, 'https://evil.example') }, { ...grant, url: grant.url.replace('https://', 'https://user@') }, { ...grant, url: `${grant.url}&secret=bad` }, { ...grant, url: `${grant.url}&requestId=${request}` }, { ...grant, identifier: '9999999999' }, { ...grant, access_token: '' }]) assert.equal(operatorGrant(invalid), false);
});
test('the bearer is sent only to this exact frame, origin and V2 request', () => {
  const f = fixture();
  f.send(f.needs, 'https://evil.example'); f.send(f.needs, OPERATOR_ORIGIN, {});
  f.send({ ...f.needs, requestId: 'stale' }); f.send({ ...f.needs, identifier: '9999999999' });
  f.send({ ...f.needs, version: 1 }); assert.equal(f.frame.outbox.length, 0);
  f.send(f.needs);
  assert.deepEqual(f.frame.outbox, [{ target: OPERATOR_ORIGIN, value: { ...f.needs, type: 'TSIM_OPERATOR_SESSION', accessToken: grant.access_token, sessionRef: null } }]);
  assert.equal(f.frame.src.includes(grant.access_token), false);
});
test('an invalidated scope destroys the frame before any handoff, and reopened orders get a fresh source', () => {
  const f = fixture(); f.invalidate(); f.send(f.needs); assert.equal(f.overlay.frame, null); assert.equal(f.frame.outbox.length, 0);
  f.overlay.open(grant, () => true); assert.notEqual(f.overlay.frame, f.frame); assert.equal(f.frame.isConnected, false);
  f.overlay.close(); assert.equal(f.overlay.frame, null); assert.equal(f.doc.body.children.length, 0);
});
test('timeout and login fallback refuse late credentials while leaving an explicit close control', () => {
  const f = fixture(); f.frame.dispatch('load'); f.doc.defaultView.advance(OPERATOR_TIMEOUT_MS); f.send(f.needs);
  assert.equal(f.frame.outbox[0]!.value.type, 'TSIM_OPERATOR_SESSION_UNAVAILABLE');
  const status = f.doc.body.children.find(n => n.id === 'tsim-operator-loading')!;
  assert.match(status.children[0]!.textContent, /登录/); status.children[1]!.dispatch('click'); assert.equal(f.overlay.frame, null);
});
test('slow document loading does not expire the session before the embedded app starts', () => {
  const f = fixture(); f.doc.defaultView.advance(OPERATOR_TIMEOUT_MS);
  f.send(f.needs);
  assert.equal(f.frame.outbox[0]!.value.type, 'TSIM_OPERATOR_SESSION');
  f.frame.dispatch('load');
  assert.equal(f.doc.defaultView.timers.size, 0, 'a handoff before load must not arm a stale deadline');
});
test('a loaded document can request its session within the handshake deadline', () => {
  const f = fixture(); f.frame.dispatch('load'); f.send(f.needs);
  assert.equal(f.doc.defaultView.timers.size, 0);
  assert.equal(f.frame.outbox[0]!.value.type, 'TSIM_OPERATOR_SESSION');
  f.send({ ...f.needs, type: 'TSIM_OPERATOR_NEEDS_LOGIN' }); f.send(f.needs);
  assert.equal(f.frame.outbox[1]!.value.type, 'TSIM_OPERATOR_SESSION_UNAVAILABLE');
});
test('geometry is clipped to the viewport, invalid bounds cannot hide the close control', () => {
  assert.deepEqual(operatorRect({ x: -10, y: -20, width: 100, height: 100 }, 1200, 800), { x: 0, y: 0, width: 90, height: 80 });
  assert.equal(operatorRect({ x: 0, y: 0, width: NaN, height: 10 }, 1200, 800), null);
  const f = fixture(); f.send({ type: 'TSIM_OPERATOR_BOUNDS', version: 1, identifier: grant.identifier, rect: { x: 100, y: 50, width: 300, height: 400 } });
  assert.equal(f.frame.style.left, '-100px'); assert.equal(f.frame.style.width, '1200px');
  f.doc.visibilityState = 'hidden'; f.doc.dispatch('visibilitychange'); assert.ok(f.overlay.frame);
  f.doc.defaultView.dispatch('pagehide'); assert.equal(f.overlay.frame, null);
});
