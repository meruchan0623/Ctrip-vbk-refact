import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMemberRoles } from './facts.ts';
import { httpMessageToUi, previewOf, sdkMessageToUi } from './display.ts';

const roles = buildMemberRoles({ selfUid: 'agent', customerUid: 'customer', members: [] });
const time = 1793689482000;

function project(msgtype: number, body: unknown, sender = 'customer') {
  const messageBody = JSON.stringify(body);
  const row = { msgId: 'm', msgtype, messageBody, fromJid: `room@conf/${sender}`, createTime: time };
  const evt = { id: 'm', type: 'groupchat', msgtype: String(msgtype), body: messageBody, from: row.fromJid, create_time: time };
  return { row, http: httpMessageToUi(row, roles), sdk: sdkMessageToUi(evt, roles) };
}

test('plain JSON chat text cannot hide itself through protocol-like visibility fields', () => {
  for (const body of [{ isPresent: false }, { ext: { visibleRule: 0 } }, { action: 'CTL01', ext: { toCardHide: '1' } }]) {
    const { row, http, sdk } = project(0, body);
    for (const message of [http, sdk]) {
      assert.ok(message);
      assert.equal(message.text, JSON.stringify(body));
    }
    assert.equal(previewOf(row), JSON.stringify(body));
  }
});

test('desktop visibility mask consistently filters custom history, realtime and previews', () => {
  // Desktop va/Ph give a numeric mask precedence over isPresent.
  for (const msgtype of [7, 1007]) {
    for (const visibleRule of [0, 1, 2, 3, 8]) {
      const { row, http, sdk } = project(msgtype, { title: 'other surfaces only', isPresent: true, ext: { visibleRule } });
      assert.equal(http, null, `${msgtype}/${visibleRule} HTTP`);
      assert.equal(sdk, null, `${msgtype}/${visibleRule} SDK`);
      assert.equal(previewOf(row), '');
    }
    for (const visibleRule of [4, 5, 7]) {
      const { row, http, sdk } = project(msgtype, { title: 'vendor content', isPresent: false, ext: { visibleRule } });
      assert.equal(http?.text, 'vendor content');
      assert.equal(sdk?.text, 'vendor content');
      assert.equal(previewOf(row), 'vendor content');
    }
  }
});

test('NBZ37 preserves desktop visibility exception; nonnumeric masks use isPresent', () => {
  const exception = project(1007, { title: 'risk notice', action: 'NBZ37', isPresent: false, ext: { visibleRule: 0 } });
  assert.equal(exception.http?.text, 'risk notice');
  assert.equal(exception.sdk?.text, 'risk notice');
  assert.equal(previewOf(exception.row), 'risk notice');
  const hidden = project(7, { title: 'hidden', isPresent: false, ext: { visibleRule: '4' } });
  assert.equal(hidden.http, null);
  assert.equal(hidden.sdk, null);
});

test('CTL01 directional hide flags follow the effective sender and current account identity', () => {
  for (const value of ['1', 1]) {
    for (const sender of ['agent', 'AGENT']) {
      const own = project(7, { action: 'CTL01', title: 'own hidden card', ext: { fromCardHide: value } }, sender);
      assert.equal(own.http, null);
      assert.equal(own.sdk, null);
    }
    const incoming = project(7, { action: 'CTL01', title: 'incoming hidden card', ext: { toCardHide: value } });
    assert.equal(incoming.http, null);
    assert.equal(incoming.sdk, null);
    const replaced = project(7, { action: 'CTL01', title: 'relayed own card', ext: { fromCardHide: value, replaceSender: 'agent' } }, 'relay');
    assert.equal(replaced.http, null);
    assert.equal(replaced.sdk, null);
  }
  // Hide flags apply only to the corresponding side, and only to CTL01.
  for (const body of [
    { action: 'CTL01', title: 'visible incoming', ext: { fromCardHide: '1' } },
    { action: 'CBZ06', title: 'visible text', ext: { toCardHide: '1' } },
  ]) {
    assert.ok(project(7, body).http);
    assert.ok(project(7, body).sdk);
  }
});

test('card-message text is not governed by custom-content metadata', () => {
  const { row, http, sdk } = project(2, { title: 'card title', isPresent: false, ext: { visibleRule: 0 } });
  assert.equal(http?.text, 'card title');
  assert.equal(sdk?.text, 'card title');
  assert.equal(previewOf(row), '[卡片]');
});
