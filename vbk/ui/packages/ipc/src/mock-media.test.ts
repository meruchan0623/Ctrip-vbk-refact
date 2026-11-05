import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createMockIpc } from './mock.ts';
import { UiCommands, type UiAccountSnapshot, type UiAttachment } from './client.ts';
import { ErrorCodes, isAppError } from './contracts.ts';
import { AccountCommands } from './commands.ts';
import { t } from '../../ui-kit/src/i18n.ts';
import { errorMessage } from '../../../apps/main/viewmodel.ts';
import { isRegisteredMediaAttachment } from '../../../apps/main/sendComposer.ts';

for (const [command, message] of [
  [UiCommands.IM_MEMBERS, '示例模式未连接官方成员与话术接口'],
] as const) test(`default mock ${command} refuses explicitly and its real main invokeSafe displays the stable explanation`, async () => {
  const ipc = createMockIpc('default', { latency: 0, tick: false });
  try {
    const account = (await ipc.invoke<UiAccountSnapshot>(AccountCommands.SNAPSHOT)).accounts[0]!.context;
    const args = { account, gid: 'g-demo-1', kind: 'image' };
    await assert.rejects(ipc.invoke(command, args), error => {
      assert.ok(isAppError(error)); assert.equal(error.code, ErrorCodes.HOST_UNSUPPORTED);
      assert.equal(error.message, message); assert.equal(error.retryable, false); return true;
    });
    const source = readFileSync(new URL('../../../apps/main/main.ts', import.meta.url), 'utf8');
    const start = source.indexOf('async function invokeSafe'), end = source.indexOf('\n/** Background read:', start);
    assert.ok(start >= 0 && end > start);
    const notices: string[] = [];
    const invokeSafe = new Function('ipc', 't', 'errorMessage', 'toast', stripTypeScriptTypes(source.slice(start, end)) + '\nreturn invokeSafe;')(ipc, t, errorMessage, (text: string) => notices.push(text)) as (command: string, payload: unknown) => Promise<unknown>;
    assert.equal(await invokeSafe(command, args), null);
    assert.deepEqual(notices, [`失败：${message}`]);
  } finally { ipc.dispose(); }
});


test('media-draft scenario picks a clearly named registered synthetic PNG and never simulates a sent message', async () => {
  const ipc = createMockIpc('media-draft', { latency: 0, tick: false });
  try {
    const accounts = (await ipc.invoke<UiAccountSnapshot>(AccountCommands.SNAPSHOT)).accounts;
    const account = accounts[0]!.context;
    const scope = { account, gid: 'g-demo-1' };
    const attachment = await ipc.invoke<UiAttachment>(UiCommands.MEDIA_PICK, { ...scope, kind: 'image' });
    assert.ok(isRegisteredMediaAttachment(attachment));
    assert.equal(attachment.name, '演示图片.png'); assert.equal(attachment.kind, 'image'); assert.equal(attachment.mime, 'image/png');
    assert.deepEqual(attachment.owner, scope);
    const handle = { ...scope, attachment_id: attachment.attachment_id };
    assert.equal((await ipc.invoke<{ kind: string }>(UiCommands.IM_SEND_MEDIA, handle)).kind, 'not_submitted');
    await assert.rejects(ipc.invoke(UiCommands.MEDIA_RELEASE, { ...handle, account: accounts[1]!.context }), 'a foreign account cannot release this handle');
    await ipc.invoke(UiCommands.MEDIA_RELEASE, handle);
    await assert.rejects(ipc.invoke(UiCommands.IM_DRAFT_ATTACHMENT_SAVE, { ...handle, expected_version: 0 }), 'a released handle cannot enter a draft');
  } finally { ipc.dispose(); }
});
