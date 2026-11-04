# 工作状态显示稳定性核对（2026-11-04）

静态读取当前安装包，未运行或修改官方程序。以下是显示链路证据，不代表真实账号接口抓包。

## imWindow-BaGPtUvK.js
路径：`/Applications/旅游商家桌面版.app/Contents/Resources/app.asar.unpacked/dist/js/imWindow-BaGPtUvK.js`
SHA-256：`9b4894abe8eab7274749169b8db0660e43301beeebdd30a4bc384ce216bfce47`
字符偏移 34658：
```js
ACTIVE.values,...We.FINISH.values].includes(p.status||0))}},Bje=(t,r)=>{let{currentStatus:n,conversationList:i=[]}=r;const{conversationList:o=[],currentAgentInfo:d={},lang:s={},userInfo:p}=t;return{...t,currentWorkStatus:n,conversationList:o.length?i.length?Jo(o,i,d,s):o:i}},Vje=(t,r)=>{const{conversationList:n=[],currentAgentInfo:i={},lang:o={}}=t;return{...t,conversationList:Jo(n,[{...r,inGroup:1}],i,o)}},Uje=(t,r)=>{const{conversatio
```
字符偏移 2754367：
```js
tsMobileRequestFilterException"&&(this.logout=!0);return}if(typeof(c==null?void 0:c.currentStatus)<"u"&&$e.sendBroadcastEvent(Xh.updateWorkStatus,{status:c==null?void 0:c.currentStatus,currentBuid:n==null?void 0:n.buid}),!(!c||!((v=c.conversationList)!=null&&v.length))){if(await Ok.write(d,{},c),s){const{conversationList:f=[]}=this.store.getState();c=await bje(c,f,d),h(c)}else{const{status:f}=this.getCurrentConvInfo()||{};p(c);const{sta
```
## index-qM01G1pJ.js
路径：`/Applications/旅游商家桌面版.app/Contents/Resources/app.asar.unpacked/dist/js/index-qM01G1pJ.js`
SHA-256：`8b30aaaad5dfd0f9a705bf6c7143c0a573a75216ff4d369817be62c43915ecca`
字符偏移 6415：
```js
tener((u,y)=>{const{status:S,currentBuid:L}=y||{};switch(u){case se.updateWorkStatus:S!==void 0&&L===r&&n(S);break}})),[]);const m=[{field:"avatarUrl",label:t[i.avatar]||"头像",formClass:jt},{field:"nickName",label:t[i.nickName]||"昵称",formClass:dt}],{tranKey:d="",icon:g,name:p}=Re.find(u=>u.key==a)||{},[C,b]=j.useState(!1);return e.jsx("div",{className:"content",children:e.jsxs(Y,{layout:"horizontal",labelCol:{span:4},wrapperCol:{span:20}
```

观察：列表响应更新 currentWorkStatus，存在 currentStatus 时广播 updateWorkStatus；个人资料按 currentBuid 过滤且仅在 status 非 undefined 时更新。上述路径没有工作状态 15 秒显示过期逻辑。

本地修复：界面保留本账号最后确认的工作状态，未确认刷新不能替换该显示；真实确认状态立即更新。账号/会话重置清空显示记忆。confirmed 与通知有效期保持原语义。

限制：尚未采集用户所述闪动瞬间的运行时 currentStatus，不能排除服务端真实交替返回 3；本修复针对本地 15 秒过期导致的显示闪动。新增测试连续三轮模拟 15 秒过期和 1 秒后恢复，并验证真实下班及账号重置。

## 第二轮：跨账号事件污染

前一轮只处理有效期过期，并未阻断其他账号的已确认状态，因此不能作为根因修复。

宿主 `adapter.rs::emit_agent_status_event` 向同一个主窗口发送所有账号的扁平 `Scoped { status, confirmed, account }`。此前 main.ts 监听仅使用 `isUiAgentStatus`，忽略 account，后台账号的下班会覆盖当前账号，下一次当前账号轮询再恢复。当前运行窗口观察到两个登录账号；没有采集其原始 IPC 时间线，故不能声称已证明用户每次闪动均来自此路径。

修复在事件入口要求完整 owner，并通过 `stillActive` 同时检查 account_id、environment、session_generation；无 owner、其他账号、旧登录代次均丢弃。RPC 返回值继续由其请求上下文保护。mock 同步改为三元组隔离状态，冒烟测试更新为带 owner 的事件。

反证：移除 owner 过滤后，新增三项生产处理函数回归全部失败；保留过滤时全部通过，包括连续20轮交错事件、真实当前账号下班和切换账号/重新登录。独立 Sol / xhigh 对抗性审查未发现生产修复新增 P1/P2，指出的 mock 共用状态与旧 smoke 断言已修正。

全量测试当时 1375/1376 通过，唯一失败为 reopen-send.test.ts「处理中的会话不读回也不重开」多出 other 请求；独立运行同样失败，本轮未修改该业务链。类型检查及 UI 构建通过。尚未替换运行中的桌面安装包。
