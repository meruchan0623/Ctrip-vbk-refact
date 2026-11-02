#!/usr/bin/env node
// 旅游商家桌面版被动接口抓取器（只读、脱敏）。需要 Node >= 22（全局 WebSocket / fetch）。
//
//   node capture.mjs start  [--out DIR] [--pid MAINPID]   安装钩子后立即关闭调试端口，之后由钩子把事件写入 DIR/events.jsonl
//   node capture.mjs report [--out DIR] [--outbound]       汇总 events.jsonl；--outbound 只出出站时间线
//   start 加 --outbound：保留协议枚举值（msgtype/bizType 等短字符串，正文与自由文本字段仍屏蔽）
//   node capture.mjs stop   [--out DIR] [--pid MAINPID]    卸载钩子，关闭调试端口
//
// 做了什么：
//   · 主进程：向主进程发 SIGUSR1 打开 Node inspector（127.0.0.1:9229），对每个 webContents 被动挂 CDP Network，
//     记录方法 / host / path / query 键名 / 请求头名 / 请求体与响应体的字段结构 / 状态 / 协议 / WebSocket 帧大小。
//   · IM 子进程：只对「主进程的直接子进程里的 NodeService」依次发 SIGUSR1（不按名字全局匹配，避免打到别的 Electron 应用），
//     钩住 tls.connect（记录 host/port/SNI）与 http(s) 的 upgrade（记录 path / 子协议 / 状态），并解析 WebSocket 帧头
//     （方向、opcode、长度、XMPP 标签名与 type 属性）。
// 不做什么：不发送、不改写任何请求；不记录 Cookie、token、消息正文、JID、请求体里的字符串值（仅 startTime 等少数数值字段）。
// 钩子装好后调试端口立即关闭，抓取靠钩子写文件，不需要保持连接。stop 会重新打开端口卸载钩子。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(opt('--out', path.join(process.cwd(), 'capture-out')));
const EVENTS = path.join(OUT, 'events.jsonl');
const PORT = 9229;
const OUTBOUND = args.includes('--outbound');
const APP_BIN = 'Contents/MacOS/旅游商家桌面版';

// ---------- 进程发现（严格限定在商家版进程树内） ----------
function mainPid() {
  const forced = opt('--pid');
  if (forced) return Number(forced);
  // ps 会转义中文路径，不能按名字匹配：取「可执行文件名 == bundle 名」且子进程带 vbk-electron user-data-dir 的进程。
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command=']).toString('utf8').split('\n')
    .map((r) => r.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
  const hit = rows.filter((r) => {
    const m = r.cmd.match(/^\/Applications\/(.+)\.app\/Contents\/MacOS\/(.+)$/);
    return m && m[1] === m[2] && rows.some((c) => c.ppid === r.pid && c.cmd.includes('user-data-dir=') && c.cmd.includes('/vbk-electron'));
  });
  if (hit.length !== 1) throw new Error(`找不到唯一的商家版主进程（匹配 ${hit.length} 个）；可用 --pid 指定`);
  return hit[0].pid;
}
function nodeServiceChildren(main) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command=']).toString('utf8').split('\n');
  return rows
    .map((r) => r.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m) => m && Number(m[2]) === main && m[3].includes('utility-sub-type=node.mojom.NodeService'))
    .map((m) => Number(m[1]));
}

// ---------- inspector 通信 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function openInspector(pid) {
  process.kill(pid, 'SIGUSR1');
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1500) })).json();
      if (list[0]?.webSocketDebuggerUrl) return list[0].webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
  }
  throw new Error(`pid ${pid}: inspector 未在 ${PORT} 起来（端口被占用？先 stop 或等上一个关闭）`);
}
function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('evaluate 超时')); }, 15000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (d.result?.exceptionDetails) reject(new Error(d.result.exceptionDetails.text + ' ' + (d.result.exceptionDetails.exception?.description ?? '')));
      else resolve(d.result?.result?.value);
    };
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error('ws 错误 ' + (e.message ?? ''))); };
  });
}
const CLOSE = `setTimeout(()=>{try{process.mainModule.require('inspector').close()}catch(e){}},400)`;

