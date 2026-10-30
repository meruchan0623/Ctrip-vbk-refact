# 官方 SDK facade：发送与已读回调契约

2026-10-31，Asia/Singapore。依据当前官方页面经 ego-browser 只读取得的 SDK 与应用脚本；本节记录页面 facade，不能用底层 HTTP/XMPP 请求字段替代。第 1 轮原生发送为 unknown，未确认送达；本节实现尚需新包实机验收。

## 证据身份

原始 vendor 脚本仅保存在本机 `/tmp/vbk-goal-20261031/`，不提交源码、凭据、客户正文或签名 URL。

| 临时证据 | UTF-8 字节数 | SHA256 |
| --- | ---: | --- |
| `official-source-0.js`：实际 `window.IMClient` SDK | 198094 | `5d2aacf7a265835f5cea40ae5888e97f4126b4400eecb51c32e61a8873179bb1` |
| `official-app-source-2.js`：实际应用 bridge/调用点 | 834275 | `9aa79e16460e17612ccef3d8a23076039616e7fdd53243f18d51e7dfbd1ed728` |

以下 offset 为解码后 Unicode 字符偏移，非 UTF-8 字节偏移。SDK 的 `sendMessageInSocket` 位于 129983，`validateMessage` 位于 32870，`deserialize` 位于 29760，`buildTextBody` 位于 54916。应用 bridge 的发送调用位于 133556、已读调用位于 134164；这些调用点可用于独立复核。

## 文本发送

签名：`sendMessageInSocket(message, onSuccess, onFailure, timeoutMs?)`。第四参默认 5000 ms；其内部负责 Socket 发送及 `error=-2` / 离线分支的 HTTP fallback，glue 不另发 HTTP、不重新提交。

| 公共 message 字段 | 本地来源与依据 |
| --- | --- |
| `messageType: 0` | SDK 枚举 TextMessage；validateMessage 根据此字段要求 content |
| `content: string` | 原始文本；deserialize 调用 buildTextBody，并把 content 赋给底层 messageBody |
| `toJid: string` | 已缓存、经房间 JID 对账的裸 gid，字符串原样保留；SDK 自行追加域与 resource |
| `conversationType: 'groupchat'` | 文本 SendIntent 的已核准会话类型 |
| `localId` | 宿主 local_id 关联键 |
| `bizType` / `threadId` | 当前会话实际 serviceType / threadId；空 threadId 保留空字符串 |
| `citemsgid?` | 显式引用 ID；deserialize 修改并返回同一 model，随后 Socket/HTTP payload 均显式复制此属性 |

原先 glue 传 `msgType/messageBody/完整 room JID`，这些是较低层的字段；直接交给公共 facade 会缺少 messageType，并可能让 SDK 再次追加域。新实现使用公共文本模型。本行为仅实现文本 facade。非 0 的 msgtype 在调用官方 facade 前明确抛出 unsupported；此时调用次数为 0。submitIntent 对所有同步抛错仍保守返回 unknown，此行为不声称媒体发送完成；UI 附件选择入口保留、附件发送继续阻断。图片/视频/文件需要下一独立行为按已取得的 validateMessage/deserialize 证据映射公共字段。

成功回调收到 SDK 原始响应，以非空、精度完整的 `msgId` 确认；`msgCreateTime` 为服务端时间。若响应含 localId，必须匹配本次调用。失败回调中的非零安全整数 `error` 才转换为明确 rejected，`errmsg` 转为 reason。缺 ID、unsafe number、矛盾的关联 ID、畸形回执或没有回调均保留 unknown，不能制造确认或重发。

官方 SDK 的原始 Socket `send_result.error=-2` 是内部 HTTP fallback 的中间信号，不能提前变成可重试失败。glue 仅对本次 facade 管理的 localId 屏蔽原始 ACK（包括 raw 0 / 其它错误），以最终 callback / 有效 Promise 回执为准；其余未管理的协议事件保留原语义。追踪默认 15 秒，到期返回 unknown，不重发；成功、失败、抛错、dispose 均清理追踪与定时器，最多同时保留 1000 个待处理项。超时后的旧 callback 不能改变已完成结果。

保留现有 Promise facade 的兼容路径及 ID 精度判据；它不是当前官方 SDK 的主契约。callback/Promise 重复完成只处理第一次；disposed 或 facade 对象更换后的回调不能确认旧调用。

## 已读回执

签名：`putAdviceOfReadByMsgId(request, onSuccess, onFailure)`，SDK offset 44359。内部把 `partnerJid/msgId/conversationType` 映射为 HTTP 的 `partnerJid/msgId/type`。应用调用点明确使用 `fromGid`，所以传裸 gid，不传含域的房间 JID。

SDK 的该 wrapper 没有返回 Promise；void 返回不代表成功。glue 等成功回调后检查其响应：SDK fetch 保留原始 SOA body，接受 `ResponseStatus` 或 `responseStatus` 的 `Ack='Success'` / 数字 0；已有空成功样本见 [PutAdviceOfReadByMsgId](endpoints/m.ctrip.com-11679-PutAdviceOfReadByMsgId.json-post.md)。非空错误数组、畸形回调及超时不能确认。明确拒绝返回 failure；其余不确定结果抛出 unknown，由 markRead 保持 unknown，不能清零服务端未读数。

已读等待默认 15 秒，facade 与既有无-facade HTTP 路径均使用同一等待/绑定/销毁屏障，dispose 会结束等待并清理定时器；晚到的 HTTP 成功也不能覆盖 unknown。只有完全没有 facade 已读方法时才调用既有 HTTP 实现；facade 方法已调用后，无论回调失败、缺失或超时，都不追加 HTTP 请求。

