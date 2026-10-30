# POST m.ctrip.com/restapi/soa2/16037/getConversationInfoByGidList

状态：真实网页请求样本；完整实施准入尚未通过。固定网页版本、鉴权边界和占位符规则见 [鉴权说明](../authentication.md)。

- 完整地址：`https://m.ctrip.com/restapi/soa2/16037/getConversationInfoByGidList`
- 请求方法：`POST`
- 范围：网页消息/身份/联系入口及共享读取契约
- 编码：JSON；HTTP Content-Type 见下表，不能由 body.contentType 推断
- Authentication：本轮浏览器 Cookie 会话；逐项 Cookie 必需性未证明，见鉴权说明
- 原始证据：[evidence/2026-10-30/01-bootstrap.json](../evidence/2026-10-30/01-bootstrap.json)、[evidence/2026-10-30/02-controlled-open.json](../evidence/2026-10-30/02-controlled-open.json)、[evidence/2026-10-30/08-controlled-start-chat.json](../evidence/2026-10-30/08-controlled-start-chat.json)、[evidence/2026-10-30/14-upload-full-payload.json](../evidence/2026-10-30/14-upload-full-payload.json)、[evidence/2026-10-30/21-transfer-conversation-open.json](../evidence/2026-10-30/21-transfer-conversation-open.json)、[evidence/2026-10-30/23-transfer-target-open.json](../evidence/2026-10-30/23-transfer-target-open.json)、[evidence/2026-10-30/27-return-to-controlled.json](../evidence/2026-10-30/27-return-to-controlled.json)、[evidence/2026-10-30/49-controlled-reopen-after-finish.json](../evidence/2026-10-30/49-controlled-reopen-after-finish.json)、[evidence/2026-10-30/54-sdk-restored-by-official-page-reload.json](../evidence/2026-10-30/54-sdk-restored-by-official-page-reload.json)、[evidence/2026-10-30/55-controlled-sidebar-document.json](../evidence/2026-10-30/55-controlled-sidebar-document.json)、[evidence/2026-10-30/58-order-list-page-initialization.json](../evidence/2026-10-30/58-order-list-page-initialization.json)、[evidence/2026-10-30/60-controlled-order-detail.json](../evidence/2026-10-30/60-controlled-order-detail.json)、[evidence/2026-10-30/61-controlled-order-createimchat.json](../evidence/2026-10-30/61-controlled-order-createimchat.json)

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

### 样本 1：54-sdk-restored-by-official-page-reload / HTTP 200 / Ack Success

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
  "gidList": [
    "{{body.gidList[0]:string}}",
    "{{body.gidList[1]:string}}",
    "{{body.gidList[2]:string}}",
    "{{body.gidList[3]:string}}",
    "{{body.gidList[4]:string}}",
    "{{body.gidList[5]:string}}",
    "{{body.gidList[6]:string}}",
    "{{body.gidList[7]:string}}",
    "{{body.gidList[8]:string}}",
    "{{body.gidList[9]:string}}",
    "{{body.gidList[10]:string}}",
    "{{body.gidList[11]:string}}",
    "{{body.gidList[12]:string}}",
    "{{body.gidList[13]:string}}",
    "{{body.gidList[14]:string}}",
    "{{body.gidList[15]:string}}",
    "{{body.gidList[16]:string}}",
    "{{body.gidList[17]:string}}",
    "{{body.gidList[18]:string}}",
    "{{body.gidList[19]:string}}"
  ]
}
```

### 样本 2：60-controlled-order-detail / HTTP 200 / Ack Success

```json
{
  "gidList": [
    "{{body.gidList[0]:string}}",
    "{{body.gidList[1]:string}}",
    "{{body.gidList[2]:string}}",
    "{{body.gidList[3]:string}}",
    "{{body.gidList[4]:string}}",
    "{{body.gidList[5]:string}}",
    "{{body.gidList[6]:string}}",
    "{{body.gidList[7]:string}}",
    "{{body.gidList[8]:string}}",
    "{{body.gidList[9]:string}}"
  ],
  "head": {
    "cver": "2",
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
        "value": "vbk"
      },
      {
        "name": "client-source",
        "value": "pc-1001"
      },
      {
        "name": "locale",
        "value": "zh-CN"
      }
    ]
  }
}
```

### 样本 3：01-bootstrap / HTTP 200 / Ack Success

```json
{
  "gidList": [
    "{{body.gidList[0]:string}}",
    "{{body.gidList[1]:string}}",
    "{{body.gidList[2]:string}}",
    "{{body.gidList[3]:string}}",
    "{{body.gidList[4]:string}}"
  ],
  "head": {
    "cver": "2",
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
        "value": "vbk"
      },
      {
        "name": "client-source",
        "value": "pc-1001"
      },
      {
        "name": "locale",
        "value": "zh-CN"
      }
    ]
  }
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
  "gidList": [
    "{{body.gidList[0]:string}}"
  ]
}
```

### 样本 5：60-controlled-order-detail / HTTP 200 / Ack Success

```json
{
  "gidList": [
    "{{body.gidList[0]:string}}",
    "{{body.gidList[1]:string}}",
    "{{body.gidList[2]:string}}",
    "{{body.gidList[3]:string}}"
  ],
  "head": {
    "cver": "2",
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
        "value": "vbk"
      },
      {
        "name": "client-source",
        "value": "pc-1001"
      },
      {
        "name": "locale",
        "value": "zh-CN"
      }
    ]
  }
}
```

### 样本 6：55-controlled-sidebar-document / HTTP 200 / Ack Success

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
  "gidList": [
    "{{body.gidList[0]:string}}"
  ]
}
```

