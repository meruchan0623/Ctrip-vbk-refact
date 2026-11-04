# 订单来源卡的身份与刷新

2026-10-31。仅解析已采证msgtype7/action=CTL01的ext.dataInfoList：orderid、productName、usedate、platformName、orderamout及ext.title/desc。订单ID保留字符串；缺字段不补造，未知格式不当订单来源。

2026-11-03 修复：订单侧栏不能只依赖最近一页聊天记录。通过 ego-browser 核对当前官方 IM 的独立 `imExtraInfo` iframe 及其 `20-6aafb3cf27.js`，原版使用 `15529/getVbkImUserinfo` 的 `data.sourceTraceInfo.lastSourceTrace.msg` 作为“咨询来源”。该 JSON 字符串包含同一 CTL01 卡片；备注名称来自 `ext.extendInfo.providerProductName`。

在已登录官方页面内对已有会话只读验证 `POST https://m.ctrip.com/restapi/soa2/15529/getVbkImUserinfo`，请求为 `{head:{cver:"1.0",extension:[]},gid:<当前会话字符串>,locale:"zh-CN"}`；HTTP 200、`ResponseStatus.Ack="Success"`、`data.sourceTraceInfo.hasSourceTracePrivilege=true`，`lastSourceTrace` 字段为 `msg/sendTime/action`。卡片中的 `platformName/orderid/productName/usedate/orderamout` 均为非空字符串，原版页面同时完整显示来源渠道、订单 ID、产品名称、使用日期、订单总额和备注名称。本记录不保存真实订单号、客户标识或商品内容。精简 head 的成功不证明其各字段在其他场景均可省略；客户端沿用当前页面上下文的完整 platform head。

客户端在首次加载会话消息时独立补读该来源，不阻塞聊天记录。只有成功响应、明确来源权限、匹配当前订单及仍有效的账号/会话修订才能进入展示缓存。来源请求失败保留已有卡片；旧历史卡片不能抹掉来源字段，之后的新卡片仍可更新非空字段；切换账号、客户、会话或订单后丢弃在途结果。来源时间可能早于当前服务，因此以发起读取时的当前会话修订绑定，不把旧来源冒充刚收到的新消息。

列表没有订单 ID 时，明确具有来源权限的当前 gid 响应可建立当前来源订单；列表已有 ID 时仍要求精确匹配。`assistant.scope` 返回相同的有效订单 ID，修订签名同时绑定该 ID；来源从订单 A 变为 B 时旧查询授权失效，A 的历史卡片不能覆盖 B。独立请求序号拒绝晚到的旧来源响应，包括两个请求在同一毫秒发起的情况。

明确的 `hasSourceTracePrivilege:false` 与临时请求失败分开处理：当前修订及最新读取的明确拒绝会清除来源和卡片展示缓存，撤销此前的查询修订，并阻止迟到历史卡片重新填回这些字段；保留列表自身已有的基本信息。无列表订单 ID 时也同时撤回来源建立的订单身份。网络失败、缺少权限字段或格式错误保留此前结果；旧拒绝响应不能清除较新成功读取。

与官方侧栏对 `lastSourceTrace` 无值或空对象时隐藏来源的行为一致，明确有权限且响应自身包含 `lastSourceTrace:null` 或空对象时也撤回旧来源，使用同样的修订、读取序号和历史卡片防重填校验。缺字段、数组及损坏卡片仍属于无法确认，不能据此清除已验证来源。

本地回归覆盖独立来源水合、权限拒绝、字段映射、错单、稀疏旧卡片、在途切换服务和账号停止；真实官方响应验证不等同于重装后的原生客户端验收。

历史、SDK及补偿入口共同记录来源卡。缓存由gid、当前订单、客服服务会话、客户、thread、worksheet等身份限定；不匹配当前订单的卡不进入侧栏，同身份旧时间不能覆盖新卡，同gid换身份不能继承旧缓存或用旧/同时间卡重新绑定。缓存之外独立跟踪每次身份切换，即使此前没有来源卡也建立新服务器快照时间边界；迟到卡必须严格晚于边界。切换缺有效快照时间时保守拒绝，直到同身份后续有效快照出现。初次观察的匹配订单允许历史来源，不伪造服务开始时间。历史await后重核完整服务/thread/order身份，格式无效时间不能转为0作为来源证据。新来源可独立刷新侧栏，不回退已到达的较新消息预览。

消息卡“查看订单”只在当前账号/环境/认证代次及会话仍匹配、卡订单等于当前侧栏订单时展开。不同订单缺少经验证的逐卡详情URL，明确提示不可用，不打开另一订单、不拼接URL、不发查询/写请求。此分支仍属于功能未完成，不能把提示当作所有历史订单详情已实现。

真实PageSession SDK/补偿与旧代次故障回归11项（原6项加5项新身份边界反例）、实际messageRow onclick4项均有红→绿；CTL01字段与时间保护另有回归。临时证据在/tmp/vbk-goal-20261031/session-order-*、order-transition-owner-{red,green}.tap及/tmp/vbk-order-card-action-*.log。最小独立块同时包含mapper、DTO、缓存、RPC/session、UI侧栏与按钮，排除分页及媒体依赖；真实新包侧栏验收仍待下一轮。
