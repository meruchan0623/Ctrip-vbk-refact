# POST m.ctrip.com/restapi/soa2/16037/getLatestConversationByGid

状态：真实网页请求样本；完整实施准入尚未通过。固定网页版本、鉴权边界和占位符规则见 [鉴权说明](../authentication.md)。

- 完整地址：`https://m.ctrip.com/restapi/soa2/16037/getLatestConversationByGid`
- 请求方法：`POST`
- 范围：网页消息/身份/联系入口及共享读取契约
- 编码：JSON；HTTP Content-Type 见下表，不能由 body.contentType 推断
- Authentication：本轮浏览器 Cookie 会话；逐项 Cookie 必需性未证明，见鉴权说明
- 原始证据：[evidence/2026-10-30/02-controlled-open.json](../evidence/2026-10-30/02-controlled-open.json)、[evidence/2026-10-30/08-controlled-start-chat.json](../evidence/2026-10-30/08-controlled-start-chat.json)、[evidence/2026-10-30/14-upload-full-payload.json](../evidence/2026-10-30/14-upload-full-payload.json)、[evidence/2026-10-30/21-transfer-conversation-open.json](../evidence/2026-10-30/21-transfer-conversation-open.json)、[evidence/2026-10-30/23-transfer-target-open.json](../evidence/2026-10-30/23-transfer-target-open.json)、[evidence/2026-10-30/27-return-to-controlled.json](../evidence/2026-10-30/27-return-to-controlled.json)、[evidence/2026-10-30/48-finish-server-readback.json](../evidence/2026-10-30/48-finish-server-readback.json)、[evidence/2026-10-30/49-controlled-reopen-after-finish.json](../evidence/2026-10-30/49-controlled-reopen-after-finish.json)、[evidence/2026-10-30/55-controlled-sidebar-document.json](../evidence/2026-10-30/55-controlled-sidebar-document.json)、[evidence/2026-10-30/73-color-orange-server-readback.json](../evidence/2026-10-30/73-color-orange-server-readback.json)、[evidence/2026-10-30/75-color-restored-server-readback.json](../evidence/2026-10-30/75-color-restored-server-readback.json)

## HTTP 请求 Header

| Header | 本轮值/占位符 | 生成方 |
| --- | --- | --- |
| `:authority` | `{{header.:authority:string}}` | HTTP/2 传输层伪头；不写入应用 fetch headers |
| `:method` | `{{header.:method:string}}` | HTTP/2 传输层伪头；不写入应用 fetch headers |
| `:path` | `{{header.:path:string}}` | HTTP/2 传输层伪头；不写入应用 fetch headers |
| `:scheme` | `{{header.:scheme:string}}` | HTTP/2 传输层伪头；不写入应用 fetch headers |
| `accept` | `*/*` | 对应业务请求层/SDK；以本接口实际值为准 |
| `accept-encoding` | `{{header.accept-encoding:string}}` | 浏览器/网络栈；复用当前 Profile，不手工设置受限头 |
| `accept-language` | `{{header.accept-language:string}}` | 浏览器/网络栈；复用当前 Profile，不手工设置受限头 |
| `content-length` | `{{header.content-length:string}}` | 浏览器/网络栈；复用当前 Profile，不手工设置受限头 |
| `content-type` | `application/json` | 对应业务请求层/SDK；以本接口实际值为准 |
| `cookie` | `UBT_VID={{cookie}}; GUID={{cookie}}; _RSG={{cookie}}; _RDG={{cookie}}; _RGUID={{cookie}}; vbk_login_cid={{cookie}}; _RF1={{cookie}}; vbkticket={{cookie}}; bticket={{cookie}}; BDUID={{cookie}}; vbk-locale-lang={{cookie}}; vbk-menu-business-id={{cookie}}; vbk-menu-business-parameter={{cookie}}; ibulanguage={{cookie}}; ibulocale={{cookie}}; cookiePricesDisplayed={{cookie}}; _wb_wh={{cookie}}; _bfa={{cookie}}` | 浏览器/网络栈；复用当前 Profile，不手工设置受限头 |
| `cookieorigin` | `https://vbooking.ctrip.com` | 对应业务请求层/SDK；以本接口实际值为准 |
| `origin` | `https://vbooking.ctrip.com` | 浏览器/网络栈；复用当前 Profile，不手工设置受限头 |
| `priority` | `{{header.priority:string}}` | 浏览器/网络栈；复用当前 Profile，不手工设置受限头 |
| `referer` | `https://vbooking.ctrip.com/` | 浏览器/网络栈；复用当前 Profile，不手工设置受限头 |
| `sec-ch-ua` | `"Not:A-Brand";v="8", "Chromium";v="156", "Google Chrome";v="156"` | 浏览器/网络栈；复用当前 Profile，不手工设置受限头 |
| `sec-ch-ua-mobile` | `?0` | 浏览器/网络栈；复用当前 Profile，不手工设置受限头 |
| `sec-ch-ua-platform` | `"macOS"` | 浏览器/网络栈；复用当前 Profile，不手工设置受限头 |
| `sec-fetch-dest` | `empty` | 浏览器/网络栈；复用当前 Profile，不手工设置受限头 |
| `sec-fetch-mode` | `cors` | 浏览器/网络栈；复用当前 Profile，不手工设置受限头 |
| `sec-fetch-site` | `same-site` | 浏览器/网络栈；复用当前 Profile，不手工设置受限头 |
| `user-agent` | `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36` | 浏览器/网络栈；复用当前 Profile，不手工设置受限头 |
| `w-payload-source` | `{{header.w-payload-source:string}}` | 平台公共请求/风控/埋点层；动态生成，算法未全部闭环 |
| `x-ctx-country` | `CN` | 对应业务请求层/SDK；以本接口实际值为准 |
| `x-ctx-currency` | `CNY` | 对应业务请求层/SDK；以本接口实际值为准 |
| `x-ctx-locale` | `zh-CN` | 对应业务请求层/SDK；以本接口实际值为准 |
| `x-ctx-ubt-pageid` | `{{header.x-ctx-ubt-pageid:string}}` | 平台公共请求/风控/埋点层；动态生成，算法未全部闭环 |
| `x-ctx-ubt-pvid` | `{{header.x-ctx-ubt-pvid:string}}` | 平台公共请求/风控/埋点层；动态生成，算法未全部闭环 |
| `x-ctx-ubt-sid` | `{{header.x-ctx-ubt-sid:string}}` | 平台公共请求/风控/埋点层；动态生成，算法未全部闭环 |
| `x-ctx-ubt-vid` | `{{header.x-ctx-ubt-vid:string}}` | 平台公共请求/风控/埋点层；动态生成，算法未全部闭环 |
| `x-ctx-wclient-req` | `{{header.x-ctx-wclient-req:string}}` | 平台公共请求/风控/埋点层；动态生成，算法未全部闭环 |
| `x-tour-auth-from` | `vbk_online` | 对应业务请求层/SDK；以本接口实际值为准 |

