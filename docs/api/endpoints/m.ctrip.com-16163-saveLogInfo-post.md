# POST m.ctrip.com/restapi/soa2/16163/saveLogInfo

状态：真实网页请求样本；完整实施准入尚未通过。固定网页版本、鉴权边界和占位符规则见 [鉴权说明](../authentication.md)。

- 完整地址：`https://m.ctrip.com/restapi/soa2/16163/saveLogInfo`
- 请求方法：`POST`
- 范围：页面自动辅助请求；不扩展为本项目功能
- 编码：JSON；HTTP Content-Type 见下表，不能由 body.contentType 推断
- Authentication：本轮浏览器 Cookie 会话；逐项 Cookie 必需性未证明，见鉴权说明
- 原始证据：[evidence/2026-10-30/02-controlled-open.json](../evidence/2026-10-30/02-controlled-open.json)、[evidence/2026-10-30/14-upload-full-payload.json](../evidence/2026-10-30/14-upload-full-payload.json)、[evidence/2026-10-30/21-transfer-conversation-open.json](../evidence/2026-10-30/21-transfer-conversation-open.json)、[evidence/2026-10-30/23-transfer-target-open.json](../evidence/2026-10-30/23-transfer-target-open.json)、[evidence/2026-10-30/27-return-to-controlled.json](../evidence/2026-10-30/27-return-to-controlled.json)、[evidence/2026-10-30/49-controlled-reopen-after-finish.json](../evidence/2026-10-30/49-controlled-reopen-after-finish.json)、[evidence/2026-10-30/55-controlled-sidebar-document.json](../evidence/2026-10-30/55-controlled-sidebar-document.json)、[evidence/2026-10-30/58-order-list-page-initialization.json](../evidence/2026-10-30/58-order-list-page-initialization.json)、[evidence/2026-10-30/60-controlled-order-detail.json](../evidence/2026-10-30/60-controlled-order-detail.json)、[evidence/2026-10-30/61-controlled-order-createimchat.json](../evidence/2026-10-30/61-controlled-order-createimchat.json)

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

以上为观察到的请求头，包含 CDP ExtraInfo。出现不代表逐项必需；浏览器自动字段、风控字段和应用字段分开处理。

## Query 参数

```json
{
  "transId": "{{query.transId:string}}"
}
```

`_fxpcqlniredt`、`x-traceID` 如出现，由平台公共请求层处理；nonce、时间戳和上传 rand 不可复制为常量。

## 完整请求样本与分支

`{{字段路径:类型}}` 是脱敏占位符，不能作为字面量发出。数字占位符的原始类型以参数表为准。数组不截断；JSON 字符串仍保留字符串编码。

### 样本 1：55-controlled-sidebar-document / HTTP 200 / Ack Success

```json
{
  "head": {
    "auth": null,
    "cid": "{{body.head.cid:string}}",
    "ctok": "",
    "cver": "1.0",
    "extension": [
      {
        "name": "vid",
        "value": "{{body.head.extension[0].value:string}}"
      },
      {
        "name": "pvid",
        "value": "{{body.head.extension[1].value:number}}"
      },
      {
        "name": "sid",
        "value": "{{body.head.extension[2].value:number}}"
      }
    ],
    "lang": "01",
    "sid": "",
    "syscode": "09",
    "locale": "zh-CN"
  },
  "pageCode": "",
  "logTime": "{{body.logTime:number}}",
  "oid": "",
  "transId": "{{body.transId:string}}",
  "source": "vacation_vbk_account",
  "uid": "",
  "version": "{{body.version:string}}",
  "extend": "{{body.extend:string}}",
  "extension": "{\"start\":1,\"version\":\"{{body.extension.$json.version:string}}\",\"locale\":\"zh-CN\",\"isMobile\":0}",
  "code": "",
  "bizCode": "",
  "orderid": "{{body.orderid:number}}",
  "token": "{{body.token:string}}",
  "tsid": "",
  "replayType": "{{body.replayType:string}}",
  "content": "{{body.content:string}}",
  "logEndTime": "{{body.logEndTime:number}}"
}
```

### 样本 2：55-controlled-sidebar-document / HTTP 200 / Ack Success

```json
{
  "head": {
    "auth": null,
    "cid": "{{body.head.cid:string}}",
    "ctok": "",
    "cver": "1.0",
    "extension": [
      {
        "name": "vid",
        "value": "{{body.head.extension[0].value:string}}"
      },
      {
        "name": "pvid",
        "value": "{{body.head.extension[1].value:string}}"
      },
      {
        "name": "sid",
        "value": "{{body.head.extension[2].value:string}}"
      }
    ],
    "lang": "01",
    "sid": "",
    "syscode": "09",
    "locale": "zh-CN"
  },
  "pageCode": "",
  "logTime": "{{body.logTime:number}}",
  "oid": "",
  "transId": "{{body.transId:string}}",
  "source": "vacation_vbk_account",
  "uid": "",
  "version": "{{body.version:string}}",
  "extend": "{{body.extend:string}}",
  "extension": "{\"start\":1,\"version\":\"{{body.extension.$json.version:string}}\",\"locale\":\"zh-CN\",\"isMobile\":0}",
  "code": "",
  "bizCode": "",
  "orderid": "{{body.orderid:number}}",
  "token": "{{body.token:string}}",
  "tsid": "",
  "replayType": "{{body.replayType:string}}",
  "content": "{{body.content:string}}",
  "logEndTime": "{{body.logEndTime:number}}"
}
```

