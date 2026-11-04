import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageSession } from './session.ts';
import { FakePageSdk, OK_STATUS, flush, jsonResponse, makeDeps, sampleRow } from './testing.ts';
import { previewOf, toDisplayConversation } from './display.ts';
import type { AdapterDisplayPayload } from '../../ipc/src/adapterProtocol.ts';
const gid = '123456';
const msg = (type: number, body: string, time = 1700000000900) => ({msgId:`m-${time}`,msgtype:type,messageBody:body,fromJid:`cust-${gid}@im.x`,toJid:`${gid}@conf.x`,createTime:time});

test('raw detail message and summary-only types use official list summaries and message time', () => {
  assert.equal(toDisplayConversation({...sampleRow(gid),lastMessageJsonString:null,lastMessage:null,message:msg(0,'detail')} as never,false)?.preview,'detail');
  for (const [type, expected] of [[1,'[图片]'],[2,'[卡片]'],[3,'[视频]'],[4,'[语音]'],[5,'[文件]'],[6,'[位置]']] as const) assert.equal(previewOf(msg(type,'{}')),expected);
  for (const [action, expected] of [['CBZ03','[订单]'],['CBZ09','[语音]'],['CBZ04','[问答消息]'],['CBZ58','[商品]'],['CBZ59','[内容]']]) assert.equal(previewOf(msg(7,JSON.stringify({action}))),expected);
  assert.equal(toDisplayConversation(sampleRow(gid,{lastMessageJsonString:JSON.stringify(msg(0,'new')),lastMessageTime:null}) as never,false)?.last_message_time_ms,1700000000900);
});

for (const mode of ['history-refresh','detail-message'] as const) test(`list ${mode} updates an existing preview without opening the room`,async()=>{
  const displays:AdapterDisplayPayload[]=[];
  let detailVersion=0;
  const base=makeDeps(call=>jsonResponse(call.url.includes('getConversationList')
    ? {ResponseStatus:OK_STATUS,conversationList:[sampleRow(gid)],haveRest:false}
    : call.url.includes('getConversationInfoByGidList')
      ? {ResponseStatus:OK_STATUS,bizResponseStatus:{resultCode:'SUCCESS'},conversationInfoList:[{gid,unreadCount:2,message:mode==='detail-message'?msg(0,`detail-${++detailVersion}`,1700000001000+detailVersion):undefined}]}
      : call.url.includes('getMessageList') ? {ResponseStatus:OK_STATUS,rangeMessage:{isDone:true,messages:mode==='history-refresh'?[msg(4,'{}')]:[]}}
      : {ResponseStatus:OK_STATUS,members:[],messages:[],lastMessageTimestamp:1700000000000}));
  const sdk=new FakePageSdk(),session=createPageSession({...base,sdk},{sdk,selfUid:'me',account:{account_id:'list-parity',environment:'production',session_generation:1},initialEpoch:1,beginMsgTime:1700000000000,pushDisplay:async p=>{displays.push(p);}});
  session.start();try{
    await base.clock.advance(500);for(let i=0;i<20;i++)await flush();
    const latest=()=>displays.flatMap(p=>p.kind==='conversations'?p.items:[]).at(-1);
    assert.equal(latest()?.preview,mode==='history-refresh'?'[语音]':'detail-1');
    if(mode==='detail-message') {await base.clock.advance(5000);assert.equal(latest()?.preview,'detail-2','unchanged unread count still refreshes text');}
    assert.equal(sdk.readReceipts.length,0);
    assert.equal(displays.some(p=>p.kind==='messages'),false);
  }finally{session.stop();}
});

test('preview respects directional order-card hiding for the current merchant', () => {
  for (const [fromJid, ext] of [['me@x',{fromCardHide:'1'}],['customer@x',{toCardHide:'1'}]] as const) {
    assert.equal(previewOf({...msg(7,JSON.stringify({action:'CTL01',title:'hidden order',ext})),fromJid},'me'),'');
  }
});

test('voice and location SDK arrivals update list summaries without requiring thread components', async () => {
  const displays: AdapterDisplayPayload[] = [];
  const base = makeDeps(call => jsonResponse(call.url.includes('getConversationList') ? {ResponseStatus: OK_STATUS, conversationList: [sampleRow(gid)], haveRest:false} : {ResponseStatus:OK_STATUS,members:[],messages:[]}));
  const sdk = new FakePageSdk(), session = createPageSession({...base,sdk},{sdk,selfUid:'me',account:{account_id:'media-summary',environment:'production',session_generation:1},initialEpoch:1,beginMsgTime:1700000000000,pushDisplay:async p=>{displays.push(p);}});
  session.start(); try {
    await base.clock.advance(100);
    for (const [msgtype, expected] of [[4,'[语音]'],[6,'[位置]']] as const) {
      sdk.emit('message',{type:'groupchat',from:`${gid}@conf.x/cust-${gid}`,to:'me@x',id:`media-${msgtype}`,create_time:1700000001000+msgtype,msgtype,body:'{}'});
      for(let i=0;i<10;i++)await flush();
      assert.equal(displays.flatMap(p=>p.kind==='conversations'?p.items:[]).at(-1)?.preview,expected);
    }
    assert.equal(sdk.readReceipts.length,0);
  } finally {session.stop();}
});