以上为观察到的请求头，包含 CDP ExtraInfo。出现不代表逐项必需；浏览器自动字段、风控字段和应用字段分开处理。

## Query 参数

```json
{
  "_fxpcqlniredt": "{{query._fxpcqlniredt:string}}",
  "x-traceID": "{{query.x-traceID:string}}"
}
```

`_fxpcqlniredt`、`x-traceID` 如出现，由平台公共请求层处理；nonce、时间戳和上传 rand 不可复制为常量。

## 完整请求样本与分支

`{{字段路径:类型}}` 是脱敏占位符，不能作为字面量发出。数字占位符的原始类型以参数表为准。数组不截断；JSON 字符串仍保留字符串编码。

### 样本 1：49-controlled-reopen-after-finish / HTTP 200 / Ack Success

```json
{
  "head": {
    "cid": "{{body.head.cid:string}}",
    "ctok": "",
    "cver": "2",
    "lang": "01",
    "sid": "{{body.head.sid:string}}",
    "syscode": "09",
    "auth": "",
    "xsid": "",
    "extension": [
      {
        "name": "cpc",
        "value": "pc"
      },
      {
        "name": "protocal",
        "value": "https"
      },
      {
        "name": "amp-product-type",
        "value": "IM"
      },
      {
        "name": "amp-account-source",
        "value": "VBK"
      },
      {
        "name": "client-source",
        "value": "pc-900004"
      },
      {
        "name": "locale",
        "value": "zh-CN"
      }
    ],
    "appId": "900004"
  },
  "gid": "{{body.gid:string}}"
}
```

### 样本 2：55-controlled-sidebar-document / HTTP 200 / Ack Success

```json
{
  "head": {
    "cid": "{{body.head.cid:string}}",
    "ctok": "",
    "cver": "2",
    "lang": "01",
    "sid": "{{body.head.sid:string}}",
    "syscode": "09",
    "auth": "",
    "xsid": "",
    "extension": [
      {
        "name": "cpc",
        "value": "pc"
      },
      {
        "name": "protocal",
        "value": "https"
      },
      {
        "name": "amp-product-type",
        "value": "IM"
      },
      {
        "name": "amp-account-source",
        "value": "VBK"
      },
      {
        "name": "client-source",
        "value": "pc-900004"
      },
      {
        "name": "locale",
        "value": "zh-CN"
      }
    ],
    "appId": "900004"
  },
  "gid": "{{body.gid:string}}"
}
```

