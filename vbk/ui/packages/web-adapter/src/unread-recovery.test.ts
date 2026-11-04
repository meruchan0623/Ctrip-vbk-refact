import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationStore, UnreadBook } from './stores.ts';
import { makeDeps, jsonResponse, OK_STATUS, sampleRow } from './testing.ts';
import { SoaClient } from './soa.ts';
const gid = '123456';
const message = (msgId: string, createTime: number, fromJid = `cust-${gid}@im.x`, room = gid) => ({msgId, createTime, fromJid, toJid: `${room}@conf.x`, msgtype: 0, messageBody: 'synthetic'});

test('scope-checked history recovers peer target behind a self reply without crossing the row snapshot', () => {
  const store = new ConversationStore();
  store.update([sampleRow(gid, {lastMessageJsonString: JSON.stringify(message('own', 1700000000500, 'me@im.x'))})]);
  assert.equal(store.readTarget(gid), null);
  store.noteReadHistory(gid, [message('peer', 1700000000300),message('new-unseen', 1700000000600),message('other-room', 1700000000400, `cust-${gid}@im.x`, '654321')]);
  assert.equal(store.readTarget(gid)?.msgId, 'peer');
  store.update([sampleRow(gid, {sessionId:'new-service',lastMessageJsonString:JSON.stringify(message('new-own',1700000000800,'me@im.x'))})]);
  assert.equal(store.readTarget(gid), null);
});

test('acknowledged consumption suppresses lagging counts but a new message restores unread', async () => {
  let current = message('own', 1700000000500, 'me@im.x');
  const deps = makeDeps(() => jsonResponse({ResponseStatus:OK_STATUS,bizResponseStatus:{resultCode:'SUCCESS'},conversationInfoList:[{gid,unreadCount:3,message:current}]}));
  const book = new UnreadBook();book.set(gid,3);
  assert.equal(book.acknowledge(gid,{msgId:current.msgId,createTime:current.createTime}),true);
  assert.equal(book.unreadOf(gid),0);
  await book.refresh(deps,new SoaClient(deps),[gid]); assert.equal(book.unreadOf(gid),0);
  current=message('new-peer',1700000000600);
  await book.refresh(deps,new SoaClient(deps),[gid]); assert.equal(book.unreadOf(gid),3);
  book.acknowledge(gid,{msgId:current.msgId,createTime:current.createTime});book.invalidate(gid);
  await book.refresh(deps,new SoaClient(deps),[gid]);assert.equal(book.unreadOf(gid),3);
});

test('different messages at the same timestamp are not swallowed by a read watermark', async () => {
  const deps=makeDeps(()=>jsonResponse({ResponseStatus:OK_STATUS,bizResponseStatus:{resultCode:'SUCCESS'},conversationInfoList:[{gid,unreadCount:1,message:message('new',1700000000500)}]}));
  const book=new UnreadBook();book.acknowledge(gid,{msgId:'old',createTime:1700000000500});
  await book.refresh(deps,new SoaClient(deps),[gid]);assert.equal(book.unreadOf(gid),1);
});

