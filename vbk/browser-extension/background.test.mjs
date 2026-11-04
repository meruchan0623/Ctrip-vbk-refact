import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const script=fs.readFileSync(new URL('./background.js',import.meta.url),'utf8').replace("import { selectCookies } from './cookies.js';",'')+'\nglobalThis.testing={start,stop,port:()=>port,pending:()=>pending,challenge:()=>challenge};';
function fixture(){
 const ports=[];let reads=0;
 const chrome={storage:{local:{get:async()=>({}),set:async()=>{}}},runtime:{onStartup:{addListener(){}},onMessage:{addListener(){}},connectNative(){const p={sent:[],onMessage:{addListener(fn){p.message=fn}},onDisconnect:{addListener(fn){p.disconnected=fn}},postMessage(m){p.sent.push(m)},disconnect(){}};ports.push(p);return p;}},cookies:{getAll:async()=>{reads++;return[{name:'bticket'}]}}};
 const context=vm.createContext({chrome,navigator:{userAgent:'Chrome'},crypto:{randomUUID:()=> 'test-source'},selectCookies:c=>c,setInterval:()=>1,clearInterval(){}});
 vm.runInContext(script,context);return {testing:context.testing,ports,reads:()=>reads};
}
test('old native connection cannot disconnect the newly authorized profile',async()=>{
 const f=fixture();f.testing.start({sourceId:'one',label:'one'});const old=f.ports[0];
 f.testing.start({sourceId:'two',label:'two'});const current=f.ports[1];
 old.disconnected();assert.equal(f.testing.port(),current);
 await old.message({ok:true,challenge:'stale'});assert.equal(f.reads(),0);
 await current.message({ok:true,challenge:'active'});assert.equal(f.reads(),1);assert.equal(current.sent.at(-1).source_id,'two');
});
test('no credentials are read before active challenge and rejected offers can retry',async()=>{
 const f=fixture();f.testing.start({sourceId:'one',label:'one'});const p=f.ports[0];
 await p.message({ok:false,message:'no login pending'});assert.equal(f.reads(),0);
 await p.message({ok:true,challenge:'active'});assert.equal(f.reads(),1);
 await p.message({ok:false,message:'offer rejected'});assert.equal(f.testing.challenge(),'');
 await p.message({ok:true,challenge:'active'});assert.equal(f.reads(),2);
});