### 样本 3：48-finish-server-readback / HTTP 200 / Ack Success

```json
{
  "head": {
    "cid": "{{body.head.cid:string}}",
    "ctok": "",
    "cver": "2",
    "lang": "01",
    "sid": "{{body.head.sid:string}}",
    "syscode": "09",
    "auth": "",
    "xsid": "",
    "extension": [
      {
        "name": "cpc",
        "value": "pc"
      },
      {
        "name": "protocal",
        "value": "https"
      },
      {
        "name": "amp-product-type",
        "value": "IM"
      },
      {
        "name": "amp-account-source",
        "value": "VBK"
      },
      {
        "name": "client-source",
        "value": "pc-900004"
      },
      {
        "name": "locale",
        "value": "zh-CN"
      }
    ],
    "appId": "900004"
  },
  "gid": "{{body.gid:string}}"
}
```

### 样本 4：75-color-restored-server-readback / HTTP 200 / Ack Success

```json
{
  "head": {
    "cid": "{{body.head.cid:string}}",
    "ctok": "",
    "cver": "2",
    "lang": "01",
    "sid": "{{body.head.sid:string}}",
    "syscode": "09",
    "auth": "",
    "xsid": "",
    "extension": [
      {
        "name": "cpc",
        "value": "pc"
      },
      {
        "name": "protocal",
        "value": "https"
      },
      {
        "name": "amp-product-type",
        "value": "IM"
      },
      {
        "name": "amp-account-source",
        "value": "VBK"
      },
      {
        "name": "client-source",
        "value": "pc-900004"
      },
      {
        "name": "locale",
        "value": "zh-CN"
      }
    ],
    "appId": "900004"
  },
  "gid": "{{body.gid:string}}"
}
```

## 参数类型与来源

| 位置 | 实测类型 | 来源与限制 |
| --- | --- | --- |
| `(body)` | `object` | 本轮实际观测值；必填性、默认值及完整取值范围未由单次样本证明 |
| `head` | `object` | 该接口所属请求层生成；见 authentication.md 两类 head |
| `head.cid` | `string` | 公共请求层补入的客户端标识；具体合并来源尚需逐调用点核实 |
| `head.ctok` | `string` | 对应请求层的公共 head；见 authentication.md，不与 HTTP Header 合并 |
| `head.cver` | `string` | 对应请求层的公共 head；见 authentication.md，不与 HTTP Header 合并 |
| `head.lang` | `string` | 对应请求层的公共 head；见 authentication.md，不与 HTTP Header 合并 |
| `head.sid` | `string` | 公共请求层补入的字段；不可将单次样本推定为全局常量 |
| `head.syscode` | `string` | 对应请求层的公共 head；见 authentication.md，不与 HTTP Header 合并 |
| `head.auth` | `string` | 本轮 Cookie 请求为空；显式 token 分支与 Cookie 分支分开 |
| `head.xsid` | `string` | 对应请求层的公共 head；见 authentication.md，不与 HTTP Header 合并 |
| `head.extension` | `array` | 对应请求层的公共 head；见 authentication.md，不与 HTTP Header 合并 |
| `head.extension[]` | `object` | 对应请求层的公共 head；见 authentication.md，不与 HTTP Header 合并 |
| `head.extension[].name` | `string` | 对应 head 配置的准确名称，protocol 与 protocal 不同 |
| `head.extension[].value` | `string` | 对应协议扩展的实际常量或运行时上下文，见完整示例与鉴权文档 |
| `head.appId` | `string` | 对应请求层的公共 head；见 authentication.md，不与 HTTP Header 合并 |
| `gid` | `string` | 当前会话 conversation.gid；不得由客户 UID 或订单号拼造 |

“观测到”不等于“必填”。本轮未进行完整删字段/边界矩阵，不编造 required、默认值、枚举或省略行为。

## 响应与读回

完整响应结构和脱敏实例在以上证据的 responseSchema / responseTemplate；上传另有 xhr.response。HTTP 200、Ack Success 和最终业务状态分别判断。

