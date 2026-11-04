#!/usr/bin/env node
// Register the current user's native host for Chrome AND Edge.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../browser-extension');
const binary=path.resolve(process.argv[2] || path.join(path.dirname(source),'src-tauri/target/debug',process.platform==='win32'?'vbk-browser-bridge.exe':'vbk-browser-bridge'));
if(!fs.existsSync(binary)) throw new Error('先构建桥接：cargo build --manifest-path src-tauri/Cargo.toml --bin vbk-browser-bridge，或传入已构建桥接文件路径');
if(!['darwin','win32'].includes(process.platform)) throw new Error('仅支持 macOS 和 Windows');
const root=process.platform==='win32'?path.join(process.env.LOCALAPPDATA,'VBK','browser-bridge'):path.join(os.homedir(),'Library/Application Support/VBK/browser-bridge');
fs.mkdirSync(root,{recursive:true,mode:0o700});
const host=path.join(root,path.basename(binary));
if(binary!==host)fs.copyFileSync(binary,host);
if(process.platform==='darwin'){fs.chmodSync(root,0o700);fs.chmodSync(host,0o700);}
const extension=path.join(root,'extension');
fs.cpSync(source,extension,{recursive:true});
const id=fs.readFileSync(path.join(source,'extension-id.txt'),'utf8').trim();
const manifest={name:'com.vbk.browser_bridge',description:'VBK browser login bridge',path:host,type:'stdio',allowed_origins:[`chrome-extension://${id}/`]};
const outputs=[];
if(process.platform==='darwin'){
 for(const browser of ['Google/Chrome','Microsoft Edge']){
  const dir=path.join(os.homedir(),'Library/Application Support',browser,'NativeMessagingHosts');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const target=path.join(dir,'com.vbk.browser_bridge.json');
  fs.writeFileSync(target,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});outputs.push(target);
 }
}else{
 const target=path.join(root,'com.vbk.browser_bridge.json');fs.writeFileSync(target,JSON.stringify(manifest,null,2)+'\n');
 // HKCU only: no administrator privilege, system-wide registration or policy changes.
 for(const browser of ['Google\\Chrome','Microsoft\\Edge']){
  const key=`HKCU\\Software\\${browser}\\NativeMessagingHosts\\com.vbk.browser_bridge`;
  execFileSync('reg.exe',['add',key,'/ve','/t','REG_SZ','/d',target,'/f'],{stdio:'inherit'});outputs.push(key);
 }
}
console.log('桥接已为 Chrome 与 Edge 注册。');console.log(outputs.join('\n'));
console.log(`扩展目录：${extension}`);
console.log('首次使用：在 chrome://extensions 或 edge://extensions 开启开发者模式，加载此目录；正式分发应从扩展商店安装。');
