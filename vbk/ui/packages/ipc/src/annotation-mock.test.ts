import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMockIpc} from './mock.ts';
import {UiCommands, type UiAttachment, type UiAccountSnapshot, type UiConversation} from './client.ts';
import type {AnnotationSource} from './annotation.ts';
import {AccountCommands} from './commands.ts';

test('annotation demo keeps derived bytes independent of released source and never simulates a sent message', async () => {
  const ipc = createMockIpc('annotation', {latency:0,tick:false});
  const accounts = await ipc.invoke<UiAccountSnapshot>(AccountCommands.SNAPSHOT);
  const account = accounts.accounts[0]!.context;
  const conversations = await ipc.invoke<UiConversation[]>(UiCommands.IM_CONVERSATIONS,{account});
  const scope = {account,gid:conversations[0]!.gid};
  const attachment = await ipc.invoke<UiAttachment>(UiCommands.MEDIA_SCREENSHOT,scope);
  const request = {...scope,attachment_id:attachment.attachment_id};
  const source = await ipc.invoke<AnnotationSource>(UiCommands.MEDIA_ANNOTATION_SOURCE,request);
  assert.equal(source.mime,'image/png'); assert.equal(source.width,128); assert.equal(source.height,96);
  const derived = await ipc.invoke<UiAttachment>(UiCommands.MEDIA_ANNOTATION_APPLY,{...request,source_hash:source.source_hash,png_base64:source.data_base64,width:source.width,height:source.height,annotations:[]});
  assert.notEqual(derived.attachment_id,attachment.attachment_id);
  await ipc.invoke(UiCommands.MEDIA_RELEASE,request);
  await assert.rejects(ipc.invoke(UiCommands.MEDIA_ANNOTATION_SOURCE,request));
  const derivedScope = {...scope,attachment_id:derived.attachment_id};
  assert.equal((await ipc.invoke<AnnotationSource>(UiCommands.MEDIA_ANNOTATION_SOURCE,derivedScope)).source_hash,derived.content_sha256);
  await assert.rejects(ipc.invoke(UiCommands.MEDIA_ANNOTATION_SOURCE,{...derivedScope,account:accounts.accounts[1]!.context}));
  assert.deepEqual(await ipc.invoke(UiCommands.MEDIA_SAVE_ATTACHMENT,derivedScope),{saved:false});
  assert.equal((await ipc.invoke<{kind:string}>(UiCommands.IM_SEND_MEDIA,derivedScope)).kind,'not_submitted');
  ipc.dispose();
});
