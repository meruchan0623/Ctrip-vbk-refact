# 消息面板周边操作契约

2026-10-31，源码与离线真实调用链验证；原生新包和真实动作读回仍待验收。此链依赖已登录官方页面的 SOA 上下文，不能宣称无浏览器运行。所有线上出站仍只限任务指定的受控订单/客户，先双核再解析 gid。

| UI / RPC | 官方接口与字段 | 结果边界 |
|---|---|---|
|话术 / im.customer_scripts|getCustomerScripts，content/customerScripts|只验证过空数组；非空条目格式未知，明确 unsupported，不生成话术或发送|
|成员 / im.members|checkMemberStatus，members.uid/nick/avatar/status/roles/rolesv2|仅展示时排除公司 rolesv2=[0,3,5]、非本人 status<=0；本人保留，转交资格仍按原始 status/roles|
|邀请候选 / im.invite_candidates|getInviteMemberListBySkillGroup，worksheetId/groupId/parentSkillGroupIds|按实际 agentUid 关联 nickname/avatar；排本人及当前成员；无头像使用同UID资料或文字占位|
|邀请 / im.invite|inviteVenAgent，venAgentUidList/serviceType/workSheetId|提交前重读成员；独立读回全部目标存在才能 confirmed|
|转交 / im.transfer|transferVenMaster，sessionId/groupId/targetVenAgentUid|只接受明确选中、仍有资格的当前成员；独立读回主客服 roles=[3,4,4]|
|结束 / im.finish|finishConversation，conversationKey/conversationType/sessionId/workSheetId|conversationKey必须真实接口字段，不能由gid/客户别名拼装；独立读回同session status=4且inGroup=-1|

请求体与脱敏证据见同目录 endpoints 中对应接口。成员显示与写权限分别判定，不能把头像或公司过滤当作授权。所有人员ID保留字符串；skillGroupId/worksheetId仅在安全整数范围接受。

选择凭据有效期30秒，绑定打开面板时的gid、service session、conversationKey、worksheetId、serviceType、conversationType、customerUid、页面上下文、本人UID、运行代次及RPC实例。三种写动作都必须携凭据，结束也不例外；过期仅只读刷新，须再次明确确认。提交前和异步成员读回后再次核对上下文，防止旧面板作用于同房间新服务。

结果区分 confirmed、accepted、unknown、not_submitted。只有独立读回确认才是confirmed；接受不等于生效。只有页面明确证明尚未进入上游提交的类型化前置错误返回not_submitted，UI清选择后要求只读刷新再确认；异常、缺失/畸形宿主回执或身份变动继续unknown锁定。

## 跨重建持久屏障

生产三个宿主command均通过peripheral_journal::dispatch_once，位置为应用数据state/peripheral。按environment/account隔离；稳定屏障键为gid/action摘要，具体意图摘要另包含选择token及规范化目标集合，忽略账号代次和selection token变化。未知动作保守锁住同room/action，跨新服务也不会凭新token解锁；当前没有人工清锁或核验后解锁UI，需后续只读reconciler设计。

FileStore CAS + OS文件锁，先持久write_started并同步文件及目录再发RPC，锁不跨await。unknown/accepted不重发；confirmed或可信not_submitted才持久释放，旧token与等待中被挡住的token留下摘要墓碑，不能后来升级为新请求。墓碑达到4096上限fail closed。磁盘/解析/落盘失败不能成为写许可。账本不存正文、目标UID、token原文或上游reason；摘要不是上游幂等键，也不证明网络包已经到达。

链路：peripheralPanel→client/adapterProtocol→主窗口ACL及Rust command→持久屏障→页面RPC→peripheral/SoaClient→独立读回。远程官方webview没有主窗口动作权限。mock明确unsupported，不能伪装真实动作成功。

离线回归保留旧会话误结束、明确未提交无法恢复、重建后unknown重发、并发被挡token后来重新执行的红→绿输出；没有在线结束/邀请/转交验收证据，不以静态注册、按钮出现或测试通过宣称功能已完成。
