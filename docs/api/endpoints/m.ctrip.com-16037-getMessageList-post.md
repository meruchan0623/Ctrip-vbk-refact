# POST m.ctrip.com/restapi/soa2/16037/getMessageList

状态：真实网页请求样本；完整实施准入尚未通过。固定网页版本、鉴权边界和占位符规则见 [鉴权说明](../authentication.md)。

- 完整地址：`https://m.ctrip.com/restapi/soa2/16037/getMessageList`
- 请求方法：`POST`
- 范围：网页消息/身份/联系入口及共享读取契约
- 编码：JSON；HTTP Content-Type 见下表，不能由 body.contentType 推断
- Authentication：本轮浏览器 Cookie 会话；逐项 Cookie 必需性未证明，见鉴权说明
- 原始证据：[evidence/2026-10-30/01-bootstrap.json](../evidence/2026-10-30/01-bootstrap.json)、[evidence/2026-10-30/02-controlled-open.json](../evidence/2026-10-30/02-controlled-open.json)、[evidence/2026-10-30/07-controlled-search-open.json](../evidence/2026-10-30/07-controlled-search-open.json)、[evidence/2026-10-30/08-controlled-start-chat.json](../evidence/2026-10-30/08-controlled-start-chat.json)、[evidence/2026-10-30/14-upload-full-payload.json](../evidence/2026-10-30/14-upload-full-payload.json)、[evidence/2026-10-30/21-transfer-conversation-open.json](../evidence/2026-10-30/21-transfer-conversation-open.json)、[evidence/2026-10-30/23-transfer-target-open.json](../evidence/2026-10-30/23-transfer-target-open.json)、[evidence/2026-10-30/27-return-to-controlled.json](../evidence/2026-10-30/27-return-to-controlled.json)、[evidence/2026-10-30/49-controlled-reopen-after-finish.json](../evidence/2026-10-30/49-controlled-reopen-after-finish.json)、[evidence/2026-10-30/54-sdk-restored-by-official-page-reload.json](../evidence/2026-10-30/54-sdk-restored-by-official-page-reload.json)、[evidence/2026-10-30/55-controlled-sidebar-document.json](../evidence/2026-10-30/55-controlled-sidebar-document.json)、[evidence/2026-10-30/70-controlled-history-pagination-replay.json](../evidence/2026-10-30/70-controlled-history-pagination-replay.json)、[evidence/2026-10-30/71-controlled-read-receipt.json](../evidence/2026-10-30/71-controlled-read-receipt.json)

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

### 样本 1：55-controlled-sidebar-document / HTTP 200 / Ack Success

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
  "showTargetIsRead": true,
  "groupId": "{{body.groupId:string}}",
  "conversationType": "B2C",
  "pageSize": 20
}
```

### 样本 2：54-sdk-restored-by-official-page-reload / HTTP 200 / Ack Success

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
  "showTargetIsRead": true,
  "groupId": "{{body.groupId:string}}",
  "conversationType": "C2B",
  "pageSize": 20
}
```

### 样本 3：49-controlled-reopen-after-finish / HTTP 200 / Ack Success

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
  "showTargetIsRead": true,
  "groupId": "{{body.groupId:string}}",
  "conversationType": "B2C",
  "pageSize": 50,
  "direction": "prev"
}
```

### 样本 4：49-controlled-reopen-after-finish / HTTP 200 / Ack Success

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
  "showTargetIsRead": true,
  "groupId": "{{body.groupId:string}}",
  "conversationType": "B2C",
  "pageSize": 50,
  "endTime": "{{body.endTime:number}}",
  "direction": "prev"
}
```

### 样本 5：49-controlled-reopen-after-finish / HTTP 200 / Ack Success

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
  "showTargetIsRead": true,
  "groupId": "{{body.groupId:string}}",
  "conversationType": "B2C",
  "pageSize": 50,
  "beginTime": "{{body.beginTime:number}}",
  "direction": "next"
}
```

### 样本 6：23-transfer-target-open / HTTP 200 / Ack Success

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
  "showTargetIsRead": true,
  "groupId": "{{body.groupId:string}}",
  "conversationType": "C2B",
  "pageSize": 50,
  "endTime": "{{body.endTime:number}}",
  "direction": "prev"
}
```