### 样本 3：60-controlled-order-detail / HTTP 200 / Ack Success

```json
{
  "head": {
    "auth": null,
    "cid": "{{body.head.cid:string}}",
    "ctok": "",
    "cver": "1.0",
    "extension": [
      {
        "name": "vid",
        "value": "{{body.head.extension[0].value:string}}"
      },
      {
        "name": "pvid",
        "value": "{{body.head.extension[1].value:number}}"
      },
      {
        "name": "sid",
        "value": "{{body.head.extension[2].value:number}}"
      },
      {
        "name": "i18n.locale",
        "value": "{{body.head.extension[3].value:string}}"
      }
    ],
    "lang": "01",
    "sid": "",
    "syscode": "09",
    "locale": "zh_cn"
  },
  "pageCode": "",
  "logTime": "{{body.logTime:number}}",
  "oid": "",
  "transId": "{{body.transId:string}}",
  "source": "vacation_ttd_vbk",
  "uid": "",
  "version": "{{body.version:string}}",
  "extend": "",
  "extension": "{\"start\":1,\"version\":\"{{body.extension.$json.version:string}}\",\"locale\":\"zh_cn\",\"isMobile\":0,\"rootIDList\":\"[]\"}",
  "code": "",
  "bizCode": "",
  "orderid": "{{body.orderid:number}}",
  "token": "{{body.token:string}}",
  "tsid": "",
  "replayType": "{{body.replayType:string}}",
  "content": "{{body.content:string}}",
  "logEndTime": "{{body.logEndTime:number}}"
}
```

### 样本 4：61-controlled-order-createimchat / HTTP 200 / Ack Success

```json
{
  "head": {
    "auth": null,
    "cid": "{{body.head.cid:string}}",
    "ctok": "",
    "cver": "1.0",
    "extension": [
      {
        "name": "vid",
        "value": "{{body.head.extension[0].value:string}}"
      },
      {
        "name": "pvid",
        "value": "{{body.head.extension[1].value:number}}"
      },
      {
        "name": "sid",
        "value": "{{body.head.extension[2].value:number}}"
      },
      {
        "name": "i18n.locale",
        "value": "{{body.head.extension[3].value:string}}"
      }
    ],
    "lang": "01",
    "sid": "",
    "syscode": "09",
    "locale": "zh_cn"
  },
  "pageCode": "",
  "logTime": "{{body.logTime:number}}",
  "oid": "",
  "transId": "{{body.transId:string}}",
  "source": "vacation_ttd_vbk",
  "uid": "",
  "version": "{{body.version:string}}",
  "extend": "",
  "extension": "{\"start\":1,\"version\":\"{{body.extension.$json.version:string}}\",\"locale\":\"zh_cn\",\"isMobile\":0,\"rootIDList\":\"[]\"}",
  "code": "",
  "bizCode": "",
  "orderid": "{{body.orderid:number}}",
  "token": "{{body.token:string}}",
  "tsid": "",
  "replayType": "{{body.replayType:string}}",
  "content": "{{body.content:string}}",
  "logEndTime": "{{body.logEndTime:number}}"
}
```

## 参数类型与来源