// ---------- 注入脚本 ----------
const DENY = ['messageBody','body','content','text','msg','message','nick','nickName','name','title','remark','avatar','phone','mobile','email','url','address','desc','subject','fileName'];
const SHAPE = (ob) => `
const OB=${ob?'true':'false'}; const ENUM=/^(type|msgtype|bizType|source|direction|conversationType|requestType|serviceType|resultCode|Ack|target|appId|syscode|cver|applicationCode|messageType|contentType|fileType|sendType|op|opt|scene|biz|bu|channel|ctype|vendorRole|partyType)$/;
const shape=(v,d=0,key='')=>{ if(v===null) return 'null'; if(Array.isArray(v)) return d>5?'[..]':[v.length?shape(v[0],d+1,key):'empty']; if(typeof v==='object'){ if(d>5) return '{..}'; const o={}; for(const k of Object.keys(v).slice(0,80)) o[k]=shape(v[k],d+1,k); return o;} if(typeof v==='string'){ if(OB&&ENUM.test(key)&&v.length>0&&v.length<=24&&/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(v)) return 'str:'+v; return 'str'+(OB&&v.length?'('+v.length+')':''); } if(typeof v==='number'&&OB&&/^(msgtype|bizType|status|type|source|direction|conversationType|receiptRange|fileType|pageSize|op|opt|flag|isread|queryType|decryptType)$/i.test(key)) return 'num:'+v; return typeof v; };
const NUM_OK=new Set(['startTime','endTime','beginTime','pageSize','needTodoList','lastUpdateTime','lastMessageTime','currentStatus','queryType','decryptType']);
const parse=(s)=>{ if(!s) return null; try{ return shape(JSON.parse(s)); }catch(e){ return 'nonjson:'+s.length; } };
const nums=(s)=>{ try{ const j=JSON.parse(s); const o={}; (function walk(x,p){ if(x&&typeof x==='object'&&!Array.isArray(x)) for(const k of Object.keys(x)){ if(NUM_OK.has(k)&&typeof x[k]==='number') o[p+k]=x[k]; else if(k!=='head') walk(x[k],p+k+'.'); } })(j,''); return o; }catch(e){ return undefined; } };
`;