## 离线验收与范围

新增 `sdk-facade-contract.test.ts` 直接连接真实 `createPageSdk → submitIntent`，不使用 FakePageSdk 替代 glue。修复前 5 项契约测试全部失败；输出 `/tmp/vbk-goal-20261031/round2-sdk-facade-red.tap`。独立评审又复现 raw -2 抢先完成、raw 0 / 其它错误抢先完成及 timeout 被错判 rejected，新增回归修复前 3 失败 / 11 通过，输出 `round2-sdk-fallback-red.tap`。修复后的新测试及既有 SDK boundary/lifecycle 测试输出 `round2-sdk-facade-green.tap`，覆盖精度、回调三态、重复回执、超时、dispose 和 binding 更换。

原生连接诊断摘要为 `/tmp/vbk-goal-20261031/round1-native-socket-summary.json`：02:52:16 与 02:55:37 两次观测 WebSocket task 归零，随后重建；没有捕获 close code 或 SDK error，不能将断开根因归结为 SDK 参数、sandbox 或后台冻结。W 在历史加载后出现，首次入站通道仍未证明。发送/已读 facade 修复与这项连接根因调查分别验收。

## 生命周期与通道矩阵复核

在 raw -2、HTTP 已读 dispose、排队旧 raw 三类缺口连续出现后，改为一次性核对 4 个通道 × 4 种生命周期 × 3 类结果，共 48 格；另保留前面的真实联合回归。检查使用 createPageSdk 的实际 emit / settle 路径，没有以 FakePageSdk 代替。

| 通道 | active：成功 / 拒绝 / 畸形 | disposed | rebound | timeout 后晚到 |
| --- | --- | --- | --- | --- |
| 发送 callback | confirmed / 明确 rejected / unknown | 不确认，最终 unknown | 旧 facade 回执 unknown | 不改变 unknown |
| 发送 Promise 兼容 | 有效 ID confirmed；transport rejection 与畸形 unknown | unknown | unknown | 不改变 unknown |
| 本次 facade 管理的 raw stanza | 中间事件，不决定最终结果；无最终回调则 unknown | 排队旧事件不发布 | 旧 XMPP binding 不发布 | 原调用保持 unknown |
| 既有 HTTP 已读路径 | success / failure / 畸形 unknown | unknown | unknown | 不改变 unknown |

未管理的原始协议 ACK 在当前活跃绑定下仍按原语义发布；不把全局 raw -2 改成成功或吞掉所有历史事件。SDK 已读 callback 与 HTTP 已读共用同一个 settle 屏障，已有已读用例另外覆盖空返回、畸形 Ack、超时、销毁与 facade 更换。

修复前矩阵及相关回归为 60 通过 / 5 失败，证据 `round2-sdk-lifecycle-matrix-red.tap`：两个排队 raw disposed 格失败；旧绑定排队 message/status/stanza 的独立回归失败；排队 disposed 独立回归失败；HTTP active malformed 格失败。

最终不变量：

1. 所有 SDK 事件经过同一 emit；disposed 后不再向业务监听者发布。
2. 每次 attach 捕获独立 binding generation，同时核对当前 xmppClient 对象；removeListener 之外再阻断已排队的旧 source 回调，涵盖 stanza、status、reconnecting。
3. facade 管理的发送只由最终 callback / Promise 结算一次；有界追踪清理不能使已销毁 source 的 raw ACK 重新获得发布权限。
4. 所有已读完成都经过同一 settle，验证结果类型、当前 facade 与 disposed 状态；超时、异常与畸形不能成为成功。

修复后同矩阵及既有 SDK boundary/lifecycle 测试输出仍为 `round2-sdk-facade-green.tap`；未更改旧测试断言。原生断线原因与新包实机收发仍单独验收。


## 入站同步帧

同一已采集官方SDK的 `xmppSerialize` 在字符偏移29322/29495将 `sys_mam` 归入单聊、`sys_muc` 归入群聊；from/to、消息ID、正文保持原字段语义。适配器现将这两个wire type规范为现有chat/groupchat，再走相同事件与展示转换，不能当作未知控制帧忽略。专项真实 `stanzaToEvent → sdkMessageToUi` 两项修复前均以ignore失败，修复后与普通帧投影相等；红日志 `sdk-sync-stanza-red.tap`。

第2轮反向W仅历史加载后出现，但未取得native原始wire type，因此本修复是已证实协议缺口修复，尚不能归结为W实时缺口根因。仍需下轮实机验证。

独立暂存副本另外暴露单聊裸JID发送者被误作unknown（1通过/1失败）；同步修正SDK单聊发送者取from，群聊只允许resource作为发送者，不把裸room识别成客户。新增裸room反向保护，既有断言保留。


单聊地址依据同SDK `parseFromJid` 字符偏移32157：显式当前selfUid决定对端，不使用可覆盖的role标签来猜自己。入站peer→self取peer为gid，出站self→peer仍取peer；普通设备resource不能冒充发送者。事实与显示共用 `resolveSdkAddress`，缺self身份时单聊保守不投影。新增chat/sys_mam双向合成回归，旧实现2通过/3失败（self误作gid、device误作发送者），修复后5项通过。群聊继续以room/resource分别识别房间与发送者，裸room不是客户身份。

完整独立index暴露既有facts.review把type=groupchat的裸from误作发送者（289项中1失败）；依据已核实群聊room/resource规则精确迁移为裸身份空值，并新增带resource的正例，未删测试或减少判据。
