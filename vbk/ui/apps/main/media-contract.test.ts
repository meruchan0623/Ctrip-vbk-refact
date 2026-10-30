import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { httpMessageToUi, sdkMessageToUi } from '../../packages/web-adapter/src/display.ts';
import { RoleBook } from '../../packages/web-adapter/src/stores.ts';
import * as vm from './viewmodel.ts';
import { messageAlignment } from './message-alignment.ts';
import { cx } from '../../packages/ui-kit/src/h.ts';
import type { UiMessage } from '../../packages/ipc/src/client.ts';
const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const scope = { environment: 'synthetic-env', account_id: 'synthetic-account', session_generation: 3 };
const gid = 'synthetic-room', serverId = '900719925474099312345', localId = '900719925474099312346';
const roles = new RoleBook('synthetic-self'); roles.addCustomer('synthetic-customer');
const image = 'https://dimg04.c-ctrip.com/synthetic-full.png', thumb = 'https://dimg04.c-ctrip.com/synthetic-thumb.png';
const video = 'https://media.ctrip.com/synthetic-video.mp4', cover = 'https://dimg04.c-ctrip.com/synthetic-cover.png';
const file = 'https://static.tripcdn.com/synthetic-file.pdf', filename = 'SYNTHETIC CONTRACT.pdf';
interface RenderNode { tag: string; props: Record<string, unknown>; children: unknown[] }
function nodes(tree: unknown): RenderNode[] { if (Array.isArray(tree)) return tree.flatMap(nodes); if (!tree || typeof tree !== 'object') return []; const n = tree as RenderNode; return [n, ...nodes(n.children ?? [])]; }
function render(message: UiMessage): RenderNode[] {
  const env: Record<string, unknown> = { ...vm, messageAlignment, cx, h: (tag: string, props: Record<string, unknown> | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }), document: {}, renderMessageAvatar: () => 'avatar', t: (k: string) => k, icon: () => null, IC: {} };
  const ka = source.indexOf('function mediaNodeKey('), kb = source.indexOf('\nfunction messageRow(', ka); assert.ok(ka >= 0 && kb > ka);
  env['mediaNodeKey'] = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(ka, kb)) + '\nreturn mediaNodeKey;')(...Object.values(env));
  const a = source.indexOf('function messageRow('), b = source.indexOf('\nfunction translationBar(', a);
  const row = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn messageRow;')(...Object.values(env));
  return nodes(row({ messages: { [gid]: [message] }, prefs: { general: { show_msg_time: false } } }, message, { gid, account: scope, title: 'Synthetic Customer', color: '#aaa' }, { context: scope }));
}
const cases = [
  { kind: 'image', msgtype: 1, body: { url: image, thumbUrl: thumb } },
  { kind: 'video', msgtype: 3, body: { video: { url: video, cover } } },
  { kind: 'file', msgtype: 5, body: { file: { url: file, filename } } },
] as const;
for (const transport of ['http', 'sdk'] as const) for (const fixture of cases) {
  test(`real ${transport} ${fixture.kind} mapper fields reach actual messageRow with exact long identities`, () => {
    const body = JSON.stringify(fixture.body);
    const message = transport === 'http'
      ? httpMessageToUi({ msgId: serverId, localId, msgtype: fixture.msgtype, fromJid: `${gid}@muc.synthetic/synthetic-customer`, toJid: 'synthetic-self@im.synthetic', createTime: 1800000000000, messageBody: body }, roles)
      : sdkMessageToUi({ id: serverId, localid: localId, msgtype: String(fixture.msgtype), type: 'groupchat', from: `${gid}@muc.synthetic/synthetic-customer`, to: 'synthetic-self@im.synthetic', create_time: '1800000000000', body }, roles);
    assert.ok(message); assert.equal(message.message_id, serverId); assert.equal(message.local_id, localId); assert.equal(message.gid, gid);
    const tree = render(message);
    assert.equal((tree[0]?.props['dataset'] as Record<string, unknown>)['mid'], localId);
    if (fixture.kind === 'image') {
      assert.equal(message.media_url, image); assert.equal(message.media_thumbnail, thumb);
      assert.equal(tree.find(n => n.tag === 'img')?.props['src'], thumb);
      assert.equal(tree.find(n => n.tag === 'a')?.props['href'], image);
    } else if (fixture.kind === 'video') {
      assert.equal(message.media_url, video); assert.equal(message.media_thumbnail, cover);
      const player = tree.find(n => n.tag === 'video'); assert.ok(player);
      assert.equal(player.props['src'], video); assert.equal(player.props['poster'], cover); assert.equal(player.props['controls'], true);
      assert.ok((player.props['dataset'] as Record<string, string>)['mediaKey']?.includes(serverId));
    } else {
      assert.equal(message.media_url, file); assert.equal(message.media_filename, filename);
      const link = tree.find(n => n.tag === 'a'); assert.ok(link);
      assert.equal(link.props['href'], file); assert.ok(link.children.includes(filename));
    }
  });
}
