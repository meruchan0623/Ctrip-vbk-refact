import { selectCookies } from './cookies.js';
let port = null;
let timer = null;
let source = null;
let pending = false;
let challenge = '';
let lastMessage = '';
function report(message) { lastMessage = message; }
function stop() {
  clearInterval(timer); timer = null;
  const old=port; port=null; if(old)old.disconnect();
  source=null;pending=false;challenge='';
}
function start(config) {
  stop(); source=config;
  port=chrome.runtime.connectNative('com.vbk.browser_bridge');
  const connection=port;
  port.onDisconnect.addListener(()=>{if(port!==connection)return;const message=chrome.runtime.lastError?.message;report(message||'本机桥接已断开');port=null;clearInterval(timer);timer=null;});
  port.onMessage.addListener(async reply=>{
    if(port!==connection)return;
    pending=false;
    if(!reply?.ok){challenge='';report(reply?.message||'请打开客户端添加账号窗口');return;}
    if(typeof reply.challenge!=='string'){report(reply.message||'已提供账号，请回客户端选择');return;}
    if(reply.challenge===challenge)return;
    const current=source;
    if(!current||!port)return;
    pending=true;
    try {
      const cookies=selectCookies(await chrome.cookies.getAll({url:'https://vbooking.ctrip.com/'}));
      if(source!==current||port!==connection)return;
      if(!cookies.some(c=>c.name==='bticket')){pending=false;report('请先在此浏览器配置登录携程商家平台');return;}
      challenge=reply.challenge;pending=true;
      port.postMessage({action:'offer',challenge,source_id:current.sourceId,browser:/Edg\//.test(navigator.userAgent)?'Edge':'Chrome',label:current.label,cookies});
    }catch{pending=false;challenge='';report('读取登录态失败，请重新授权');}
  });
  function poll(){if(port&&!pending){pending=true;port.postMessage({action:'status'});}}
  poll();timer=setInterval(poll,2000);
}
async function restore(){const config=await chrome.storage.local.get(['enabled','sourceId','label']);if(config.enabled)start(config);}
chrome.runtime.onStartup.addListener(()=>void restore());
chrome.runtime.onMessage.addListener((request,_sender,respond)=>{
  if(request.action==='state'){chrome.storage.local.get(['enabled','label']).then(c=>respond({...c,message:lastMessage}));return true;}
  if(request.action==='disable'){stop();chrome.storage.local.set({enabled:false}).then(()=>respond({ok:true}));return true;}
  if(request.action==='enable'){
    chrome.storage.local.get(['sourceId']).then(async c=>{
      const config={enabled:true,sourceId:c.sourceId||crypto.randomUUID(),label:typeof request.label==='string'?request.label.trim().slice(0,40):''};
      await chrome.storage.local.set(config);start(config);respond({ok:true,message:'已授权。保持此配置登录携程，回客户端刷新并选择账号。'});
    });return true;
  }
});
void restore();
