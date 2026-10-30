# WebSocket、HTTP 兜底与侧栏文档

2026-10-30。以下来自本轮 ego-browser 实测；HTTP 完整请求见[接口目录](README.md)，凭据由[官方登录页与账号 Profile](authentication.md)承载。

## WebSocket：HTTP 升级与 XMPP

实际地址包括 `wss://im3.ctrip.com/ws-xmpp/`、`wss://im.ctrip.com/ws-xmpp/`。浏览器以 HTTP GET 发起 WebSocket Upgrade，成功响应 101；子协议 `xmpp` 的既有实测及源码依据见[传输调查](../research/2026-10-30-web-im-transport-and-polling.md)。本轮握手 Header 脱敏结构、SASL/auth/success/bind 和心跳帧见 [01](evidence/2026-10-30/01-bootstrap.json)、[54](evidence/2026-10-30/54-sdk-restored-by-official-page-reload.json)。握手 Cookie、Origin、Sec-WebSocket-* 由浏览器与官方 SDK 管理；不能把 SASL 字符串当成脱离该登录态的独立凭据，也不将两条连接未经验证地定义成主备。

## 文本发送与服务端确认

本轮群聊文本的实际外层是 XML，`body` 内是 JSON，其中 `msg` 是文本字符串，不是凭空增加的 `{content:...}` 对象：

```xml
<message to="{{SDK生成的目标JID}}" type="send" id="{{localId}}" xmlns="jabber:client">
  <body>{"chattype":"groupchat","biztype":"1513","localid":"{{localId}}","msg":"{{待发送文本}}","msgtype":"0","autoextend":0,"threadid":""}</body>
</message>
```

`1513` 是该受控业务线的观测值；来源应为当前会话，不全局硬编码。`threadid` 本轮部分文本为空、视频非空，不能把空字符串统一转成 null 或替换成其他会话的线程。

XML 属性与文本由官方 SDK 转义；`msg` 中的引号、换行和 `<>&` 不能用字符串拼接处理，也不能把媒体 JSON 字符串重复序列化。

服务端 `type="send_result"` 的 body 含 `error,reason,chattype,localid,tid,create_time,ts,threadid,present`；本轮 `error=0`，`localid` 与出站帧一致。证据中的 `bodyReferences` 保留动作内对应关系，不保存真实消息 ID。`tid` 与时间供 SDK 确认和后续对账；不把未收到回执直接解释为发送失败或自动补发。[文本发送与回执](evidence/2026-10-30/35-controlled-ws-text-ack.json)。

引用消息的 `citemsgid` 实际位于 XML `message` 属性，并出现在回执属性；不是本次 body JSON 中新增的同名字段。[引用样本](evidence/2026-10-30/40-controlled-quote-send.json)。

## 媒体消息与二次序列化

图片、文件、视频先走各自上传链路，再引用服务端返回的资源信息发消息。它们不是将文件字节直接塞进 XMPP 文本字段。

| 类型 | 请求证据与编码 |
| --- | --- |
| 图片 | [44](evidence/2026-10-30/44-image-body-and-auth-confirmed.json)；`msgtype="1"`，`msg` 为编码后的 JSON 字符串，含 URL、缩略图、尺寸、`btype` 与 ext；保持内层 JSON 字符串编码 |
| 普通文件 | [33](evidence/2026-10-30/33-controlled-file-full-contract.json)；完整 WS bodyTemplate/bodySchema 与原 File 元数据分开保留 |
| 视频 | [68](evidence/2026-10-30/68-controlled-video-upload.json)；`msgtype="3"`，内层 `btype:3,video:{filename,cover,url,duration,size,width,height}`；本轮 duration 为 0.8，UI 显示取整后一秒 |
| 产品卡片 | [39](evidence/2026-10-30/39-controlled-product-card.json)；由业务 HTTP `15529/sendCardMessageForOffline` 发送；不能以普通文本 SDK 发送代替 |

## HTTP 发送兜底

在本任务页面断开官方 SDK 的 Socket 后，仍经官方编辑器发送受控文本，实际出现 `POST https://m.ctrip.com/restapi/soa2/11679/SendMessage.json`。请求包含 `localId,bizType,localTimeStamp,partnerJid,msgType,messageBody,type,threadId,resource,head`，保持其原始类型和 SDK head，完整样本见 [51](evidence/2026-10-30/51-controlled-http-send-fallback.json)。页面显示已确认消息，之后撤回成功；不以 HTTP 200 单独判断业务完成。

重连调用的回调没有在十秒内触发，但随后 `getSocketStatus()` 已为 true；又通过官方页刷新确认连接恢复，见 [54](evidence/2026-10-30/54-sdk-restored-by-official-page-reload.json)。这不能外推为独立宿主、睡眠恢复或所有断线场景已通过。SDK 已有兜底，宿主不能再叠加一个“不论错误都重发”的通用策略。

## 历史、已读与同步

`getMessageList` 的实际响应为 `rangeMessage:{isDone,lastMessageTime,messages}`，不能统一按顶层 `messages` 读取。本轮受控只读重放 pageSize=2，基础/前翻/后翻分别取得 2、2、1 条；`direction=prev` 配 `endTime`，`direction=next` 配 `beginTime`；此样本未包含边界时间本身，游标时间为十三位数字。[分页证明](evidence/2026-10-30/70-history-pagination-proof.json)。同时间戳多消息仍未测试，不能只用“最大时间已见”认定全部补齐。

已读经官方 SDK `putAdviceOfReadByMsgId({partnerJid,msgId,conversationType:"groupchat"})`，实际 HTTP 为 `11679/PutAdviceOfReadByMsgId.json`，目标取当前受控客户消息和对应群号，见 [71](evidence/2026-10-30/71-controlled-read-receipt.json)。与通知中心 `putAdviceofreadIQMessage` 分开，拼写、参数与职责不能混用。

## 侧栏是受鉴权的 HTML 文档

本轮实际发出 GET `/tour/im/ex-area/b`，并加载 `/tour/im/ex-area/b/imExtraInfo`。Query 包含当前群、session、客户 uid、locale、serviceType、status，Header/Cookie 见 [55](evidence/2026-10-30/55-controlled-sidebar-document.json)。响应是 HTML，不是 SOA JSON。

用户信息、来源轨迹、权限和跳转入口等位于该文档内联 `__INITIAL_STATE__`；已解析完整脱敏状态与 schema，见 [56](evidence/2026-10-30/56-controlled-sidebar-ssr-state.json)。没有因为读取到 SSR 数据就声称浏览器调用了 `getVBKImUserInfo/getImPlusModuleJump`。这些服务内部接口与浏览器文档请求分别记证据；需要自研侧栏时仍应补独立契约。

侧栏“详情/PC详情”本次出现桌面版引导，不能当作订单详情成功。正式订单路径是订单页按关联订单号查询 → 唯一详情 → 联系人处“IM 联系”；该次 POST `14361/createimchat` 返回 URL 后，首次页面标题与受控客户一致。[动作与恢复边界](validation.md)。
