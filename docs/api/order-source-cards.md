# 订单来源卡的身份与刷新

2026-10-31。仅解析已采证msgtype7/action=CTL01的ext.dataInfoList：orderid、productName、usedate、platformName、orderamout及ext.title/desc。订单ID保留字符串；缺字段不补造，未知格式不当订单来源。

历史、SDK及补偿入口共同记录来源卡。缓存由gid、当前订单、客服服务会话、客户、thread、worksheet等身份限定；不匹配当前订单的卡不进入侧栏，同身份旧时间不能覆盖新卡，同gid换身份不能继承旧缓存或用旧/同时间卡重新绑定。缓存之外独立跟踪每次身份切换，即使此前没有来源卡也建立新服务器快照时间边界；迟到卡必须严格晚于边界。切换缺有效快照时间时保守拒绝，直到同身份后续有效快照出现。初次观察的匹配订单允许历史来源，不伪造服务开始时间。历史await后重核完整服务/thread/order身份，格式无效时间不能转为0作为来源证据。新来源可独立刷新侧栏，不回退已到达的较新消息预览。

消息卡“查看订单”只在当前账号/环境/认证代次及会话仍匹配、卡订单等于当前侧栏订单时展开。不同订单缺少经验证的逐卡详情URL，明确提示不可用，不打开另一订单、不拼接URL、不发查询/写请求。此分支仍属于功能未完成，不能把提示当作所有历史订单详情已实现。

真实PageSession SDK/补偿与旧代次故障回归11项（原6项加5项新身份边界反例）、实际messageRow onclick4项均有红→绿；CTL01字段与时间保护另有回归。临时证据在/tmp/vbk-goal-20261031/session-order-*、order-transition-owner-{red,green}.tap及/tmp/vbk-order-card-action-*.log。最小独立块同时包含mapper、DTO、缓存、RPC/session、UI侧栏与按钮，排除分页及媒体依赖；真实新包侧栏验收仍待下一轮。
