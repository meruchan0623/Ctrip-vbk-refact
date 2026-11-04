const button=document.querySelector('#connect');
const disconnect=document.querySelector('#disconnect');
const status=document.querySelector('#status');
const label=document.querySelector('#label');
chrome.runtime.sendMessage({action:'state'}).then(state=>{
 label.value=state.label||'';disconnect.hidden=!state.enabled;
 if(state.enabled)status.textContent=state.message||'此配置已授权，客户端点击 ＋ 即可发现当前携程登录态。';
});
button.addEventListener('click',async()=>{
 button.disabled=true;
 try {const reply=await chrome.runtime.sendMessage({action:'enable',label:label.value});status.textContent=reply.message;disconnect.hidden=false;}
 catch{status.textContent='无法启用连接，请检查本机桥接安装。';}
 finally{button.disabled=false;}
});
disconnect.addEventListener('click',async()=>{await chrome.runtime.sendMessage({action:'disable'});disconnect.hidden=true;status.textContent='已停止自动连接。浏览器携程账号仍保持登录。';});