import { createPageSession } from './session.ts';
import { FakePageSdk, flush } from './testing.ts';
import type { AdapterDisplayPayload } from '../../ipc/src/adapterProtocol.ts';
for (const system of [false, true]) test(`real session recovers a peer behind ${system ? 'system' : 'self'}, clears acked badge, and restores new unread`, async () => {
  let newest = { ...message('last',1700000000500,system?'system@im.x':'me@im.x'), ...(system? {msgtype:1007,messageBody:JSON.stringify({title:'system notice',isPresent:true})}: {}) };
  const peer=message('peer',1700000000300), displays:AdapterDisplayPayload[]=[];
  const base=makeDeps(call=>jsonResponse(call.url.includes('getConversationList')
    ? {ResponseStatus:OK_STATUS,conversationList:[sampleRow(gid,{lastMessageJsonString:JSON.stringify(newest)})],haveRest:false}
    : call.url.includes('getConversationInfoByGidList')
      ? {ResponseStatus:OK_STATUS,bizResponseStatus:{resultCode:'SUCCESS'},conversationInfoList:[{gid,unreadCount:3,message:newest}]}
      : call.url.includes('getMessageList')
        ? {ResponseStatus:OK_STATUS,rangeMessage:{isDone:true,messages:[peer,newest]}}
        : {ResponseStatus:OK_STATUS,members:[],messages:[],lastMessageTimestamp:1700000000000}));
  const sdk=new FakePageSdk();
  const session=createPageSession({...base,sdk},{sdk,selfUid:'me',account:{account_id:'test',environment:'production',session_generation:1},initialEpoch:1,beginMsgTime:1700000000000,pushDisplay:async p=>{displays.push(p);}});
  const settle=async()=>{for(let i=0;i<25;i++) await flush();};
  const last=()=>displays.flatMap(p=>p.kind==='conversations'?p.items:[]).at(-1);
  session.start();
  try {
    await base.clock.advance(1000);await settle();
    assert.equal(sdk.readReceipts.length,0,'background reads do not consume messages');
    const history=await session.rpc.handle({req_id:'history',op:'im.messages',args:{gid}});
    assert.equal(history?.ok,true,JSON.stringify(history));await settle();
    assert.equal(last()?.read_target_message_id,'peer');
    assert.equal(last()?.unread_count,3);
    const revision=session.store.assistantContextRevision(gid,'me',sdk.partnerJidOf(gid))!;
    const receipt=await session.rpc.handle({req_id:'read',op:'im.mark_read',args:{gid,expected_message_id:'peer',expected_context_revision:revision}});
    assert.equal(receipt?.ok,true,JSON.stringify(receipt));await settle();
    assert.equal(last()?.unread_count,0);
    await base.clock.advance(1000);await settle();assert.equal(last()?.unread_count,0,'lagging server detail cannot resurrect badge');
    newest=message('new-peer',1700000000900);
    await base.clock.advance(6000);await settle();
    assert.equal(last()?.unread_count,3,'new unseen message restores the badge');
    assert.equal(sdk.readReceipts.length,1,'new message is not automatically consumed in the background');
  } finally {session.stop();}
});

test('history cannot restore an old service peer below the observed switch fence or from a conflicting thread', () => {
  const store = new ConversationStore();
  store.update([sampleRow(gid,{sessionId:'old-service',threadId:'old-thread',lastMessageTime:1700000000300,lastMessageJsonString:JSON.stringify({...message('old-peer',1700000000300),threadId:'old-thread'})})]);
  store.update([sampleRow(gid,{sessionId:'new-service',threadId:'new-thread',lastUpdateTime:1700000000800,lastMessageTime:1700000000800,lastMessageJsonString:JSON.stringify({...message('new-self',1700000000800,'me@im.x'),threadId:'new-thread'})})]);
  assert.equal(store.readTarget(gid),null);
  store.noteReadHistory(gid,[{...message('old-peer',1700000000300),threadId:'old-thread'},{...message('old-thread-new-time',1700000000800),threadId:'old-thread'}]);
  assert.equal(store.readTarget(gid),null,'neither stale time nor stale thread can cross the observed service boundary');
});