### 样本 7：61-controlled-order-createimchat / HTTP 200 / Ack Success

```json
{
  "gidList": [
    "{{body.gidList[0]:string}}",
    "{{body.gidList[1]:string}}",
    "{{body.gidList[2]:string}}",
    "{{body.gidList[3]:string}}"
  ],
  "head": {
    "cver": "2",
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
        "value": "vbk"
      },
      {
        "name": "client-source",
        "value": "pc-1001"
      },
      {
        "name": "locale",
        "value": "zh-CN"
      }
    ]
  }
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
| `gidList` | `array` | 本轮实际观测值；必填性、默认值及完整取值范围未由单次样本证明 |
| `gidList[]` | `string` | 需要补查的服务端会话 gid 集合 |

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
  "conversationInfoList": [
    {
      "gid": "{{response.conversationInfoList[0].gid:string}}",
      "unreadCount": 0,
      "message": {
        "msgId": "{{response.conversationInfoList[0].message.msgId:string}}",
        "messageBody": "{{response.conversationInfoList[0].message.messageBody:string}}",
        "fromJid": "{{response.conversationInfoList[0].message.fromJid:string}}",
        "toJid": "{{response.conversationInfoList[0].message.toJid:string}}",
        "threadId": "{{response.conversationInfoList[0].message.threadId:string}}",
        "subject": "",
        "createTime": "{{response.conversationInfoList[0].message.createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 0,
        "isread": true,
        "source": "",
        "receiptRange": 0
      }
    },
    {
      "gid": "{{response.conversationInfoList[1].gid:string}}",
      "unreadCount": 0,
      "message": {
        "msgId": "{{response.conversationInfoList[1].message.msgId:string}}",
        "messageBody": "{{response.conversationInfoList[1].message.messageBody:string}}",
        "fromJid": "{{response.conversationInfoList[1].message.fromJid:string}}",
        "toJid": "{{response.conversationInfoList[1].message.toJid:string}}",
        "threadId": "{{response.conversationInfoList[1].message.threadId:string}}",
        "subject": "",
        "createTime": "{{response.conversationInfoList[1].message.createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 0,
        "isread": true,
        "source": "",
        "receiptRange": 0
      }
    },
    {
      "gid": "{{response.conversationInfoList[2].gid:string}}",
      "unreadCount": 0,
      "message": {
        "msgId": "{{response.conversationInfoList[2].message.msgId:string}}",
        "messageBody": "{{response.conversationInfoList[2].message.messageBody:string}}",
        "fromJid": "{{response.conversationInfoList[2].message.fromJid:string}}",
        "toJid": "{{response.conversationInfoList[2].message.toJid:string}}",
        "threadId": "{{response.conversationInfoList[2].message.threadId:string}}",
        "subject": "",
        "createTime": "{{response.conversationInfoList[2].message.createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 0,
        "isread": true,
        "source": "",
        "receiptRange": 0
      }
    },
    {
      "gid": "{{response.conversationInfoList[3].gid:string}}",
      "unreadCount": 0,
      "message": {
        "msgId": "{{response.conversationInfoList[3].message.msgId:string}}",
        "messageBody": "{{response.conversationInfoList[3].message.messageBody:string}}",
        "fromJid": "{{response.conversationInfoList[3].message.fromJid:string}}",
        "toJid": "{{response.conversationInfoList[3].message.toJid:string}}",
        "threadId": "{{response.conversationInfoList[3].message.threadId:string}}",
        "subject": "",
        "createTime": "{{response.conversationInfoList[3].message.createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 0,
        "isread": true,
        "source": "",
        "receiptRange": 0,
        "citeMsgId": "{{response.conversationInfoList[3].message.citeMsgId:string}}",
        "citeMessageInfo": {
          "msgId": "{{response.conversationInfoList[3].message.citeMessageInfo.msgId:string}}",
          "msgtype": 7,
          "messageBody": "{\"action\":\"CBZ06\",\"ext\":{\"aiMsgType\":0,\"customerType\":\"{{response.conversationInfoList[3].message.citeMessageInfo.messageBody.$json.ext.customerType:number}}\",\"hitAgent\":\"\",\"msgScene\":\"{{response.conversationInfoList[3].message.citeMessageInfo.messageBody.$json.ext.msgScene:string}}\",\"orderid\":\"{{response.conversationInfoList[3].message.citeMessageInfo.messageBody.$json.ext.orderid:string}}\",\"profile\":\"{\\\"Channel\\\":\\\"VAC\\\",\\\"Locale\\\":\\\"en_PH\\\",\\\"PageId\\\":\\\"{{response.conversationInfoList[3].message.citeMessageInfo.messageBody.$json.ext.profile.$json.PageId:string}}\\\",\\\"appVersion\\\":\\\"{{response.conversationInfoList[3].message.citeMessageInfo.messageBody.$json.ext.profile.$json.appVersion:string}}\\\",\\\"bu\\\":\\\"{{response.conversationInfoList[3].message.citeMessageInfo.messageBody.$json.ext.profile.$json.bu:string}}\\\",\\\"cid\\\":\\\"{{response.conversationInfoList[3].message.citeMessageInfo.messageBody.$json.ext.profile.$json.cid:string}}\\\",\\\"cityId\\\":\\\"{{response.conversationInfoList[3].message.citeMessageInfo.messageBody.$json.ext.profile.$json.cityId:string}}\\\",\\\"cityName\\\":\\\"{{response.conversationInfoList[3].message.citeMessageInfo.messageBody.$json.ext.profile.$json.cityName:string}}\\\",\\\"coordinate\\\":\\\"{{response.conversationInfoList[3].message.citeMessageInfo.messageBody.$json.ext.profile.$json.coordinate:string}}\\\",\\\"ctype\\\":\\\"{{response.conversationInfoList[3].message.citeMessageInfo.messageBody.$json.ext.profile.$json.ctype:string}}\\\",\\\"latitude\\\":\\\"{{response.conversationInfoList[3].message.citeMessageInfo.messageBody.$json.ext.profile.$json.latitude:string}}\\\",\\\"longitude\\\":\\\"{{response.conversationInfoList[3].message.citeMessageInfo.messageBody.$json.ext.profile.$json.longitude:string}}\\\",\\\"needSendUserMessage\\\":1,\\\"pageFrom\\\":\\\"{{response.conversationInfoList[3].message.citeMessageInfo.messageBody.$json.ext.profile.$json.pageFrom:string}}\\\",\\\"supplierId\\\":\\\"{{response.conversationInfoList[3].message.citeMessageInfo.messageBody.$json.ext.profile.$json.supplierId:string}}\\\",\\\"thirdPartytoken\\\":\\\"{{response.conversationInfoList[3].message.citeMessageInfo.messageBody.$json.ext.profile.$json.thirdPartytoken:string}}\\\",\\\"title\\\":\\\"{{response.conversationInfoList[3].message.citeMessageInfo.messageBody.$json.ext.profile.$json.title:string}}\\\"}\",\"rateSolveCode\":0,\"thirdPartytoken\":\"{{response.conversationInfoList[3].message.citeMessageInfo.messageBody.$json.ext.thirdPartytoken:string}}\",\"uiType\":\"\",\"key\":\"{{response.conversationInfoList[3].message.citeMessageInfo.messageBody.$json.ext.key:string}}\"},\"title\":\"{{response.conversationInfoList[3].message.citeMessageInfo.messageBody.$json.title:string}}\"}",
          "fromJid": "{{response.conversationInfoList[3].message.citeMessageInfo.fromJid:string}}",
          "toJid": "{{response.conversationInfoList[3].message.citeMessageInfo.toJid:string}}",
          "createTime": "{{response.conversationInfoList[3].message.citeMessageInfo.createTime:number}}",
          "status": 1,
          "visible": 1,
          "valid": 1,
          "source": ""
        }
      }
    },
    {
      "gid": "{{response.conversationInfoList[4].gid:string}}",
      "unreadCount": 0,
      "message": {
        "msgId": "{{response.conversationInfoList[4].message.msgId:string}}",
        "messageBody": "{{response.conversationInfoList[4].message.messageBody:string}}",
        "fromJid": "{{response.conversationInfoList[4].message.fromJid:string}}",
        "toJid": "{{response.conversationInfoList[4].message.toJid:string}}",
        "threadId": "{{response.conversationInfoList[4].message.threadId:string}}",
        "subject": "",
        "createTime": "{{response.conversationInfoList[4].message.createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 0,
        "isread": true,
        "source": "",
        "receiptRange": 0
      }
    },
    {
      "gid": "{{response.conversationInfoList[5].gid:string}}",
      "unreadCount": 0,
      "message": {
        "msgId": "{{response.conversationInfoList[5].message.msgId:string}}",
        "messageBody": "{{response.conversationInfoList[5].message.messageBody:string}}",
        "fromJid": "{{response.conversationInfoList[5].message.fromJid:string}}",
        "toJid": "{{response.conversationInfoList[5].message.toJid:string}}",
        "threadId": "{{response.conversationInfoList[5].message.threadId:string}}",
        "subject": "",
        "createTime": "{{response.conversationInfoList[5].message.createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 0,
        "isread": true,
        "source": "",
        "receiptRange": 0
      }
    },
    {
      "gid": "{{response.conversationInfoList[6].gid:string}}",
      "unreadCount": 0,
      "message": {
        "msgId": "{{response.conversationInfoList[6].message.msgId:string}}",
        "messageBody": "{\"gtype\":\"{{response.conversationInfoList[6].message.messageBody.$json.gtype:string}}\",\"btype\":\"{{response.conversationInfoList[6].message.messageBody.$json.btype:string}}\",\"tip\":\"\",\"gname\":\"{{response.conversationInfoList[6].message.messageBody.$json.gname:string}}\",\"operator\":\"{{response.conversationInfoList[6].message.messageBody.$json.operator:string}}\",\"content\":[\"{{response.conversationInfoList[6].message.messageBody.$json.content[0]:string}}\"],\"infos\":[{\"user\":\"{{response.conversationInfoList[6].message.messageBody.$json.infos[0].user:string}}\",\"nickname\":\"{{response.conversationInfoList[6].message.messageBody.$json.infos[0].nickname:string}}\",\"avatar\":\"{{response.conversationInfoList[6].message.messageBody.$json.infos[0].avatar:string}}\",\"gname\":\"{{response.conversationInfoList[6].message.messageBody.$json.infos[0].gname:string}}\",\"butype\":\"{{response.conversationInfoList[6].message.messageBody.$json.infos[0].butype:string}}\",\"gtype\":\"{{response.conversationInfoList[6].message.messageBody.$json.infos[0].gtype:string}}\"}]}",
        "fromJid": "{{response.conversationInfoList[6].message.fromJid:string}}",
        "toJid": "{{response.conversationInfoList[6].message.toJid:string}}",
        "threadId": "",
        "subject": "",
        "createTime": "{{response.conversationInfoList[6].message.createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 1001,
        "isread": false,
        "source": "",
        "receiptRange": 1
      }
    },
    {
      "gid": "{{response.conversationInfoList[7].gid:string}}",
      "unreadCount": 0,
      "message": {
        "msgId": "{{response.conversationInfoList[7].message.msgId:string}}",
        "messageBody": "{{response.conversationInfoList[7].message.messageBody:string}}",
        "fromJid": "{{response.conversationInfoList[7].message.fromJid:string}}",
        "toJid": "{{response.conversationInfoList[7].message.toJid:string}}",
        "threadId": "{{response.conversationInfoList[7].message.threadId:string}}",
        "subject": "",
        "createTime": "{{response.conversationInfoList[7].message.createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 0,
        "isread": true,
        "source": "",
        "receiptRange": 0
      }
    },
    {
      "gid": "{{response.conversationInfoList[8].gid:string}}",
      "unreadCount": 0,
      "message": {
        "msgId": "{{response.conversationInfoList[8].message.msgId:string}}",
        "messageBody": "{{response.conversationInfoList[8].message.messageBody:string}}",
        "fromJid": "{{response.conversationInfoList[8].message.fromJid:string}}",
        "toJid": "{{response.conversationInfoList[8].message.toJid:string}}",
        "threadId": "{{response.conversationInfoList[8].message.threadId:string}}",
        "subject": "",
        "createTime": "{{response.conversationInfoList[8].message.createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 0,
        "isread": false,
        "source": "",
        "receiptRange": 0
      }
    },
    {
      "gid": "{{response.conversationInfoList[9].gid:string}}",
      "unreadCount": 0,
      "message": {
        "msgId": "{{response.conversationInfoList[9].message.msgId:string}}",
        "messageBody": "{{response.conversationInfoList[9].message.messageBody:string}}",
        "fromJid": "{{response.conversationInfoList[9].message.fromJid:string}}",
        "toJid": "{{response.conversationInfoList[9].message.toJid:string}}",
        "threadId": "{{response.conversationInfoList[9].message.threadId:string}}",
        "subject": "",
        "createTime": "{{response.conversationInfoList[9].message.createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 0,
        "isread": true,
        "source": "",
        "receiptRange": 0
      }
    },
    {
      "gid": "{{response.conversationInfoList[10].gid:string}}",
      "unreadCount": 0,
      "message": {
        "msgId": "{{response.conversationInfoList[10].message.msgId:string}}",
        "messageBody": "{{response.conversationInfoList[10].message.messageBody:string}}",
        "fromJid": "{{response.conversationInfoList[10].message.fromJid:string}}",
        "toJid": "{{response.conversationInfoList[10].message.toJid:string}}",
        "threadId": "{{response.conversationInfoList[10].message.threadId:string}}",
        "subject": "",
        "createTime": "{{response.conversationInfoList[10].message.createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 0,
        "isread": true,
        "source": "",
        "receiptRange": 0
      }
    },
    {
      "gid": "{{response.conversationInfoList[11].gid:string}}",
      "unreadCount": 0,
      "message": {
        "msgId": "{{response.conversationInfoList[11].message.msgId:string}}",
        "messageBody": "{{response.conversationInfoList[11].message.messageBody:string}}",
        "fromJid": "{{response.conversationInfoList[11].message.fromJid:string}}",
        "toJid": "{{response.conversationInfoList[11].message.toJid:string}}",
        "threadId": "{{response.conversationInfoList[11].message.threadId:string}}",
        "subject": "",
        "createTime": "{{response.conversationInfoList[11].message.createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 0,
        "isread": true,
        "source": "",
        "receiptRange": 0
      }
    },
    {
      "gid": "{{response.conversationInfoList[12].gid:string}}",
      "unreadCount": 0,
      "message": {
        "msgId": "{{response.conversationInfoList[12].message.msgId:string}}",
        "messageBody": "{{response.conversationInfoList[12].message.messageBody:string}}",
        "fromJid": "{{response.conversationInfoList[12].message.fromJid:string}}",
        "toJid": "{{response.conversationInfoList[12].message.toJid:string}}",
        "threadId": "{{response.conversationInfoList[12].message.threadId:string}}",
        "subject": "",
        "createTime": "{{response.conversationInfoList[12].message.createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 0,
        "isread": false,
        "source": "",
        "receiptRange": 0
      }
    },
    {
      "gid": "{{response.conversationInfoList[13].gid:string}}",
      "unreadCount": 0,
      "message": {
        "msgId": "{{response.conversationInfoList[13].message.msgId:string}}",
        "messageBody": "{{response.conversationInfoList[13].message.messageBody:string}}",
        "fromJid": "{{response.conversationInfoList[13].message.fromJid:string}}",
        "toJid": "{{response.conversationInfoList[13].message.toJid:string}}",
        "threadId": "{{response.conversationInfoList[13].message.threadId:string}}",
        "subject": "",
        "createTime": "{{response.conversationInfoList[13].message.createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 0,
        "isread": true,
        "source": "",
        "receiptRange": 0
      }
    },
    {
      "gid": "{{response.conversationInfoList[14].gid:string}}",
      "unreadCount": 0,
      "message": {
        "msgId": "{{response.conversationInfoList[14].message.msgId:string}}",
        "messageBody": "{{response.conversationInfoList[14].message.messageBody:string}}",
        "fromJid": "{{response.conversationInfoList[14].message.fromJid:string}}",
        "toJid": "{{response.conversationInfoList[14].message.toJid:string}}",
        "threadId": "{{response.conversationInfoList[14].message.threadId:string}}",
        "subject": "",
        "createTime": "{{response.conversationInfoList[14].message.createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 0,
        "isread": true,
        "source": "",
        "receiptRange": 0
      }
    },
    {
      "gid": "{{response.conversationInfoList[15].gid:string}}",
      "unreadCount": 0,
      "message": {
        "msgId": "{{response.conversationInfoList[15].message.msgId:string}}",
        "messageBody": "{{response.conversationInfoList[15].message.messageBody:string}}",
        "fromJid": "{{response.conversationInfoList[15].message.fromJid:string}}",
        "toJid": "{{response.conversationInfoList[15].message.toJid:string}}",
        "threadId": "{{response.conversationInfoList[15].message.threadId:string}}",
        "subject": "",
        "createTime": "{{response.conversationInfoList[15].message.createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 0,
        "isread": false,
        "source": "",
        "receiptRange": 0
      }
    },
    {
      "gid": "{{response.conversationInfoList[16].gid:string}}",
      "unreadCount": 0,
      "message": {
        "msgId": "{{response.conversationInfoList[16].message.msgId:string}}",
        "messageBody": "{\"gtype\":\"{{response.conversationInfoList[16].message.messageBody.$json.gtype:string}}\",\"btype\":\"{{response.conversationInfoList[16].message.messageBody.$json.btype:string}}\",\"tip\":\"\",\"gname\":\"{{response.conversationInfoList[16].message.messageBody.$json.gname:string}}\",\"operator\":\"{{response.conversationInfoList[16].message.messageBody.$json.operator:string}}\",\"content\":[\"{{response.conversationInfoList[16].message.messageBody.$json.content[0]:string}}\"],\"infos\":[{\"user\":\"{{response.conversationInfoList[16].message.messageBody.$json.infos[0].user:string}}\",\"nickname\":\"{{response.conversationInfoList[16].message.messageBody.$json.infos[0].nickname:string}}\",\"avatar\":\"{{response.conversationInfoList[16].message.messageBody.$json.infos[0].avatar:string}}\",\"gname\":\"{{response.conversationInfoList[16].message.messageBody.$json.infos[0].gname:string}}\",\"butype\":\"{{response.conversationInfoList[16].message.messageBody.$json.infos[0].butype:string}}\",\"gtype\":\"{{response.conversationInfoList[16].message.messageBody.$json.infos[0].gtype:string}}\"}]}",
        "fromJid": "{{response.conversationInfoList[16].message.fromJid:string}}",
        "toJid": "{{response.conversationInfoList[16].message.toJid:string}}",
        "threadId": "",
        "subject": "",
        "createTime": "{{response.conversationInfoList[16].message.createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 1001,
        "isread": false,
        "source": "",
        "receiptRange": 1
      }
    },
    {
      "gid": "{{response.conversationInfoList[17].gid:string}}",
      "unreadCount": 0,
      "message": {
        "msgId": "{{response.conversationInfoList[17].message.msgId:string}}",
        "messageBody": "{\"isPresent\":true,\"title\":\"{{response.conversationInfoList[17].message.messageBody.$json.title:string}}\",\"action\":\"NBZ30\",\"ext\":{\"inviteAgentUid\":\"{{response.conversationInfoList[17].message.messageBody.$json.ext.inviteAgentUid:string}}\",\"visibleRule\":7,\"acceptAgentNick\":\"{{response.conversationInfoList[17].message.messageBody.$json.ext.acceptAgentNick:string}}\"},\"sid\":\"{{response.conversationInfoList[17].message.messageBody.$json.sid:string}}\",\"see\":0,\"bSee\":0,\"bsee\":0}",
        "fromJid": "{{response.conversationInfoList[17].message.fromJid:string}}",
        "toJid": "{{response.conversationInfoList[17].message.toJid:string}}",
        "threadId": "{{response.conversationInfoList[17].message.threadId:string}}",
        "subject": "",
        "createTime": "{{response.conversationInfoList[17].message.createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 1007,
        "isread": false,
        "source": "",
        "receiptRange": 0
      }
    },
    {
      "gid": "{{response.conversationInfoList[18].gid:string}}",
      "unreadCount": 0,
      "message": {
        "msgId": "{{response.conversationInfoList[18].message.msgId:string}}",
        "messageBody": "{{response.conversationInfoList[18].message.messageBody:string}}",
        "fromJid": "{{response.conversationInfoList[18].message.fromJid:string}}",
        "toJid": "{{response.conversationInfoList[18].message.toJid:string}}",
        "threadId": "{{response.conversationInfoList[18].message.threadId:string}}",
        "subject": "",
        "createTime": "{{response.conversationInfoList[18].message.createTime:number}}",
        "bizType": "1513",
        "status": 0,
        "msgtype": 0,
        "isread": true,
        "source": "",
        "receiptRange": 0
      }
    },
    {
      "gid": "{{response.conversationInfoList[19].gid:string}}",
      "unreadCount": 0,
      "message": {
        "msgId": "{{response.conversationInfoList[19].message.msgId:string}}",
        "messageBody": "{{response.conversationInfoList[19].message.messageBody:string}}",
        "fromJid": "{{response.conversationInfoList[19].message.fromJid:string}}",
        "toJid": "{{response.conversationInfoList[19].message.toJid:string}}",
        "threadId": "{{response.conversationInfoList[19].message.threadId:string}}",
        "subject": "",
        "createTime": "{{response.conversationInfoList[19].message.createTime:number}}",
        "bizType": "1513",
        "status": 2,
        "msgtype": 0,
        "isread": false,
        "source": "",
        "receiptRange": 0
      }
    }
  ]
}
```

写请求未知结果先读回，不自动重发。具体 UI 操作、目标和状态收敛见 [验证记录](../validation.md)。

## 未完成项

- 逐字段必填性、所有条件分支和失败范围尚未穷尽。
- 独立宿主 Origin/Profile/网络层尚未验证；页面内重放成功不能外推到原生 HTTP。
- 动态来源未闭环：见公共 head / 风控 / 身份来源的共同未完成项。
