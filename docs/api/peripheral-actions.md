# 消息面板周边操作契约

2026-10-31，源码与离线真实调用链验证；原生新包和真实动作读回仍待验收。此链依赖已登录官方页面的 SOA 上下文，不能宣称无浏览器运行。所有线上出站仍只限任务指定的受控订单/客户，先双核再解析 gid。

| UI / RPC | 官方接口与字段 | 结果边界 |
|---|---|---|
|话术 / im.customer_scripts|getCustomerScripts，content/customerScripts|2026-11-03 非空字段核对通过，200ms 联想，选中只替换草稿；未知条目仍 unsupported|
|话术分类 / im.quick_reply_categories|getCategories，VAGENT/VSKILLGROUP|个人/团队分类及筛选，选中纯文本追加草稿，不自动发送|
|产品推荐 / im.recommend_products、im.recommend_cities|queryRecommendProductList、queryIMSuggestCityList|会话内关键词、城市、0 起分页查询；权限与客户版卡片字段校验|
|产品卡片 / im.send_product_card|sendCardMessageForOffline，inSession:true|缓存选择令牌、发送前会话核对、宿主持久防重；当前版本未做真实发送验收，见[本轮记录](../research/2026-11-03-chat-commerce.md)|
|成员 / im.members|checkMemberStatus，members.uid/nick/avatar/status/roles/rolesv2|仅展示时排除公司 rolesv2=[0,3,5]、非本人 status<=0；本人保留；按主客服→客服→客人→机器人排序并给出 role/present/is_self；`self_is_master` 与 can_transfer/can_remove 只决定按钮，写入前仍重读|
|邀请候选 / im.invite_candidates|getInviteMemberListBySkillGroup（worksheetId/groupId/parentSkillGroupIds）；keywords 时走 searchInviteMemberListBySkillGroup|按实际 agentUid 关联 nickname/avatar；排本人；当前成员保留为 in_group 禁用项；带 status/duty_status/job_position；extend_token 让逐级展开的候选并入同一选择凭据|
|邀请 / im.invite|inviteVenAgent，venAgentUidList/serviceType/workSheetId|提交前重读成员；独立读回全部目标存在才能 confirmed|
|转交 / im.transfer|transferVenMaster，sessionId/groupId/targetVenAgentUid|只接受明确选中、仍有资格的当前成员；独立读回主客服 roles=[3,4,4]|
|结束 / im.finish|finishConversation，conversationKey/conversationType/sessionId/workSheetId|conversationKey必须真实接口字段，不能由gid/客户别名拼装；独立读回同session status=4且inGroup=-1|
|移除成员 / im.remove|finishConversation + 非空 venAgentUids（证据 30）|独立命令与独立屏障（Action::Remove），空列表在宿主、RPC、适配器三层拒绝，绝不退化为结束；仅当前主客服可提交，目标须为在群商家坐席且非本人；读回全部目标不在群才 confirmed|

请求体与脱敏证据见同目录 endpoints 中对应接口。成员显示与写权限分别判定，不能把头像或公司过滤当作授权。所有人员ID保留字符串；skillGroupId/worksheetId仅在安全整数范围接受。

会话头的人数/主客服胶囊和对话列表的主客服胶囊只读 `im.members` 的前端缓存：人数只计 `present !== false` 的成员（status 1/4，含客人和机器人；成员面板「当前成员 · N」还含 status 2 的已离群成员，两者可能不同），主客服仅看 `self_is_master === true`，不使用会话列表的 `is_owner`；已结束会话不显示。缓存由后台限速扫描进行中会话填充，并随成员面板的读取更新，可能有最多数分钟延迟，未扫到时无胶囊不代表不是主客服。胶囊只用于展示，写权限仍按上文在提交前重读判定。

选择凭据有效期30秒，绑定打开面板时的gid、service session、conversationKey、worksheetId、serviceType、conversationType、customerUid、页面上下文、本人UID、运行代次及RPC实例。三种写动作都必须携凭据，结束也不例外；过期仅只读刷新，须再次明确确认。提交前和异步成员读回后再次核对上下文，防止旧面板作用于同房间新服务。

