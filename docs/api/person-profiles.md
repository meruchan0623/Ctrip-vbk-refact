# 人员身份与接口头像

2026-10-31用户要求每个人头像正确来自接口。人员关联键使用IM uid，不用客服昵称、平台buid、agentId、gid或订单号替代。每个PageSession独立RoleBook，不能跨账号复用缓存。

| 来源 | 字段/关联 | 用途 |
|---|---|---|
|13500/checkMemberStatus|members[].uid/nick/avatar|会话成员及历史参与者资料；所有角色按uid存取|
|16037/getRemarkList gid模式|remarkList[].username/nickName/avatar|同uid资料补充与备注；不是会话ID|
|11679/GetMyInfo.json|jid本地部分、name、avatar|本人IM身份及默认资料|
|16037/getVenAgentByUid|venAgent.ctripUid/nickname/avatar|仅ctripUid与本人IM uid匹配时覆盖本人展示资料|

官方当前源码app-source-2（SHA256 9aa79e16460e17612ccef3d8a23076039616e7fdd53243f18d51e7dfbd1ed728）offset211800/321340以本人ctripUid匹配并优先venAgent头像；其他人取memberHash[fromUid].avatar。本人权威资料在boot→session播种，后续members旧快照不能覆盖它；身份不匹配则只用GetMyInfo本人资料。平台账号昵称仍与消息发送者资料分别处理。

本次ego重新读取受控会话成员HTTP200/AckSuccess，4条均含uid/nick/avatar，头像均为dimg04.c-ctrip.com的https地址。页面同地址图片本人7处、客户11处已加载；公司与机器人当前可见区无匹配图，不能写成其头像视觉验收通过。原始响应和逐项DOM比较仅保留/tmp/vbk-goal-20261031/avatars-members-readback.json、avatars-dom-comparison.json，不将身份或URL写入Git。各端点脱敏字段样本见docs/api/endpoints。

回归：readIdentity本人匹配/不匹配、真实RoleBook+SoaClient成员和备注读回、账户隔离、本人优先级/拒错uid；初始1通过3失败→4通过；boot真实链新增头像播种断言。消息DTO/历史实时投影、UI回执保留/失败占位另分块验证；仅资料缓存通过不代表整个头像功能或三端视觉完成。

## 消息投影与显示（源码验收）

SDK实时、HTTP历史/补偿及本人发送echo均携带sender_id/sender_name/sender_avatar；Rust DTO以默认值兼容旧无头像输入。宿主与UI只为同一已知UID或同角色缺ID回执保留资料，明确UID冲突绝不继承旧头像。真实宿主合并回归原先串入Person A失败，修复后通过；UI回执擦除与失败占位回归红→绿7项。

消息行显示API姓名/UID及对应头像，仅允许无用户名密码的https URL，缺失或图片错误回退当前人文字占位。五个不同UID同昵称的SDK/HTTP投影仍逐项对应各自头像；成员异步加载补全已到达消息，stop/restart后迟到结果不得再投影（实际停止回归先2通过1失败，修复后含restart共4通过）。布局仍按角色靠左右，头像不决定身份或出站权限。列表、成员选择器及账号菜单头像尚未在本块完成，下一轮原生验证不能省略。

独立评审实际复现迟到头像全消息重放会把confirmed覆盖为null；修复为message_profiles专用增量，只含消息关联ID、sender_id/name/avatar。宿主仅更新已存在且消息/发送者均匹配的资料，不新建消息，保留正文、original、quote、时间和disposition；DTO拒绝额外text字段。真实session+RPC回归旧行为3通过2失败（完整消息3次而非2次），修复5通过；宿主另验证confirmed全内容不变和跨身份/冲突消息ID拒绝。