### 样本 7：23-transfer-target-open / HTTP 200 / Ack Success

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
  "showTargetIsRead": true,
  "groupId": "{{body.groupId:string}}",
  "conversationType": "C2B",
  "pageSize": 50,
  "beginTime": "{{body.beginTime:number}}",
  "direction": "next"
}
```

### 样本 8：27-return-to-controlled / HTTP 200 / Ack Success

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
  "showTargetIsRead": true,
  "groupId": "{{body.groupId:string}}",
  "conversationType": "B2C",
  "pageSize": 50,
  "endTime": "{{body.endTime:number}}",
  "direction": "prev"
}
```

### 样本 9：27-return-to-controlled / HTTP 200 / Ack Success

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
  "showTargetIsRead": true,
  "groupId": "{{body.groupId:string}}",
  "conversationType": "B2C",
  "pageSize": 50,
  "beginTime": "{{body.beginTime:number}}",
  "direction": "next"
}
```

### 样本 10：55-controlled-sidebar-document / HTTP 200 / Ack Success

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
  "showTargetIsRead": true,
  "groupId": "{{body.groupId:string}}",
  "conversationType": "B2C",
  "pageSize": 50,
  "direction": "prev"
}
```

### 样本 11：70-controlled-history-pagination-replay / HTTP 200 / Ack Success

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
  "showTargetIsRead": true,
  "groupId": "{{body.groupId:string}}",
  "conversationType": "B2C",
  "pageSize": 2
}
```

### 样本 12：70-controlled-history-pagination-replay / HTTP 200 / Ack Success

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
  "showTargetIsRead": true,
  "groupId": "{{body.groupId:string}}",
  "conversationType": "B2C",
  "pageSize": 2,
  "endTime": "{{body.endTime:number}}",
  "direction": "prev"
}
```