function mainHook(out, ob) {
  return `(function(){
 const r=process.mainModule.require; const fs=r('fs'); const {webContents}=r('electron');
 if(globalThis.__vbkcap) return 'already';
 const st=globalThis.__vbkcap={wcs:{},timer:null};
 const OUT=${JSON.stringify(out)};
 const w=(o)=>{o.t=Date.now();o.proc='main';try{fs.appendFileSync(OUT,JSON.stringify(o)+'\\n')}catch(e){}};
 ${SHAPE(ob)}
 const pend={};
 function attach(wc){
  if(st.wcs[wc.id]) return;
  try{ wc.debugger.attach('1.3'); }catch(e){ w({k:'error',msg:'attach '+wc.id+' '+e.message}); return; }
  st.wcs[wc.id]=true;
  wc.debugger.sendCommand('Network.enable').catch(()=>{});
  wc.debugger.on('message',(ev,method,p)=>{ try{
   const k=wc.id+':'+(p&&p.requestId);
   if(method==='Network.requestWillBeSent'){
     const q=p.request; let u; try{u=new URL(q.url)}catch(e){u=null}
     const isFile=u&&u.protocol==='file:';
     if(isFile) return;
     pend[k]={k:'http',wc:wc.id,type:p.type,method:q.method,host:u&&u.host,path:u&&u.pathname,queryKeys:u?[...u.searchParams.keys()]:[],headerNames:Object.keys(q.headers||{}),ct:(q.headers||{})['Content-Type']||(q.headers||{})['content-type'],bodyShape:parse(q.postData),bodyNums:nums(q.postData),bodyLen:q.postData?q.postData.length:0,t0:Date.now()};
   } else if(method==='Network.responseReceived'){
     const e=pend[k]; if(e){ e.status=p.response.status; e.protocol=p.response.protocol; e.mime=p.response.mimeType; }
   } else if(method==='Network.loadingFinished'){
     const e=pend[k]; if(!e) return; delete pend[k];
     if(e.mime&&/json/.test(e.mime)&&(e.type==='XHR'||e.type==='Fetch')){
       wc.debugger.sendCommand('Network.getResponseBody',{requestId:p.requestId}).then(b=>{e.respShape=parse(b.body);e.respNums=nums(b.body);w(e)}).catch(()=>w(e));
     } else w(e);
   } else if(method==='Network.loadingFailed'){
     const e=pend[k]; if(e){e.failed=p.errorText;delete pend[k];w(e)}
   } else if(method==='Network.webSocketCreated'){
     let u; try{u=new URL(p.url)}catch(e){}
     w({k:'ws-created',wc:wc.id,host:u&&u.host,path:u&&u.pathname});
   } else if(method==='Network.webSocketFrameSent'||method==='Network.webSocketFrameReceived'){
     const d=p.response.payloadData||''; w({k:'ws-frame',wc:wc.id,dir:method.endsWith('Sent')?'out':'in',op:p.response.opcode,len:d.length,tag:(d.match(/^<(\\w[\\w:.-]*)/)||[])[1],shape:parse(d)});
   }
  }catch(x){ w({k:'error',msg:'h '+x.message}) } });
 }
 webContents.getAllWebContents().forEach(attach);
 st.timer=setInterval(()=>{try{webContents.getAllWebContents().forEach(attach)}catch(e){}},2000);
 w({k:'hook',what:'main installed',wcs:Object.keys(st.wcs).length});
 ${CLOSE};
 return 'installed '+Object.keys(st.wcs).length;
})()`;
}
function mainUnhook() {
  return `(function(){ const r=process.mainModule.require; const {webContents}=r('electron'); const st=globalThis.__vbkcap; if(!st) return 'not installed';
 try{clearInterval(st.timer)}catch(e){}
 let n=0; webContents.getAllWebContents().forEach(wc=>{ if(!st.wcs[wc.id]) return; try{ wc.debugger.removeAllListeners('message'); if(wc.debugger.isAttached()){wc.debugger.detach();n++} }catch(e){} });
 delete globalThis.__vbkcap; ${CLOSE}; return 'detached '+n; })()`;
}

