// Evidence helpers only. Browser operations must be invoked through ego-browser.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const root = '/Users/tashima_meru/Develop/Ctrip-vbk-refact';
const output = `${root}/docs/api/evidence/2026-10-30`;
const keySalt=crypto.randomBytes(32);
const privateKey=k=>/^(?:\d{12,}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|_ti[a-z0-9_]+|csm\d+)$/i.test(k);
const publicKey=k=>privateKey(k)?`dynamic_ref_${crypto.createHmac('sha256',keySalt).update(k).digest('hex').slice(0,12)}`:k;
const extensionConstants=new Set(['protocol','protocal','cpc','appid','language','amp-product-type','amp-account-source','client-source','locale']);
const safeStrings = new Set(['locale','language','lang','currency','direction','conversationType','serviceType','contentType','cver','appId','appid','syscode','platform','source','senderRole','Ack','ack','resultCode','errorCode','SeverityCode','ErrorClassification','code','action','requestType','queryType','decryptType','deviceType','applicationCode','clientSource','accountsource','bizType','imBuType','msgtype','type','channel','status','kind','role','categoryType','typeList','optionCode','chatType','chattype','scene','subEnv'].map(x=>x.toLowerCase()));
const idKey = /(?:uid|jid|gid|groupid|sessionid|worksheetid|orderid|vendorid|providerid|msgid|localid|partner|ticket|token|auth|password|secret|signature|nonce|ctok|cid|xsid|customer|username|nickname|phone|email|deviceip)/i;
function marker(value, path) { return `{{${path}:${typeof value}}}`; }
export function redact(value, path = 'body') {
  const key = path.split('.').at(-1).replace(/\[\d+\]/g,'');
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((v,i)=>redact(v,`${path}[${i}]`));
  if (typeof value === 'object') {
    if(/\.head\.extension\[\d+\]$/.test(path))return {...value,value:extensionConstants.has(value.name)?value.value:marker(value.value,`${path}.value`)};
    return Object.fromEntries(Object.entries(value).map(([k,v])=>{const safe=publicKey(k);return [safe,redact(v,`${path}.${safe}`)];}));
  }
  if (value === '') return '';
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return key === 'id' || idKey.test(key) || /time|timestamp/i.test(key) || Math.abs(value)>1e9 ? marker(value,path) : value;
  if (typeof value !== 'string') return String(value);
  if (/^(?:\{|\[)/.test(value)) {
    try { return JSON.stringify(redact(JSON.parse(value),`${path}.$json`)); } catch {}
  }
  if (/\.head\.extension\[\d+\]\.name$/.test(path)) return value;
  if (/\.head\.extension\[\d+\]\.value$/.test(path)) {
    // Extension values are separately retained only when they are protocol constants.
    return marker(value,path);
  }
  if (idKey.test(key)) return marker(value,path);
  if (safeStrings.has(key.toLowerCase()) && value.length<100 && !/https?:|@|\s/.test(value)) return value;
  return marker(value,path);
}
export function schema(value) {
  if (value===null) return {type:'null'};
  if (Array.isArray(value)) {
    const variants=[...new Map(value.map(v=>{const s=schema(v);return [JSON.stringify(s),s];})).values()];
    return {type:'array',observedLength:value.length,items:variants.length===1?variants[0]:{anyOf:variants}};
  }
  if (typeof value==='object') return {type:'object',properties:Object.fromEntries(Object.entries(value).map(([k,v])=>[publicKey(k),schema(v)])),observedKeys:Object.keys(value).map(publicKey)};
  return {type:typeof value,...(typeof value==='string'&&/^(?:\{|\[)/.test(value)?(()=>{try{return {encodedJson:schema(JSON.parse(value))};}catch{return {};}})():{})};
}
function urlTemplate(raw) {
  const u=new URL(raw);return `${u.origin}${u.pathname}${u.search?'?'+[...u.searchParams].map(([k,v])=>`${k}=${encodeURIComponent(redact(v,`query.${k}`))}`).join('&'):''}`;
}
function headers(h={}) {
  const constants=/^(content-type|accept|origin|referer|access-control-.*|sec-fetch-.*|sec-ch-ua.*|user-agent|x-ctx-(locale|currency|country)|x-tour-auth-from|x-tour-field-security-type|cookieorigin)$/i;
  return Object.fromEntries(Object.entries(h).map(([k,v])=>[k,/^cookie$/i.test(k)?String(v).split(';').map(x=>`${x.trim().split('=')[0]}={{cookie}}`).join('; '):constants.test(k)?(/^referer$/i.test(k)?urlTemplate(v):v):`{{header.${k}:string}}`]));
}
export async function begin(page) {
  await page.cdp('Network.enable',{maxTotalBufferSize:100000000,maxResourceBufferSize:10000000,maxPostDataSize:5000000});
  await page.events();
}
export async function assertControlled(page) {
  const ok=await page.evaluate(()=>{
    const frame=document.querySelector('iframe[src*="/tour/im/ex-area/"]');
    const gid=frame?new URL(frame.src).searchParams.get('groupid'):null;
    return !!gid && gid===window.__contractControlledGid;
  });
  if(!ok)throw new Error('Controlled conversation identity guard failed; no mutation performed');
}
export async function observeXHR(page) {
  await page.evaluate(()=>{
    if(window.__contractXHR)return;
    const proto=XMLHttpRequest.prototype;
    const original={open:proto.open,send:proto.send,setRequestHeader:proto.setRequestHeader};
    const records=[];
    proto.open=function(method,url,...rest){this.__contractMeta={method,url:String(url),headers:{}};return original.open.call(this,method,url,...rest);};
    proto.setRequestHeader=function(name,value){if(this.__contractMeta)this.__contractMeta.headers[name]=value;return original.setRequestHeader.call(this,name,value);};
    proto.send=function(body){
      const meta=this.__contractMeta;
      if(meta&&/\/restapi\/soa2\/|nephele\.ctrip\.com\/(?:image|file|video)/.test(meta.url)){
        meta.payload=body instanceof Blob?{kind:body instanceof File?'File':'Blob',name:body.name,size:body.size,type:body.type}:body instanceof FormData?{kind:'FormData',fields:[...body.entries()].map(([name,v])=>({name,value:v instanceof Blob?{kind:'Blob',name:v.name,size:v.size,type:v.type}:v}))}:{kind:typeof body};
        this.addEventListener('loadend',()=>{let response;try{response=JSON.parse(this.responseText);}catch{response={unavailable:true};}records.push({...meta,status:this.status,response});},{once:true});
      }
      return original.send.call(this,body);
    };
    window.__contractXHR={records,restore(){Object.assign(proto,original);delete window.__contractXHR;}};
  });
}
export async function collect(page, stage) {
  let ev=await page.events();
  // Wait for already dispatched request completion; no extra business requests.
  let pending = new Set(ev.filter(e=>e.method==='Network.requestWillBeSent').map(e=>e.params.requestId));
  for (const e of ev) if (/Network\.(loadingFinished|loadingFailed)$/.test(e.method)) pending.delete(e.params.requestId);
  for (let i=0;i<12 && (i<2 || pending.size);i++) {
    await new Promise(r=>setTimeout(r,250));
    const more=await page.events();ev.push(...more);
    for(const e of more) {if(e.method==='Network.requestWillBeSent')pending.add(e.params.requestId);if(/Network\.(loadingFinished|loadingFailed)$/.test(e.method))pending.delete(e.params.requestId);}
  }
  const requests=[];
  for (const e of ev.filter(e=>e.method==='Network.requestWillBeSent')) {
    const {request:r,requestId:id}=e.params;
    if (!/\/restapi\/soa2\/|nephele\.ctrip\.com\/(?:image|file|video)|\/tour\/im\/ex-area\/b(?:[/?]|$)/.test(r.url)) continue;
    const extra=ev.find(x=>x.method==='Network.requestWillBeSentExtraInfo'&&x.params.requestId===id)?.params;
    const response=ev.find(x=>x.method==='Network.responseReceived'&&x.params.requestId===id)?.params.response;
    const responseExtra=ev.find(x=>x.method==='Network.responseReceivedExtraInfo'&&x.params.requestId===id)?.params;
    let body=r.postData, postDataError;
    if(r.hasPostData && body===undefined)try{body=(await page.cdp('Network.getRequestPostData',{requestId:id})).postData;}catch(err){postDataError=String(err.message);}
    let parsed;try{parsed=JSON.parse(body);}catch{parsed=body;}
    // Multipart binary is not decoded or copied into documentation.
    const multipart=/multipart\/form-data/i.test(Object.entries(r.headers).find(([k])=>k.toLowerCase()==='content-type')?.[1]||'');
    let responseBody,responseError,htmlResponse=false;
    if(response && r.method!=='OPTIONS')try{const b=await page.cdp('Network.getResponseBody',{requestId:id});const text=b.base64Encoded?Buffer.from(b.body,'base64').toString():b.body;if(response.mimeType?.includes('text/html')){responseBody='{{HTML with server-rendered initial state; see associated SSR evidence}}';htmlResponse=true;}else responseBody=JSON.parse(text);}catch(err){responseError=String(err.message);}
    const h={...r.headers,...extra?.headers};
    if(r.method==='POST' && parsed && typeof parsed==='object') {
      await page.evaluate(({url,body,headers,response})=>{
        window.__contractRuntime ||= {};
        window.__contractRuntime[new URL(url).pathname]={url,body,headers,response};
      },{url:r.url,body:parsed,response:responseBody,headers:Object.fromEntries(Object.entries(r.headers).filter(([k])=>/^(content-type|cookieorigin|x-tour-auth-from|x-ctx-(locale|country|currency))$/i.test(k)))});
    }
    const entry={stage,id,url:urlTemplate(r.url),method:r.method,requestHeaders:headers(h),extraInfoObserved:!!extra,associatedCookies:extra?.associatedCookies?.map(c=>({name:c.cookie.name,domain:c.cookie.domain,path:c.cookie.path,httpOnly:c.cookie.httpOnly,secure:c.cookie.secure,sameSite:c.cookie.sameSite,blockedReasons:c.blockedReasons})),requestTemplate:multipart?'{{multipart: see field inventory}}':redact(parsed),requestSchema:schema(parsed),postDataError,httpStatus:response?.status,responseHeaders:headers({...response?.headers,...responseExtra?.headers}),responseTemplate:redact(responseBody,'response'),responseSchema:schema(responseBody),responseError,loadingFailure:ev.find(x=>x.method==='Network.loadingFailed'&&x.params.requestId===id)?.params.errorText};
    entry.requestHasPostData=!!(r.hasPostData||r.postData!==undefined);
    if(!entry.requestHasPostData&&body===undefined){entry.requestTemplate=null;entry.requestSchema={type:'null'};entry.requestEncoding=`none (${r.method} without request body)`;}
    if(htmlResponse){entry.responseTemplate=responseBody;entry.responseSchema={type:'string',contentMediaType:'text/html'};}
    if(parsed?.head?.extension) entry.headExtension=parsed.head.extension.map((x,i)=>({name:x.name,value:extensionConstants.has(x.name)?x.value:marker(x.value,`body.head.extension[${i}].value`)}));
    if(multipart&&body)entry.multipartFields=[...body.matchAll(/Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]+)")?\r\n(?:Content-Type: ([^\r]+)\r\n)?\r\n([^]*?)(?=\r\n--)/g)].map(m=>({name:m[1],filename:m[2]?'{{file.name}}':undefined,contentType:m[3],value:m[2]?'{{binary}}':redact(m[4],`multipart.${m[1]}`)}));
    requests.push(entry);
  }
  const websocket=[],references=new Map();
  const ref=value=>{const key=String(value);if(!references.has(key))references.set(key,`ref-${references.size+1}`);return references.get(key);};
  for(const e of ev.filter(e=>/Network\.webSocket(?:Created|Closed|FrameError|WillSendHandshakeRequest|HandshakeResponseReceived|FrameSent|FrameReceived)$/.test(e.method))) {
    const p=e.params; if(p.response?.payloadData) {
      const raw=p.response.payloadData;
      const body=await page.evaluate(raw=>{const doc=new DOMParser().parseFromString(raw,'text/xml');return [...doc.getElementsByTagName('body')].map(n=>{try{return JSON.parse(n.textContent);}catch{return n.textContent;}});},raw);
      const bodyReferences=body.map(b=>b&&typeof b==='object'?Object.fromEntries(Object.entries(b).filter(([k])=>/^(id|localid|msgid|tid|threadid)$/i.test(k)).map(([k,v])=>[k,ref(v)])):{});
      websocket.push({event:e.method,id:p.requestId,opcode:p.response.opcode,bodyReferences,bodyTemplate:redact(body,'ws.body'),bodySchema:schema(body),xmlTemplate:raw.replace(/>([^<]+)</g,'>{{text}}<').replace(/([\w:-]+)=("[^"]*"|'[^']*')/g,(m,k,v)=>/^(xmlns(?::\w+)?|type|mechanism|version|msgtype|chattype|biztype)$/.test(k)?m:`${k}="{{${k}:${ref(v.slice(1,-1))}}}"`)});continue;
    }
    websocket.push({event:e.method,id:p.requestId,url:p.url?urlTemplate(p.url):undefined,headers:headers(p.request?.headers||p.response?.headers),status:p.response?.status});
  }
  await fs.mkdir(output,{recursive:true});
  const file=`${output}/${stage}.json`;
  const observed=await page.evaluate(()=>window.__contractXHR?.records.splice(0)||[]);
  const xhr=observed.map(r=>({method:r.method,url:urlTemplate(new URL(r.url,'https://vbooking.ctrip.com').href),headers:headers(r.headers),payload:redact(r.payload,'payload'),payloadSchema:schema(r.payload),status:r.status,response:redact(r.response,'response'),responseSchema:schema(r.response)}));
  await fs.writeFile(file,JSON.stringify({capturedAt:new Date().toISOString(),page:await page.url(),stage,requests,websocket,xhr,redaction:'Full request shape and array entries retained; credentials and identities replaced by typed placeholders. Schemas describe observation, not requiredness.'},null,2)+'\n');
  const business=requests.filter(r=>r.method!=='OPTIONS');
  console.log({stage,file,requests:business.length,endpoints:[...new Set(business.map(r=>r.url.split('?')[0]))],missingResponses:business.filter(r=>r.responseSchema?.type==='undefined').length,websocketEvents:websocket.length});
  return {requests,events:ev};
}
