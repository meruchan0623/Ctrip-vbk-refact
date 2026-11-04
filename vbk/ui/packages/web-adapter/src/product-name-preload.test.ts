import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProductNameCache } from './product-name-cache.ts';
import { createPageSession } from './session.ts';
import { FakePageSdk, makeDeps, sampleRow, jsonResponse, OK_STATUS, flush } from './testing.ts';
import type { AdapterDisplayPayload } from '../../ipc/src/adapterProtocol.ts';
const memory = () => {const data=new Map<string,string>();return {getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);}};};
const source = (product:string) => ({ResponseStatus:OK_STATUS,data:{sourceTraceInfo:{hasSourceTracePrivilege:true,lastSourceTrace:{msg:JSON.stringify({action:'CTL01',ext:{dataInfoList:[{Id:'orderid',text:'1234567890'},{Id:'productName',text:product}]}})}}}});
async function settle(){for(let i=0;i<30;i++)await flush();}
function fixture(storage:ReturnType<typeof memory>,hold=false,account='account-A') {
  const requests:string[]=[],displays:AdapterDisplayPayload[]=[];let release=()=>{};
  const base=makeDeps(call=>{
    if(call.url.includes('getConversationList'))return jsonResponse({ResponseStatus:OK_STATUS,conversationList:[sampleRow('1'),sampleRow('2')],haveRest:false});
    if(call.url.includes('getVbkImUserinfo')){
      const gid=(call.bodyJson as {gid:string}).gid;requests.push(gid);
      if(hold && requests.length===1)return new Promise(resolve=>{release=()=>resolve(jsonResponse(source(`产品-${gid}`)));});
      return jsonResponse(source(`产品-${gid}`));
    }
    return jsonResponse({ResponseStatus:OK_STATUS,members:[],messages:[],rangeMessage:{isDone:true,messages:[]}});
  });
  const sdk=new FakePageSdk(),cache=createProductNameCache(storage);
  const session=createPageSession({...base,sdk},{sdk,selfUid:'me',account:{account_id:account,environment:'production',session_generation:1},initialEpoch:1,beginMsgTime:1700000000000,productNameCache:cache,pushDisplay:async p=>{displays.push(p);}});
  const names=()=>Object.fromEntries(displays.flatMap(p=>p.kind==='conversations'?p.items:[]).map(c=>[c.gid,c.order?.product]));
  return {base,sdk,session,requests,names,release:()=>release(),changeService:()=>session.store.update([sampleRow('1',{sessionId:'new-service'})])};
}

test('list loads product names sequentially, persists them and restores without opening chat',async()=>{
 const storage=memory(),f=fixture(storage,true);f.session.start();
 await f.base.clock.advance(100);await settle();
 assert.deepEqual(f.requests,['1'],'second request must wait for first');
 f.release();await settle();assert.deepEqual(f.requests,['1','2']);
 assert.deepEqual(f.names(),{'1':'产品-1','2':'产品-2'});
 assert.equal(f.sdk.readReceipts.length,0);f.session.stop();
 const again=fixture(storage);again.session.start();try{
  await again.base.clock.advance(100);await settle();
  assert.deepEqual(again.names(),{'1':'产品-1','2':'产品-2'});
  assert.deepEqual(again.requests,[],'fresh persistent cache avoids repeat requests');
 }finally{again.session.stop();}
 const other=fixture(storage,false,'account-B');other.session.start();try{
  await other.base.clock.advance(100);await settle();assert.deepEqual(other.requests,['1','2'],'another account cannot reuse this cache');
 }finally{other.session.stop();}
});

test('late product response cannot publish after stop or pollute persistent cache',async()=>{
 const storage=memory(),f=fixture(storage,true);f.session.start();await f.base.clock.advance(100);await settle();f.session.stop();
 f.release();await settle();
 const again=fixture(storage);again.session.start();try{await again.base.clock.advance(100);await settle();assert.deepEqual(again.requests,['1','2']);}finally{again.session.stop();}
});

test('a product result from a previous service cannot enter the current row or its persistent cache',async()=>{
 const storage=memory(),f=fixture(storage,true);f.session.start();
 await f.base.clock.advance(100);await settle();f.changeService();f.release();await settle();
 assert.notEqual(f.names()['1'],'产品-1');f.session.stop();
 const again=fixture(storage);again.session.start();try{
  await again.base.clock.advance(100);await settle();
  assert.ok(again.requests.includes('1'),'discarded old service result was not persisted');
 }finally{again.session.stop();}
});