结果区分 confirmed、accepted、unknown、not_submitted。只有独立读回确认才是confirmed；接受不等于生效。只有页面明确证明尚未进入上游提交的类型化前置错误返回not_submitted，UI清选择后要求只读刷新再确认；异常、缺失/畸形宿主回执或身份变动继续unknown锁定。

## 跨重建持久屏障

生产三个宿主command均通过peripheral_journal::dispatch_once，位置为应用数据state/peripheral。按environment/account隔离；稳定屏障键为gid/action摘要，具体意图摘要另包含选择token及规范化目标集合，忽略账号代次和selection token变化。未知动作保守锁住同room/action，跨新服务也不会凭新token解锁；当前没有人工清锁或核验后解锁UI，需后续只读reconciler设计。

FileStore CAS + OS文件锁，先持久write_started并同步文件及目录再发RPC，锁不跨await。unknown/accepted不重发；confirmed或可信not_submitted才持久释放，旧token与等待中被挡住的token留下摘要墓碑，不能后来升级为新请求。墓碑达到4096上限fail closed。磁盘/解析/落盘失败不能成为写许可。账本不存正文、目标UID、token原文或上游reason；摘要不是上游幂等键，也不证明网络包已经到达。

链路：peripheralPanel→client/adapterProtocol→主窗口ACL及Rust command→持久屏障→页面RPC→peripheral/SoaClient→独立读回。远程官方webview没有主窗口动作权限。mock明确unsupported，不能伪装真实动作成功。

离线回归保留旧会话误结束、明确未提交无法恢复、重建后unknown重发、并发被挡token后来重新执行的红→绿输出；没有在线结束/邀请/转交验收证据，不以静态注册、按钮出现或测试通过宣称功能已完成。

Windows接续已将本账本与文本账本统一使用FileStore严格文件/目录同步，解决只读句柄OS5，保留所有失败关闭准入的规则及13项原周边回归。创建链、原子替换与平台适用边界见[宿主发送屏障](outbound-journal.md)。未执行真实邀请、转交或结束。


## 2026-11-03 官方桌面版对照与修正

依据官方 Mac 1.2.13 `app.asar.unpacked/dist/js/imWindow-*.js`（静态阅读，未执行）还原群聊人员面板 `KEGe`、成员列表 `UEe/GEe`、邀请弹窗 `xyt` 与 `BaseController.deleteChatMember/transferVenMaster/refreshGroupMember`：

- **在群判定**：官方邀请去重以 `status == 1 || status == 4` 视为已在群；实测主客服、受邀成员常为 `"4"`，`"2"` 为已不在群样本。此前适配器只认 `"1"`，导致转交候选为空、已在群成员仍可被邀请、读回无法确认。现改为 1/4。
- **角色**：主客服 `roles[1]==4`（q0e）；商家坐席 `roles[2]==4`（勾选框与 W0e），另排除 rolesv2[2] 为客人(1)/携程侧(2/3/5)。展示顺序与官方一致，主客服头像加标记。
- **群聊人员面板**：标题「群聊人员（N）」「已选 N 人」，按钮「转移主客服」（恰好一人）、「邀请成员」、「移除成员」（确认「确定要移除会话成员？」）。官方另有旅游群主 `getGroupOwner/updateGroupOwner`、改群名、欢迎语、复制新建群，本轮未实现（X20 范围决策）。
- **邀请成员**：官方为「供应商客服（多选）」懒加载技能组树 + 穿梭框 + 关键词搜索 + 筛选（聊天状态 0在线/1挂起/2离开/3下班、上班状态、职位）。本轮实现树、搜索、状态圆点/上下班/职位与已选栏；**未实现**筛选参数（字段 `status/dutyStatus/jobPositions` 合入请求体，未实测）与「携程客服（单选）」`getInviteCtripData/inviteCtrip`（当前账号未返回技能组）。
- 以上均为离线测试验证（TS 1011、Rust 216、门禁、UI 冒烟），**尚无新客户端的在线邀请/移除/转交受控样本**，不能据此宣称线上验收通过。
