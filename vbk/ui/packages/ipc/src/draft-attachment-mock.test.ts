import test from 'node:test';
import assert from 'node:assert/strict';
import {createMockIpc} from './mock.ts';
import {UiCommands, type UiAccountSnapshot, type UiAttachment, type UiDraftAttachmentSnapshot} from './client.ts';
import {AccountCommands, ImCommands} from './commands.ts';

test('attachment draft survives handle release; restores a fresh handle and keeps text CAS independent', async () => {
  const ipc=createMockIpc('media-draft',{latency:0,tick:false});
  try {
    const account=(await ipc.invoke<UiAccountSnapshot>(AccountCommands.SNAPSHOT)).accounts[0]!.context;
    const gid='g-demo-1',owner={account,gid};
    const original=await ipc.invoke<UiAttachment>(UiCommands.MEDIA_PICK,{...owner,kind:'image'});
    const selected=await ipc.invoke<UiDraftAttachmentSnapshot>(UiCommands.IM_DRAFT_ATTACHMENT_SAVE,{...owner,attachment_id:original.attachment_id,expected_version:0});
    await ipc.invoke(ImCommands.DRAFT_SAVE,{...owner,text:'保留文字',expected_version:0});
    await ipc.invoke(UiCommands.MEDIA_RELEASE,{...owner,attachment_id:original.attachment_id});
    const restored=await ipc.invoke<UiAttachment>(UiCommands.IM_DRAFT_ATTACHMENT_RESTORE,{...owner,lease_id:selected.attachments[0]!.lease_id});
    assert.notEqual(restored.attachment_id,original.attachment_id);
    assert.equal(restored.lease_id,original.lease_id);
    await assert.rejects(ipc.invoke(UiCommands.IM_DRAFT_ATTACHMENT_SAVE,{...owner,attachment_id:null,expected_version:0}));
    await ipc.invoke(UiCommands.IM_DRAFT_ATTACHMENT_SAVE,{...owner,attachment_id:null,expected_version:1});
    const result=await ipc.invoke<{drafts:Array<{gid:string;text:string;version:number;attachment_version:number;attachments:unknown[]}>}>(ImCommands.DRAFT_LOAD,{account});
    const draft=result.drafts.find(row=>row.gid===gid)!;
    assert.equal(draft.text,'保留文字');assert.equal(draft.version,1);
    assert.equal(draft.attachment_version,2);assert.deepEqual(draft.attachments,[]);
    await assert.rejects(ipc.invoke(UiCommands.IM_DRAFT_ATTACHMENT_RESTORE,{...owner,lease_id:original.lease_id}));
  } finally {ipc.dispose();}
});

test('persistent mock attachment cannot be restored into another conversation or account', async () => {
  const ipc=createMockIpc('media-draft',{latency:0,tick:false});
  try {
    const accounts=(await ipc.invoke<UiAccountSnapshot>(AccountCommands.SNAPSHOT)).accounts;
    const account=accounts[0]!.context,gid='g-demo-1';
    const image=await ipc.invoke<UiAttachment>(UiCommands.MEDIA_PICK,{account,gid,kind:'image'});
    await ipc.invoke(UiCommands.IM_DRAFT_ATTACHMENT_SAVE,{account,gid,attachment_id:image.attachment_id,expected_version:0});
    await assert.rejects(ipc.invoke(UiCommands.IM_DRAFT_ATTACHMENT_RESTORE,{account,gid:'g-demo-2',lease_id:image.lease_id}));
    await assert.rejects(ipc.invoke(UiCommands.IM_DRAFT_ATTACHMENT_RESTORE,{account:accounts[1]!.context,gid,lease_id:image.lease_id}));
  }finally{ipc.dispose();}
});