```json
{
  "ResponseStatus": {
    "Timestamp": "{{response.ResponseStatus.Timestamp:string}}",
    "Ack": "Success",
    "Extension": [
      {
        "Id": "{{response.ResponseStatus.Extension[0].Id:string}}",
        "Value": "{{response.ResponseStatus.Extension[0].Value:string}}"
      },
      {
        "Id": "{{response.ResponseStatus.Extension[1].Id:string}}",
        "Value": "{{response.ResponseStatus.Extension[1].Value:string}}"
      }
    ]
  },
  "bizResponseStatus": {
    "resultCode": "SUCCESS"
  },
  "conversation": {
    "uid": "{{response.conversation.uid:string}}",
    "venAgentId": "{{response.conversation.venAgentId:string}}",
    "serviceType": "1513",
    "id": "{{response.conversation.id:number}}",
    "gid": "{{response.conversation.gid:string}}",
    "threadId": "{{response.conversation.threadId:string}}",
    "conversationKey": "{{response.conversation.conversationKey:string}}",
    "firstMessageTime": "{{response.conversation.firstMessageTime:number}}",
    "lastMessageTime": "{{response.conversation.lastMessageTime:number}}",
    "skillGroupCode": "{{response.conversation.skillGroupCode:string}}",
    "refId": "{{response.conversation.refId:string}}",
    "vendorRole": "{{response.conversation.vendorRole:string}}",
    "vendorId": "{{response.conversation.vendorId:number}}",
    "vendorName": "{{response.conversation.vendorName:string}}",
    "relationOrderId": "{{response.conversation.relationOrderId:string}}",
    "ext": {
      "parentsid": "{{response.conversation.ext.parentsid:string}}",
      "clientid": "{{response.conversation.ext.clientid:string}}",
      "needsendusermessage": "{{response.conversation.ext.needsendusermessage:string}}",
      "imreqmsgid": "{{response.conversation.ext.imreqmsgid:string}}",
      "latitude": "{{response.conversation.ext.latitude:string}}",
      "channel": "VAC",
      "ibuclientversion": "{{response.conversation.ext.ibuclientversion:string}}",
      "title": "{{response.conversation.ext.title:string}}",
      "pageid": "{{response.conversation.ext.pageid:string}}",
      "locale": "zh_HK",
      "aitoken": "",
      "bu": "{{response.conversation.ext.bu:string}}",
      "thirdpartytoken": "{{response.conversation.ext.thirdpartytoken:string}}",
      "tag": "",
      "longitude": "{{response.conversation.ext.longitude:string}}",
      "imassignscene": "{{response.conversation.ext.imassignscene:string}}",
      "supplierid": "{{response.conversation.ext.supplierid:string}}",
      "coordinate": "{{response.conversation.ext.coordinate:string}}",
      "clientversion": "{{response.conversation.ext.clientversion:string}}",
      "orderid": "{{response.conversation.ext.orderid:string}}",
      "cityname": "{{response.conversation.ext.cityname:string}}",
      "relationorderid": "{{response.conversation.ext.relationorderid:string}}",
      "appversion": "{{response.conversation.ext.appversion:string}}",
      "cityid": "{{response.conversation.ext.cityid:string}}",
      "supplierpid": "",
      "vendorUid": "{{response.conversation.ext.vendorUid:string}}",
      "token": "{{response.conversation.ext.token:string}}",
      "imclientip": "{{response.conversation.ext.imclientip:string}}",
      "vtoken": "{{response.conversation.ext.vtoken:string}}",
      "ctype": "{{response.conversation.ext.ctype:string}}",
      "pagefrom": "{{response.conversation.ext.pagefrom:string}}",
      "cid": "{{response.conversation.ext.cid:string}}"
    },
    "status": 2,
    "conversationType": "B2C",
    "groupTitle": "{{response.conversation.groupTitle:string}}",
    "groupAvatar": "{{response.conversation.groupAvatar:string}}",
    "sessionId": "{{response.conversation.sessionId:string}}",
    "customerInGroup": "{{response.conversation.customerInGroup:number}}",
    "inGroup": 0,
    "isHide": 0,
    "star": 0,
    "isRead": 0,
    "lastUpdateTime": "{{response.conversation.lastUpdateTime:number}}",
    "currentConversationRole": 2,
    "languageInfo": {
      "lang": "zh_HK",
      "terminalChannel": "",
      "terminalChannelUid": "",
      "timeZone": "",
      "customerSource": ""
    },
    "inQueueStatus": 0
  }
}
```

写请求未知结果先读回，不自动重发。具体 UI 操作、目标和状态收敛见 [验证记录](../validation.md)。

## 未完成项

- 逐字段必填性、所有条件分支和失败范围尚未穷尽。
- 独立宿主 Origin/Profile/网络层尚未验证；页面内重放成功不能外推到原生 HTTP。
- 动态来源未闭环：见公共 head / 风控 / 身份来源的共同未完成项。