### 样本 13：70-controlled-history-pagination-replay / HTTP 200 / Ack Success

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
  "showTargetIsRead": true,
  "groupId": "{{body.groupId:string}}",
  "conversationType": "B2C",
  "pageSize": 2,
  "beginTime": "{{body.beginTime:number}}",
  "direction": "next"
}
```

### 样本 14：71-controlled-read-receipt / HTTP 200 / Ack Success

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
  "showTargetIsRead": true,
  "groupId": "{{body.groupId:string}}",
  "conversationType": "B2C",
  "pageSize": 50
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
| `showTargetIsRead` | `boolean` | 实际调用点配置/用户操作；本轮观测值见完整示例，非已证明的完整枚举 |
| `groupId` | `string` | 当前会话 conversation.gid；保留本调用点的原始类型 |
| `conversationType` | `string` | 当前会话 conversation.conversationType |
| `pageSize` | `number` | 实际调用点配置/用户操作；本轮观测值见完整示例，非已证明的完整枚举 |
| `direction` | `string` | 实际调用点配置/用户操作；本轮观测值见完整示例，非已证明的完整枚举 |
| `endTime` | `number` | 已读取消息边界 createTime；与 direction=prev 配对 |
| `beginTime` | `number` | 已读取消息边界 createTime；与 direction=next 配对，不能混用结束边界 |

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
  "rangeMessage": {
    "isDone": false,
    "lastMessageTime": "{{response.rangeMessage.lastMessageTime:number}}",
    "messages": [
      {
        "msgId": "{{response.rangeMessage.messages[0].msgId:string}}",
        "messageBody": "{\"title\":\"{{response.rangeMessage.messages[0].messageBody.$json.title:string}}\",\"isPresent\":false,\"action\":\"NBZ109\",\"ext\":{\"sid\":\"{{response.rangeMessage.messages[0].messageBody.$json.ext.sid:string}}\",\"gid\":\"{{response.rangeMessage.messages[0].messageBody.$json.ext.gid:number}}\",\"bizType\":1513,\"gType\":1513,\"createTime\":\"{{response.rangeMessage.messages[0].messageBody.$json.ext.createTime:number}}\",\"stage\":1,\"status\":1,\"finishType\":\"\",\"dataChangeLasttime\":\"{{response.rangeMessage.messages[0].messageBody.$json.ext.dataChangeLasttime:number}}\",\"parent_sid\":\"{{response.rangeMessage.messages[0].messageBody.$json.ext.parent_sid:string}}\",\"eventType\":\"{{response.rangeMessage.messages[0].messageBody.$json.ext.eventType:string}}\"}}",
        "fromJid": "{{response.rangeMessage.messages[0].fromJid:string}}",
        "toJid": "{{response.rangeMessage.messages[0].toJid:string}}",
        "threadId": "",
        "subject": "",
        "createTime": "{{response.rangeMessage.messages[0].createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 1007,
        "isread": false,
        "source": "",
        "receiptRange": 0
      },
      {
        "msgId": "{{response.rangeMessage.messages[1].msgId:string}}",
        "messageBody": "{\"isPresent\":true,\"title\":\"{{response.rangeMessage.messages[1].messageBody.$json.title:string}}\",\"action\":\"NBZ30\",\"ext\":{\"inviteAgentUid\":\"{{response.rangeMessage.messages[1].messageBody.$json.ext.inviteAgentUid:string}}\",\"visibleRule\":7,\"acceptAgentNick\":\"{{response.rangeMessage.messages[1].messageBody.$json.ext.acceptAgentNick:string}}\"},\"sid\":\"{{response.rangeMessage.messages[1].messageBody.$json.sid:string}}\",\"see\":0,\"bSee\":0,\"bsee\":0}",
        "fromJid": "{{response.rangeMessage.messages[1].fromJid:string}}",
        "toJid": "{{response.rangeMessage.messages[1].toJid:string}}",
        "threadId": "{{response.rangeMessage.messages[1].threadId:string}}",
        "subject": "",
        "createTime": "{{response.rangeMessage.messages[1].createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 1007,
        "isread": false,
        "source": "",
        "receiptRange": 0
      },
      {
        "msgId": "{{response.rangeMessage.messages[2].msgId:string}}",
        "messageBody": "{\"isPresent\":false,\"title\":\"{{response.rangeMessage.messages[2].messageBody.$json.title:string}}\",\"action\":\"NBZ37\",\"ext\":{\"nickName\":\"{{response.rangeMessage.messages[2].messageBody.$json.ext.nickName:string}}\",\"visibleRule\":0,\"vendorUid\":\"{{response.rangeMessage.messages[2].messageBody.$json.ext.vendorUid:string}}\"},\"sid\":\"{{response.rangeMessage.messages[2].messageBody.$json.sid:string}}\",\"see\":0,\"bSee\":0,\"bsee\":0}",
        "fromJid": "{{response.rangeMessage.messages[2].fromJid:string}}",
        "toJid": "{{response.rangeMessage.messages[2].toJid:string}}",
        "threadId": "{{response.rangeMessage.messages[2].threadId:string}}",
        "subject": "",
        "createTime": "{{response.rangeMessage.messages[2].createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 1007,
        "isread": false,
        "source": "",
        "receiptRange": 0
      },
      {
        "msgId": "{{response.rangeMessage.messages[3].msgId:string}}",
        "messageBody": "{\"btype\":5,\"file\":{\"filename\":\"{{response.rangeMessage.messages[3].messageBody.$json.file.filename:string}}\",\"url\":\"{{response.rangeMessage.messages[3].messageBody.$json.file.url:string}}\",\"size\":1479}}",
        "fromJid": "{{response.rangeMessage.messages[3].fromJid:string}}",
        "toJid": "{{response.rangeMessage.messages[3].toJid:string}}",
        "threadId": "{{response.rangeMessage.messages[3].threadId:string}}",
        "subject": "",
        "createTime": "{{response.rangeMessage.messages[3].createTime:number}}",
        "bizType": "1513",
        "status": 2,
        "msgtype": 5,
        "isread": false,
        "source": "",
        "receiptRange": 0
      },
      {
        "msgId": "{{response.rangeMessage.messages[4].msgId:string}}",
        "messageBody": "{\"title\":\"{{response.rangeMessage.messages[4].messageBody.$json.title:string}}\",\"isPresent\":true,\"messageId\":\"{{response.rangeMessage.messages[4].messageBody.$json.messageId:number}}\",\"recallMessageId\":\"{{response.rangeMessage.messages[4].messageBody.$json.recallMessageId:string}}\",\"from\":\"{{response.rangeMessage.messages[4].messageBody.$json.from:string}}\",\"createTime\":\"{{response.rangeMessage.messages[4].messageBody.$json.createTime:number}}\",\"code\":2,\"operator\":\"{{response.rangeMessage.messages[4].messageBody.$json.operator:string}}\",\"operatorName\":\"{{response.rangeMessage.messages[4].messageBody.$json.operatorName:string}}\"}",
        "fromJid": "{{response.rangeMessage.messages[4].fromJid:string}}",
        "toJid": "{{response.rangeMessage.messages[4].toJid:string}}",
        "threadId": "",
        "subject": "",
        "createTime": "{{response.rangeMessage.messages[4].createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 1009,
        "isread": false,
        "source": "",
        "receiptRange": 0
      },
      {
        "msgId": "{{response.rangeMessage.messages[5].msgId:string}}",
        "messageBody": "{\"btype\":5,\"file\":{\"filename\":\"{{response.rangeMessage.messages[5].messageBody.$json.file.filename:string}}\",\"url\":\"{{response.rangeMessage.messages[5].messageBody.$json.file.url:string}}\",\"size\":1479}}",
        "fromJid": "{{response.rangeMessage.messages[5].fromJid:string}}",
        "toJid": "{{response.rangeMessage.messages[5].toJid:string}}",
        "threadId": "",
        "subject": "",
        "createTime": "{{response.rangeMessage.messages[5].createTime:number}}",
        "bizType": "1513",
        "status": 2,
        "msgtype": 5,
        "isread": false,
        "source": "",
        "receiptRange": 0
      },
      {
        "msgId": "{{response.rangeMessage.messages[6].msgId:string}}",
        "messageBody": "{\"title\":\"{{response.rangeMessage.messages[6].messageBody.$json.title:string}}\",\"isPresent\":true,\"messageId\":\"{{response.rangeMessage.messages[6].messageBody.$json.messageId:number}}\",\"recallMessageId\":\"{{response.rangeMessage.messages[6].messageBody.$json.recallMessageId:string}}\",\"from\":\"{{response.rangeMessage.messages[6].messageBody.$json.from:string}}\",\"createTime\":\"{{response.rangeMessage.messages[6].messageBody.$json.createTime:number}}\",\"code\":2,\"operator\":\"{{response.rangeMessage.messages[6].messageBody.$json.operator:string}}\",\"operatorName\":\"{{response.rangeMessage.messages[6].messageBody.$json.operatorName:string}}\"}",
        "fromJid": "{{response.rangeMessage.messages[6].fromJid:string}}",
        "toJid": "{{response.rangeMessage.messages[6].toJid:string}}",
        "threadId": "",
        "subject": "",
        "createTime": "{{response.rangeMessage.messages[6].createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 1009,
        "isread": false,
        "source": "",
        "receiptRange": 0
      },
      {
        "msgId": "{{response.rangeMessage.messages[7].msgId:string}}",
        "messageBody": "{{response.rangeMessage.messages[7].messageBody:string}}",
        "fromJid": "{{response.rangeMessage.messages[7].fromJid:string}}",
        "toJid": "{{response.rangeMessage.messages[7].toJid:string}}",
        "threadId": "",
        "subject": "",
        "createTime": "{{response.rangeMessage.messages[7].createTime:number}}",
        "bizType": "1513",
        "status": 2,
        "msgtype": 0,
        "isread": false,
        "source": "",
        "receiptRange": 0
      },
      {
        "msgId": "{{response.rangeMessage.messages[8].msgId:string}}",
        "messageBody": "{\"title\":\"{{response.rangeMessage.messages[8].messageBody.$json.title:string}}\",\"isPresent\":true,\"messageId\":\"{{response.rangeMessage.messages[8].messageBody.$json.messageId:number}}\",\"recallMessageId\":\"{{response.rangeMessage.messages[8].messageBody.$json.recallMessageId:string}}\",\"from\":\"{{response.rangeMessage.messages[8].messageBody.$json.from:string}}\",\"createTime\":\"{{response.rangeMessage.messages[8].messageBody.$json.createTime:number}}\",\"code\":2,\"operator\":\"{{response.rangeMessage.messages[8].messageBody.$json.operator:string}}\",\"operatorName\":\"{{response.rangeMessage.messages[8].messageBody.$json.operatorName:string}}\"}",
        "fromJid": "{{response.rangeMessage.messages[8].fromJid:string}}",
        "toJid": "{{response.rangeMessage.messages[8].toJid:string}}",
        "threadId": "",
        "subject": "",
        "createTime": "{{response.rangeMessage.messages[8].createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 1009,
        "isread": false,
        "source": "",
        "receiptRange": 0
      },
      {
        "msgId": "{{response.rangeMessage.messages[9].msgId:string}}",
        "messageBody": "{\"type\":\"推荐\",\"btype\":\"{{response.rangeMessage.messages[9].messageBody.$json.btype:string}}\",\"title\":\"{{response.rangeMessage.messages[9].messageBody.$json.title:string}}\",\"url\":\"{{response.rangeMessage.messages[9].messageBody.$json.url:string}}\",\"desc\":\"{{response.rangeMessage.messages[9].messageBody.$json.desc:string}}\",\"avatar\":\"{{response.rangeMessage.messages[9].messageBody.$json.avatar:string}}\"}",
        "fromJid": "{{response.rangeMessage.messages[9].fromJid:string}}",
        "toJid": "{{response.rangeMessage.messages[9].toJid:string}}",
        "threadId": "",
        "subject": "",
        "createTime": "{{response.rangeMessage.messages[9].createTime:number}}",
        "bizType": "1513",
        "status": 2,
        "msgtype": 2,
        "isread": false,
        "source": "",
        "receiptRange": 0
      },
      {
        "msgId": "{{response.rangeMessage.messages[10].msgId:string}}",
        "messageBody": "{{response.rangeMessage.messages[10].messageBody:string}}",
        "fromJid": "{{response.rangeMessage.messages[10].fromJid:string}}",
        "toJid": "{{response.rangeMessage.messages[10].toJid:string}}",
        "threadId": "",
        "subject": "",
        "createTime": "{{response.rangeMessage.messages[10].createTime:number}}",
        "bizType": "1513",
        "status": 2,
        "msgtype": 0,
        "isread": false,
        "source": "",
        "receiptRange": 0,
        "citeMsgId": "{{response.rangeMessage.messages[10].citeMsgId:string}}",
        "citeMessageInfo": {
          "msgId": "{{response.rangeMessage.messages[10].citeMessageInfo.msgId:string}}",
          "msgtype": 2,
          "messageBody": "{\"type\":\"推荐\",\"btype\":\"{{response.rangeMessage.messages[10].citeMessageInfo.messageBody.$json.btype:string}}\",\"title\":\"{{response.rangeMessage.messages[10].citeMessageInfo.messageBody.$json.title:string}}\",\"url\":\"{{response.rangeMessage.messages[10].citeMessageInfo.messageBody.$json.url:string}}\",\"desc\":\"{{response.rangeMessage.messages[10].citeMessageInfo.messageBody.$json.desc:string}}\",\"avatar\":\"{{response.rangeMessage.messages[10].citeMessageInfo.messageBody.$json.avatar:string}}\"}",
          "fromJid": "{{response.rangeMessage.messages[10].citeMessageInfo.fromJid:string}}",
          "toJid": "{{response.rangeMessage.messages[10].citeMessageInfo.toJid:string}}",
          "createTime": "{{response.rangeMessage.messages[10].citeMessageInfo.createTime:number}}",
          "status": 2,
          "visible": 1,
          "valid": 1,
          "source": ""
        }
      },
      {
        "msgId": "{{response.rangeMessage.messages[11].msgId:string}}",
        "messageBody": "{\"title\":\"{{response.rangeMessage.messages[11].messageBody.$json.title:string}}\",\"isPresent\":true,\"messageId\":\"{{response.rangeMessage.messages[11].messageBody.$json.messageId:number}}\",\"recallMessageId\":\"{{response.rangeMessage.messages[11].messageBody.$json.recallMessageId:string}}\",\"from\":\"{{response.rangeMessage.messages[11].messageBody.$json.from:string}}\",\"createTime\":\"{{response.rangeMessage.messages[11].messageBody.$json.createTime:number}}\",\"code\":2,\"operator\":\"{{response.rangeMessage.messages[11].messageBody.$json.operator:string}}\",\"operatorName\":\"{{response.rangeMessage.messages[11].messageBody.$json.operatorName:string}}\"}",
        "fromJid": "{{response.rangeMessage.messages[11].fromJid:string}}",
        "toJid": "{{response.rangeMessage.messages[11].toJid:string}}",
        "threadId": "",
        "subject": "",
        "createTime": "{{response.rangeMessage.messages[11].createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 1009,
        "isread": false,
        "source": "",
        "receiptRange": 0
      },
      {
        "msgId": "{{response.rangeMessage.messages[12].msgId:string}}",
        "messageBody": "{\"title\":\"{{response.rangeMessage.messages[12].messageBody.$json.title:string}}\",\"isPresent\":true,\"messageId\":\"{{response.rangeMessage.messages[12].messageBody.$json.messageId:number}}\",\"recallMessageId\":\"{{response.rangeMessage.messages[12].messageBody.$json.recallMessageId:string}}\",\"from\":\"{{response.rangeMessage.messages[12].messageBody.$json.from:string}}\",\"createTime\":\"{{response.rangeMessage.messages[12].messageBody.$json.createTime:number}}\",\"code\":2,\"operator\":\"{{response.rangeMessage.messages[12].messageBody.$json.operator:string}}\",\"operatorName\":\"{{response.rangeMessage.messages[12].messageBody.$json.operatorName:string}}\"}",
        "fromJid": "{{response.rangeMessage.messages[12].fromJid:string}}",
        "toJid": "{{response.rangeMessage.messages[12].toJid:string}}",
        "threadId": "",
        "subject": "",
        "createTime": "{{response.rangeMessage.messages[12].createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 1009,
        "isread": false,
        "source": "",
        "receiptRange": 0
      },
      {
        "msgId": "{{response.rangeMessage.messages[13].msgId:string}}",
        "messageBody": "{\"thumbUrl\":\"{{response.rangeMessage.messages[13].messageBody.$json.thumbUrl:string}}\",\"url\":\"{{response.rangeMessage.messages[13].messageBody.$json.url:string}}\",\"height\":34,\"width\":98,\"btype\":1,\"originImageSize\":-1,\"originImageUrl\":\"\",\"ext\":{\"channel\":\"im_business\",\"scene\":\"cqDA0M7F6aAGHF06jzBe\"}}",
        "fromJid": "{{response.rangeMessage.messages[13].fromJid:string}}",
        "toJid": "{{response.rangeMessage.messages[13].toJid:string}}",
        "threadId": "",
        "subject": "",
        "createTime": "{{response.rangeMessage.messages[13].createTime:number}}",
        "bizType": "1513",
        "status": 2,
        "msgtype": 1,
        "isread": false,
        "source": "",
        "receiptRange": 0
      },
      {
        "msgId": "{{response.rangeMessage.messages[14].msgId:string}}",
        "messageBody": "{\"title\":\"{{response.rangeMessage.messages[14].messageBody.$json.title:string}}\",\"isPresent\":true,\"messageId\":\"{{response.rangeMessage.messages[14].messageBody.$json.messageId:number}}\",\"recallMessageId\":\"{{response.rangeMessage.messages[14].messageBody.$json.recallMessageId:string}}\",\"from\":\"{{response.rangeMessage.messages[14].messageBody.$json.from:string}}\",\"createTime\":\"{{response.rangeMessage.messages[14].messageBody.$json.createTime:number}}\",\"code\":2,\"operator\":\"{{response.rangeMessage.messages[14].messageBody.$json.operator:string}}\",\"operatorName\":\"{{response.rangeMessage.messages[14].messageBody.$json.operatorName:string}}\"}",
        "fromJid": "{{response.rangeMessage.messages[14].fromJid:string}}",
        "toJid": "{{response.rangeMessage.messages[14].toJid:string}}",
        "threadId": "",
        "subject": "",
        "createTime": "{{response.rangeMessage.messages[14].createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 1009,
        "isread": false,
        "source": "",
        "receiptRange": 0
      },
      {
        "msgId": "{{response.rangeMessage.messages[15].msgId:string}}",
        "messageBody": "{\"title\":\"{{response.rangeMessage.messages[15].messageBody.$json.title:string}}\",\"isPresent\":false,\"action\":\"NBZ109\",\"ext\":{\"sid\":\"{{response.rangeMessage.messages[15].messageBody.$json.ext.sid:string}}\",\"gid\":\"{{response.rangeMessage.messages[15].messageBody.$json.ext.gid:number}}\",\"bizType\":1513,\"gType\":1513,\"createTime\":\"{{response.rangeMessage.messages[15].messageBody.$json.ext.createTime:number}}\",\"stage\":1,\"status\":0,\"finishType\":\"{{response.rangeMessage.messages[15].messageBody.$json.ext.finishType:string}}\",\"dataChangeLasttime\":\"{{response.rangeMessage.messages[15].messageBody.$json.ext.dataChangeLasttime:number}}\",\"parent_sid\":\"{{response.rangeMessage.messages[15].messageBody.$json.ext.parent_sid:string}}\",\"eventType\":\"{{response.rangeMessage.messages[15].messageBody.$json.ext.eventType:string}}\"}}",
        "fromJid": "{{response.rangeMessage.messages[15].fromJid:string}}",
        "toJid": "{{response.rangeMessage.messages[15].toJid:string}}",
        "threadId": "",
        "subject": "",
        "createTime": "{{response.rangeMessage.messages[15].createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 1007,
        "isread": false,
        "source": "",
        "receiptRange": 0
      },
      {
        "msgId": "{{response.rangeMessage.messages[16].msgId:string}}",
        "messageBody": "{\"title\":\"{{response.rangeMessage.messages[16].messageBody.$json.title:string}}\",\"isPresent\":false,\"action\":\"NBZ109\",\"ext\":{\"sid\":\"{{response.rangeMessage.messages[16].messageBody.$json.ext.sid:string}}\",\"gid\":\"{{response.rangeMessage.messages[16].messageBody.$json.ext.gid:number}}\",\"bizType\":1513,\"gType\":1513,\"createTime\":\"{{response.rangeMessage.messages[16].messageBody.$json.ext.createTime:number}}\",\"stage\":0,\"status\":1,\"finishType\":null,\"dataChangeLasttime\":\"{{response.rangeMessage.messages[16].messageBody.$json.ext.dataChangeLasttime:number}}\",\"parent_sid\":\"{{response.rangeMessage.messages[16].messageBody.$json.ext.parent_sid:string}}\",\"eventType\":\"{{response.rangeMessage.messages[16].messageBody.$json.ext.eventType:string}}\"}}",
        "fromJid": "{{response.rangeMessage.messages[16].fromJid:string}}",
        "toJid": "{{response.rangeMessage.messages[16].toJid:string}}",
        "threadId": "",
        "subject": "",
        "createTime": "{{response.rangeMessage.messages[16].createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 1007,
        "isread": false,
        "source": "",
        "receiptRange": 0
      },
      {
        "msgId": "{{response.rangeMessage.messages[17].msgId:string}}",
        "messageBody": "{\"title\":\"{{response.rangeMessage.messages[17].messageBody.$json.title:string}}\",\"isPresent\":false,\"action\":\"NBZ109\",\"ext\":{\"sid\":\"{{response.rangeMessage.messages[17].messageBody.$json.ext.sid:string}}\",\"gid\":\"{{response.rangeMessage.messages[17].messageBody.$json.ext.gid:number}}\",\"bizType\":1513,\"gType\":1513,\"createTime\":\"{{response.rangeMessage.messages[17].messageBody.$json.ext.createTime:number}}\",\"stage\":1,\"status\":1,\"finishType\":\"\",\"dataChangeLasttime\":\"{{response.rangeMessage.messages[17].messageBody.$json.ext.dataChangeLasttime:number}}\",\"parent_sid\":\"{{response.rangeMessage.messages[17].messageBody.$json.ext.parent_sid:string}}\",\"eventType\":\"{{response.rangeMessage.messages[17].messageBody.$json.ext.eventType:string}}\"}}",
        "fromJid": "{{response.rangeMessage.messages[17].fromJid:string}}",
        "toJid": "{{response.rangeMessage.messages[17].toJid:string}}",
        "threadId": "",
        "subject": "",
        "createTime": "{{response.rangeMessage.messages[17].createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 1007,
        "isread": false,
        "source": "",
        "receiptRange": 0
      },
      {
        "msgId": "{{response.rangeMessage.messages[18].msgId:string}}",
        "messageBody": "{{response.rangeMessage.messages[18].messageBody:string}}",
        "fromJid": "{{response.rangeMessage.messages[18].fromJid:string}}",
        "toJid": "{{response.rangeMessage.messages[18].toJid:string}}",
        "threadId": "{{response.rangeMessage.messages[18].threadId:string}}",
        "subject": "",
        "createTime": "{{response.rangeMessage.messages[18].createTime:number}}",
        "bizType": "1513",
        "status": 2,
        "msgtype": 0,
        "isread": false,
        "source": "",
        "receiptRange": 0
      },
      {
        "msgId": "{{response.rangeMessage.messages[19].msgId:string}}",
        "messageBody": "{\"title\":\"{{response.rangeMessage.messages[19].messageBody.$json.title:string}}\",\"isPresent\":true,\"messageId\":\"{{response.rangeMessage.messages[19].messageBody.$json.messageId:number}}\",\"recallMessageId\":\"{{response.rangeMessage.messages[19].messageBody.$json.recallMessageId:string}}\",\"from\":\"{{response.rangeMessage.messages[19].messageBody.$json.from:string}}\",\"createTime\":\"{{response.rangeMessage.messages[19].messageBody.$json.createTime:number}}\",\"code\":2,\"operator\":\"{{response.rangeMessage.messages[19].messageBody.$json.operator:string}}\",\"operatorName\":\"{{response.rangeMessage.messages[19].messageBody.$json.operatorName:string}}\"}",
        "fromJid": "{{response.rangeMessage.messages[19].fromJid:string}}",
        "toJid": "{{response.rangeMessage.messages[19].toJid:string}}",
        "threadId": "",
        "subject": "",
        "createTime": "{{response.rangeMessage.messages[19].createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 1009,
        "isread": false,
        "source": "",
        "receiptRange": 0
      }
    ]
  }
}
```

写请求未知结果先读回，不自动重发。具体 UI 操作、目标和状态收敛见 [验证记录](../validation.md)。

## 未完成项

- 逐字段必填性、所有条件分支和失败范围尚未穷尽。
- 独立宿主 Origin/Profile/网络层尚未验证；页面内重放成功不能外推到原生 HTTP。
- 动态来源未闭环：见公共 head / 风控 / 身份来源的共同未完成项。