test('a new SDK peer arriving while an old receipt is in flight keeps the unread badge', async () => {
  const displays:AdapterDisplayPayload[]=[];
  const peer=message('peer',1700000000500);
  const base=makeDeps(call=>jsonResponse(call.url.includes('getConversationList')
    ? {ResponseStatus:OK_STATUS,conversationList:[sampleRow(gid,{lastMessageJsonString:JSON.stringify(peer)})],haveRest:false}
    : call.url.includes('getConversationInfoByGidList')
      ? {ResponseStatus:OK_STATUS,bizResponseStatus:{resultCode:'SUCCESS'},conversationInfoList:[{gid,unreadCount:3,message:peer}]}
      : call.url.includes('getMessageList') ? {ResponseStatus:OK_STATUS,rangeMessage:{isDone:true,messages:[peer]}}
      : {ResponseStatus:OK_STATUS,members:[],messages:[],lastMessageTimestamp:1700000000000}));
  const sdk=new FakePageSdk();
  sdk.putAdviceOfReadByMsgId=async()=>{
    sdk.emit('message',{type:'groupchat',id:'new-sdk-peer',from:`${gid}@conf.x/cust-${gid}`,to:'me@im.x',msgtype:0,create_time:1700000000900,body:'new unseen customer message'});
    await flush();return {kind:'success',raw:{}};
  };
  const session=createPageSession({...base,sdk},{sdk,selfUid:'me',account:{account_id:'flight',environment:'production',session_generation:1},initialEpoch:1,beginMsgTime:1700000000000,pushDisplay:async p=>{displays.push(p);}});
  session.start();
  try {
    await base.clock.advance(1000);for(let i=0;i<20;i++)await flush();
    const revision=session.store.assistantContextRevision(gid,'me',sdk.partnerJidOf(gid))!;
    const result=await session.rpc.handle({req_id:'old-ack',op:'im.mark_read',args:{gid,expected_message_id:'peer',expected_context_revision:revision}});
    assert.equal(result?.ok,true);
    for(let i=0;i<20;i++)await flush();
    assert.equal(session.unread.unreadOf(gid),3,'old confirmed receipt must not consume a newer SDK arrival');
    assert.equal(displays.flatMap(p=>p.kind==='conversations'?p.items:[]).at(-1)?.unread_count,3);
  }finally{session.stop();}
});

test('a scoped late peer before the latest self snapshot advances the read frontier and can subsequently be consumed', async () => {
  const peer=message('peer300',1700000000300),own=message('self900',1700000000900,'me@im.x');
  const displays:AdapterDisplayPayload[]=[];
  const base=makeDeps(call=>jsonResponse(call.url.includes('getConversationList')
    ? {ResponseStatus:OK_STATUS,conversationList:[sampleRow(gid,{lastMessageTime:own.createTime,lastMessageJsonString:JSON.stringify(own)})],haveRest:false}
    : call.url.includes('getConversationInfoByGidList')
      ? {ResponseStatus:OK_STATUS,bizResponseStatus:{resultCode:'SUCCESS'},conversationInfoList:[{gid,unreadCount:3,message:own}]}
      : call.url.includes('getMessageList') ? {ResponseStatus:OK_STATUS,rangeMessage:{isDone:true,messages:[peer,own]}}
      : {ResponseStatus:OK_STATUS,members:[],messages:[],lastMessageTimestamp:1700000000000}));
  const sdk=new FakePageSdk();
  const session=createPageSession({...base,sdk},{sdk,selfUid:'me',account:{account_id:'latepeer',environment:'production',session_generation:1},initialEpoch:1,beginMsgTime:1700000000000,pushDisplay:async p=>{displays.push(p);}});
  const settle=async()=>{for(let i=0;i<20;i++)await flush();};
  session.start();
  try {
    await base.clock.advance(1000);await settle();
    await session.rpc.handle({req_id:'history',op:'im.messages',args:{gid}});await settle();
    assert.equal(session.store.readTarget(gid)?.msgId,'peer300');
    sdk.emit('message',{type:'groupchat',id:'peer850',from:`${gid}@conf.x/cust-${gid}`,to:'me@im.x',msgtype:0,create_time:1700000000850,body:'late scoped peer'});
    await settle();
    assert.equal(session.store.readTarget(gid)?.msgId,'peer850');
    assert.equal(displays.flatMap(p=>p.kind==='conversations'?p.items:[]).at(-1)?.read_target_message_id,'peer850');
    const revision=session.store.assistantContextRevision(gid,'me',sdk.partnerJidOf(gid))!;
    const old=await session.rpc.handle({req_id:'old',op:'im.mark_read',args:{gid,expected_message_id:'peer300',expected_context_revision:revision}});
    assert.equal(old?.ok,false);assert.equal(session.unread.unreadOf(gid),3);
    const next=await session.rpc.handle({req_id:'new',op:'im.mark_read',args:{gid,expected_message_id:'peer850',expected_context_revision:revision}});
    assert.equal(next?.ok,true,JSON.stringify(next));await settle();
    assert.equal(session.unread.unreadOf(gid),0);
    assert.deepEqual(sdk.readReceipts.map(r=>r.msgId),['peer850']);
  } finally {session.stop();}
});