function utilityHook(out, label, ob) {
  return `(function(){
 const r=process.mainModule.require; const fs=r('fs'); const tls=r('tls'); const http=r('http');
 if(globalThis.__vbkcap) return 'already';
 const OUT=${JSON.stringify(out)}; const LABEL=${JSON.stringify(label)};
 const w=(o)=>{o.t=Date.now();o.proc=LABEL;try{fs.appendFileSync(OUT,JSON.stringify(o)+'\\n')}catch(e){}};
 ${SHAPE(ob)}
 const orig={tlsConnect:tls.connect, emit:http.ClientRequest.prototype.emit, httpRequest:http.request, httpsRequest:r('https').request, fetch:globalThis.fetch};
 globalThis.__vbkcap=orig;
 const wrapReq=(name,origFn)=>function(...a){ const req=origFn.apply(this,a); try{
   let u=a[0], o=a[1], host, pathq;
   if(typeof u==='string'||u instanceof URL){ const uu=new URL(u); host=uu.host; pathq=uu.pathname+uu.search; o=(o&&typeof o==='object')?o:{}; } else { o=u||{}; host=o.hostname||o.host; pathq=o.path; }
   const pq=String(pathq||'');
   const rec={k:'node-http',via:name,method:(o&&o.method)||'GET',host,path:pq.split('?')[0],queryKeys:[...new URLSearchParams(pq.split('?')[1]||'').keys()],headerNames:Object.keys((o&&o.headers)||{})};
   const chunks=[]; let n=0; const ow=req.write, oe=req.end;
   req.write=function(c,...r2){ try{ if(c&&typeof c!=='function'&&n<65536){ chunks.push(Buffer.from(c)); n+=Buffer.byteLength(c); } }catch(e){} return ow.call(this,c,...r2); };
   req.end=function(c,...r2){ try{ if(c&&typeof c!=='function'&&n<65536){ chunks.push(Buffer.from(c)); n+=Buffer.byteLength(c); } const body=Buffer.concat(chunks).toString('utf8'); rec.bodyLen=body.length; rec.bodyShape=parse(body); rec.bodyNums=nums(body); }catch(e){} w(rec); return oe.call(this,c,...r2); };
   req.on('response',(res)=>{ w({k:'node-http-res',via:name,host:rec.host,path:rec.path,status:res.statusCode}); });
 }catch(e){ w({k:'error',msg:'wrapReq '+e.message}); } return req; };
 http.request=wrapReq('http',orig.httpRequest); r('https').request=wrapReq('https',orig.httpsRequest);
 if(orig.fetch) globalThis.fetch=async function(input,init){ const rec={k:'node-fetch'}; try{ const u=new URL(typeof input==='string'?input:(input.url||String(input))); rec.method=(init&&init.method)||(input&&input.method)||'GET'; rec.host=u.host; rec.path=u.pathname; rec.queryKeys=[...u.searchParams.keys()]; const h=init&&init.headers; rec.headerNames=h?Object.keys(typeof h.entries==='function'&&!Array.isArray(h)?Object.fromEntries(h.entries()):h):[]; if(init&&typeof init.body==='string'){ rec.bodyLen=init.body.length; rec.bodyShape=parse(init.body); rec.bodyNums=nums(init.body); } }catch(e){} const res=await orig.fetch.apply(this,arguments); try{ rec.status=res.status; w(rec); }catch(e){} return res; };
 tls.connect=function(...a){ try{ const o=typeof a[0]==='object'?a[0]:(typeof a[1]==='object'?a[1]:{}); w({k:'tls',host:o.host||o.servername||null,port:o.port||(typeof a[0]==='number'?a[0]:null),sni:o.servername||null}); }catch(e){} return orig.tlsConnect.apply(this,a); };
 function makeParser(dir,sockId){ let buf=Buffer.alloc(0);
  return (chunk)=>{ try{ buf=Buffer.concat([buf,chunk]); while(buf.length>=2){
    const b0=buf[0],b1=buf[1]; const op=b0&15; if(!(op===0||op===1||op===2||op===8||op===9||op===10)){ buf=Buffer.alloc(0); return; } let len=b1&127; let off=2; const masked=(b1&128)!==0;
    if(len===126){ if(buf.length<4) return; len=buf.readUInt16BE(2); off=4; } else if(len===127){ if(buf.length<10) return; len=Number(buf.readBigUInt64BE(2)); off=10; }
    const mk=masked?4:0; if(buf.length<off+mk+len){ if(len>1048576){ buf=Buffer.alloc(0); } return; }
    let d0={}; if(op===1&&len<=65536){ let pl=buf.subarray(off+mk,off+mk+len); if(masked){ const m=buf.subarray(off,off+4); pl=Buffer.from(pl); for(let i=0;i<pl.length;i++) pl[i]^=m[i&3]; } const x=pl.toString('utf8');
      const root=x.match(/^<(\\w[\\w:.-]*)([^>]*)>/); if(root){ d0.tag=root[1]; const at=root[2]; d0.attrs=[...at.matchAll(/\\s([\\w:.-]+)=/g)].map(m=>m[1]).slice(0,12); d0.type=(at.match(/\\stype=['"](\\w+)['"]/)||[])[1];
        const id=(at.match(/\\sid=['"]([^'"]+)['"]/)||[])[1]; if(id) d0.idh=r('crypto').createHash('sha1').update(id).digest('hex').slice(0,8);
        d0.children=[...new Set([...x.matchAll(/<(\\w[\\w:.-]*)/g)].map(m=>m[1]))].slice(0,14); d0.xmlns=[...new Set([...x.matchAll(/xmlns=['"]([^'"]+)['"]/g)].map(m=>m[1]))].slice(0,6);
        const bm=x.match(/<body>([\\s\\S]*?)<\\/body>/); if(bm) d0.bodyLen=bm[1].length; } }
    const tag=d0.tag, typ=d0.type;
    w({k:'ws-frame',sock:sockId,dir,op,len,tag,type:typ,attrs:d0.attrs,idh:d0.idh,children:d0.children,xmlns:d0.xmlns,bodyLen:d0.bodyLen});
    buf=buf.subarray(off+mk+len); } }catch(e){ buf=Buffer.alloc(0); } }; }
 let sid=0;
 http.ClientRequest.prototype.emit=function(ev,...a){
  if(ev==='upgrade'){ try{ const [res,socket,head]=a; const id=++sid; const h=res.headers||{};
    w({k:'ws-upgrade',sock:id,host:this.host||null,path:(this.path||'').split('?')[0],queryKeys:[...new URLSearchParams((this.path||'').split('?')[1]||'').keys()],status:res.statusCode,subprotocol:h['sec-websocket-protocol']||null,reqHeaderNames:Object.keys(this.getHeaders?this.getHeaders():{})});
    const pin=makeParser('in',id), pout=makeParser('out',id);
    if(head&&head.length) pin(head);
    socket.on('data',pin);
    const ow=socket.write; socket.write=function(c,...r){ try{ if(Buffer.isBuffer(c)) pout(c); }catch(e){} return ow.call(this,c,...r); };
  }catch(e){ w({k:'error',msg:'upg '+e.message}) } }
  return orig.emit.call(this,ev,...a);
 };
 try{ for(const h of process._getActiveHandles()){ if(!h||h.constructor.name!=='TLSSocket'||h.destroyed) continue;
   const id=++sid; w({k:'tls-existing',sock:id,host:h._host||h.servername||null,remote:h.remoteAddress,port:h.remotePort,approx:true});
   const pin=makeParser('in',id), pout=makeParser('out',id); h.on('data',pin);
   const ow=h.write; h.write=function(c,...r){ try{ if(Buffer.isBuffer(c)) pout(c); }catch(e){} return ow.call(this,c,...r); };
 } }catch(e){ w({k:'error',msg:'scan '+e.message}) }
 w({k:'hook',what:'utility installed'});
 ${CLOSE};
 return 'installed';
})()`;
}
function utilityUnhook() {
  return `(function(){ const r=process.mainModule.require; const o=globalThis.__vbkcap; if(!o) return 'not installed';
 r('tls').connect=o.tlsConnect; r('http').ClientRequest.prototype.emit=o.emit; r('http').request=o.httpRequest; r('https').request=o.httpsRequest; if(o.fetch) globalThis.fetch=o.fetch; delete globalThis.__vbkcap; ${CLOSE}; return 'restored'; })()`;
}