| 位置 | 实测类型 | 来源与限制 |
| --- | --- | --- |
| `(body)` | `object` | 本轮实际观测值；必填性、默认值及完整取值范围未由单次样本证明 |
| `head` | `object` | 该接口所属请求层生成；见 authentication.md 两类 head |
| `head.auth` | `null` | 本轮 Cookie 请求为空；显式 token 分支与 Cookie 分支分开 |
| `head.cid` | `string` | 公共请求层补入的客户端标识；具体合并来源尚需逐调用点核实 |
| `head.ctok` | `string` | 对应请求层的公共 head；见 authentication.md，不与 HTTP Header 合并 |
| `head.cver` | `string` | 对应请求层的公共 head；见 authentication.md，不与 HTTP Header 合并 |
| `head.extension` | `array` | 对应请求层的公共 head；见 authentication.md，不与 HTTP Header 合并 |
| `head.extension[]` | `object` | 对应请求层的公共 head；见 authentication.md，不与 HTTP Header 合并 |
| `head.extension[].name` | `string` | 对应 head 配置的准确名称，protocol 与 protocal 不同 |
| `head.extension[].value` | `string` | 对应协议扩展的实际常量或运行时上下文，见完整示例与鉴权文档 |
| `head.extension[].value` | `number` | 对应协议扩展的实际常量或运行时上下文，见完整示例与鉴权文档 |
| `head.lang` | `string` | 对应请求层的公共 head；见 authentication.md，不与 HTTP Header 合并 |
| `head.sid` | `string` | 公共请求层补入的字段；不可将单次样本推定为全局常量 |
| `head.syscode` | `string` | 对应请求层的公共 head；见 authentication.md，不与 HTTP Header 合并 |
| `head.locale` | `string` | 对应请求层的公共 head；见 authentication.md，不与 HTTP Header 合并 |
| `pageCode` | `string` | 本轮实际观测值；必填性、默认值及完整取值范围未由单次样本证明 |
| `logTime` | `number` | 待追溯：当前仅保留位置与类型，来源未闭环，阻塞自行构造请求 |
| `oid` | `string` | 本轮实际观测值；必填性、默认值及完整取值范围未由单次样本证明 |
| `transId` | `string` | 待追溯：当前仅保留位置与类型，来源未闭环，阻塞自行构造请求 |
| `source` | `string` | 本轮实际观测值；必填性、默认值及完整取值范围未由单次样本证明 |
| `uid` | `string` | 调用上下文决定的身份字段；需结合本接口业务调用点核对，不能与坐席 UID 混用 |
| `version` | `string` | 待追溯：当前仅保留位置与类型，来源未闭环，阻塞自行构造请求 |
| `extend` | `string` | 本轮实际观测值；必填性、默认值及完整取值范围未由单次样本证明 |
| `extension` | `string` | 本轮实际观测值；必填性、默认值及完整取值范围未由单次样本证明 |
| `extension(JSON字符串)` | `object` | 本轮实际观测值；必填性、默认值及完整取值范围未由单次样本证明 |
| `extension(JSON字符串).start` | `number` | 本轮实际观测值；必填性、默认值及完整取值范围未由单次样本证明 |
| `extension(JSON字符串).version` | `string` | 待追溯：当前仅保留位置与类型，来源未闭环，阻塞自行构造请求 |
| `extension(JSON字符串).locale` | `string` | 本轮实际观测值；必填性、默认值及完整取值范围未由单次样本证明 |
| `extension(JSON字符串).isMobile` | `number` | 本轮实际观测值；必填性、默认值及完整取值范围未由单次样本证明 |
| `code` | `string` | 本轮实际观测值；必填性、默认值及完整取值范围未由单次样本证明 |
| `bizCode` | `string` | 本轮实际观测值；必填性、默认值及完整取值范围未由单次样本证明 |
| `orderid` | `number` | 待追溯：当前仅保留位置与类型，来源未闭环，阻塞自行构造请求 |
| `token` | `string` | 待追溯：当前仅保留位置与类型，来源未闭环，阻塞自行构造请求 |
| `tsid` | `string` | 本轮实际观测值；必填性、默认值及完整取值范围未由单次样本证明 |
| `replayType` | `string` | 待追溯：当前仅保留位置与类型，来源未闭环，阻塞自行构造请求 |
| `content` | `string` | 本接口快捷回复查询的当前编辑器片段；不等同消息发送接口 |
| `logEndTime` | `number` | 待追溯：当前仅保留位置与类型，来源未闭环，阻塞自行构造请求 |
| `extension(JSON字符串).rootIDList` | `string` | 本轮实际观测值；必填性、默认值及完整取值范围未由单次样本证明 |
| `extension(JSON字符串).rootIDList(JSON字符串)` | `array` | 本轮实际观测值；必填性、默认值及完整取值范围未由单次样本证明 |

“观测到”不等于“必填”。本轮未进行完整删字段/边界矩阵，不编造 required、默认值、枚举或省略行为。

## 响应与读回

完整响应结构和脱敏实例在以上证据的 responseSchema / responseTemplate；上传另有 xhr.response。HTTP 200、Ack Success 和最终业务状态分别判断。

```json
{
  "ResponseStatus": {
    "Timestamp": "{{response.ResponseStatus.Timestamp:string}}",
    "Ack": "Success",
    "Errors": [],
    "Build": null,
    "Version": null,
    "Extension": [
      {
        "Id": "{{response.ResponseStatus.Extension[0].Id:string}}",
        "Version": null,
        "ContentType": null,
        "Value": "{{response.ResponseStatus.Extension[0].Value:string}}"
      },
      {
        "Id": "{{response.ResponseStatus.Extension[1].Id:string}}",
        "Version": null,
        "ContentType": null,
        "Value": "{{response.ResponseStatus.Extension[1].Value:string}}"
      }
    ]
  },
  "rc": 0
}
```

写请求未知结果先读回，不自动重发。具体 UI 操作、目标和状态收敛见 [验证记录](../validation.md)。

## 未完成项

- 逐字段必填性、所有条件分支和失败范围尚未穷尽。
- 独立宿主 Origin/Profile/网络层尚未验证；页面内重放成功不能外推到原生 HTTP。
- 动态来源未闭环：`extend`、`extension(JSON字符串).version`、`logEndTime`、`logTime`、`orderid`、`replayType`、`token`、`transId`、`version`