// ---------- 命令 ----------
async function closeStray() {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
    if (list[0]?.webSocketDebuggerUrl) { await evaluate(list[0].webSocketDebuggerUrl, `process.mainModule.require('inspector').close()`).catch(() => {}); await sleep(600); }
  } catch { /* 端口空闲 */ }
}
async function withInspector(pid, expr) {
  await closeStray();
  const url = await openInspector(pid);
  try {
    const got = await evaluate(url, 'process.pid');
    if (got !== pid) throw new Error(`inspector 连到了 pid ${got}，不是目标 ${pid}；已放弃`);
    return await evaluate(url, expr);
  } finally {
    await sleep(1000); // 表达式里的 CLOSE 会在 400ms 后关端口；仍开着才补一刀，避免连已关闭端口卡 15s
    await closeStray();
  }
}

async function start() {
  fs.mkdirSync(OUT, { recursive: true });
  const main = mainPid();
  const kids = nodeServiceChildren(main);
  console.log(`主进程 ${main}；NodeService 子进程 ${kids.join(', ') || '无'}；输出 ${EVENTS}`);
  console.log('main:', await withInspector(main, mainHook(EVENTS, OUTBOUND)));
  let i = 0;
  for (const pid of kids) {
    try { console.log(`utility ${pid}:`, await withInspector(pid, utilityHook(EVENTS, `im${++i}:${pid}`, OUTBOUND))); }
    catch (e) { console.log(`utility ${pid} 跳过：${e.message}`); }
  }
  console.log('钩子已安装，调试端口已关闭。现在可以在应用里操作；完成后运行 report，再 stop。');
}
async function stop() {
  const main = mainPid();
  console.log('main:', await withInspector(main, mainUnhook()));
  for (const pid of nodeServiceChildren(main)) {
    try { console.log(`utility ${pid}:`, await withInspector(pid, utilityUnhook())); } catch (e) { console.log(`utility ${pid} 跳过：${e.message}`); }
  }
  console.log('已卸载。');
}
function report() {
  const ev = fs.readFileSync(EVENTS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const http = ev.filter((e) => e.k === 'http' && e.method && e.type !== 'Script' && e.type !== 'Stylesheet' && e.type !== 'Image' && e.type !== 'Font');
  const g = new Map();
  for (const e of http) {
    const key = `${e.method} ${e.host}${e.path} [${e.type}] ${e.status ?? e.failed ?? '-'} ${e.protocol ?? ''}`;
    const x = g.get(key) ?? { n: 0, ts: [], body: new Set(), resp: null, nums: [] };
    x.n++; x.ts.push(e.t0 ?? e.t); x.body.add(JSON.stringify(e.bodyShape && typeof e.bodyShape === 'object' ? Object.fromEntries(Object.entries(e.bodyShape).filter(([k]) => k !== 'head')) : e.bodyShape));
    x.resp ??= e.respShape; if (e.bodyNums && Object.keys(e.bodyNums).length) x.nums.push(e.bodyNums);
    g.set(key, x);
  }
  console.log(`# 事件 ${ev.length}，HTTP(去静态资源) ${http.length}`);
  for (const [k, x] of [...g.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const d = x.ts.sort((a, b) => a - b).map((t, i, a) => i ? (t - a[i - 1]) / 1000 : null).filter((v) => v !== null);
    const med = d.length ? d.sort((a, b) => a - b)[Math.floor(d.length / 2)] : null;
    console.log(`\n${x.n}× ${k}${med !== null ? `  中位间隔 ${med.toFixed(1)}s` : ''}`);
    for (const b of [...x.body].slice(0, 4)) console.log('  req :', b.slice(0, 400));
    if (x.nums.length) console.log('  nums:', JSON.stringify(x.nums[0]));
    if (x.resp) console.log('  resp:', JSON.stringify(x.resp).slice(0, 400));
  }
  const tl = ev.filter((e) => e.k === 'tls');
  if (tl.length) { console.log('\n# TLS 连接（IM 进程）'); for (const [k, n] of Object.entries(tl.reduce((a, e) => { const key = `${e.proc} ${e.host}:${e.port} sni=${e.sni}`; a[key] = (a[key] ?? 0) + 1; return a; }, {}))) console.log(`${n}× ${k}`); }
  for (const e of ev.filter((e) => e.k === 'ws-upgrade' || e.k === 'ws-created')) console.log('\n# WebSocket', JSON.stringify(e));
  const fr = ev.filter((e) => e.k === 'ws-frame');
  if (fr.length) {
    const c = {}; for (const e of fr) { const key = `${e.proc} ${e.dir} op=${e.op} tag=${e.tag ?? '-'} type=${e.type ?? '-'}`; c[key] = (c[key] ?? 0) + 1; }
    console.log('\n# WebSocket 帧（方向 / opcode / XMPP 标签 / type）');
    for (const [k, n] of Object.entries(c).sort((a, b) => b[1] - a[1])) console.log(`${n}× ${k}`);
  }
  const er = ev.filter((e) => e.k === 'error'); if (er.length) console.log('\n# 错误', er.slice(0, 5));
}

function reportOutbound() {
  const ev = fs.readFileSync(EVENTS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const t0 = Math.min(...ev.map((e) => e.t0 ?? e.t));
  const rel = (t) => `+${(((t) - t0) / 1000).toFixed(1)}s`;
  const READ = /getConversationList|getMessageList|getSessionEmpathyPhraseInfo|getRemarkList|queryToken|getAppConfig|checkMemberStatus|getConversationInfoByGidList|checkSessionStatus|getOrderDetailsForVbk|batchTranslateByMsgIds|getCurrentUserInfo|getRecentMessages|bee\/collect|saveLogInfo|createTUid|uploadDeviceInfo|getDiscardUbts|reportInjectFnInfo|createclientid|chloro-device|model-poc2|\/hv$/;
  const TELE = /^(s\.c-ctrip\.com|cdid\.c-ctrip\.com|ubt)/;
  const http = ev.filter((e) => e.k === 'http' && e.method && e.method !== 'GET' && !TELE.test(e.host ?? '') && !READ.test((e.host ?? '') + (e.path ?? '')));
  const isPing = (e) => e.tag === 'iq' && (e.xmlns ?? []).some((x) => /ping/.test(x));
  const frames = ev.filter((e) => e.k === 'ws-frame');
  const hb = frames.filter(isPing).length;
  const real = frames.filter((e) => !isPing(e) && e.op === 1);
  const inById = new Map(); for (const e of real.filter((e) => e.dir === 'in' && e.idh)) (inById.get(e.idh) ?? inById.set(e.idh, []).get(e.idh)).push(e);
  const rows = [
    ...http.map((e) => ({ t: e.t0 ?? e.t, kind: 'HTTP', e })),
    ...real.map((e) => ({ t: e.t, kind: 'XMPP', e })),
    ...ev.filter((e) => e.k === 'node-http' || e.k === 'node-fetch').map((e) => ({ t: e.t, kind: 'NODE-HTTP', e })),
  ].sort((a, b) => a.t - b.t);
  console.log(`# 出站时间线（已排除已知读取接口、埋点、XMPP 心跳 ${hb} 帧）。基准 ${new Date(t0).toISOString()}`);
  for (const { t, kind, e } of rows) {
    if (kind === 'NODE-HTTP') {
      console.log(`\n${rel(t)} NODE-HTTP(${e.proc}) ${e.method} ${e.host}${e.path} len=${e.bodyLen ?? '-'} -> ${e.status ?? '-'}  query=[${(e.queryKeys ?? []).join(',')}] hdr=[${(e.headerNames ?? []).join(',')}]`);
      console.log('   req :', JSON.stringify(e.bodyShape && typeof e.bodyShape === 'object' ? Object.fromEntries(Object.entries(e.bodyShape).filter(([k]) => k !== 'head')) : e.bodyShape));
    } else if (kind === 'HTTP') {
      console.log(`\n${rel(t)} HTTP ${e.method} ${e.host}${e.path} [${e.type}] ct=${e.ct ?? '-'} len=${e.bodyLen} -> ${e.status ?? e.failed ?? '-'} ${e.protocol ?? ''}`);
      if (e.queryKeys?.length) console.log('   query:', e.queryKeys.join(','));
      const b = e.bodyShape && typeof e.bodyShape === 'object' ? Object.fromEntries(Object.entries(e.bodyShape).filter(([k]) => k !== 'head')) : e.bodyShape;
      console.log('   req :', JSON.stringify(b));
      if (e.respShape) console.log('   resp:', JSON.stringify(e.respShape));
    } else {
      const ack = e.dir === 'out' && e.idh ? (inById.get(e.idh) ?? []).map((x) => `${((x.t - e.t) / 1000).toFixed(2)}s ${x.tag}/${x.type ?? '-'}`) : [];
      console.log(`\n${rel(t)} XMPP ${e.dir} <${e.tag}${e.type ? ' type=' + e.type : ''}> len=${e.len} proc=${e.proc} idh=${e.idh ?? '-'} attrs=[${(e.attrs ?? []).join(',')}] children=[${(e.children ?? []).join(',')}] xmlns=[${(e.xmlns ?? []).join(' ')}]${e.bodyLen !== undefined ? ' bodyLen=' + e.bodyLen : ''}${ack.length ? '\n   回执: ' + ack.join('; ') : ''}`);
    }
  }
}

try {
  if (cmd === 'start') await start();
  else if (cmd === 'stop') await stop();
  else if (cmd === 'report') (args.includes('--outbound') ? reportOutbound() : report());
  else { console.log('用法: node capture.mjs start|report|stop [--out DIR] [--pid MAINPID]'); process.exit(1); }
} catch (e) { console.error('失败：', e.message); process.exit(2); }
process.exit(0);
