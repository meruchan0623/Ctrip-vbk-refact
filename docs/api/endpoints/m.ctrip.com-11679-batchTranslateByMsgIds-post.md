# POST m.ctrip.com/restapi/soa2/11679/batchTranslateByMsgIds

状态：真实网页请求样本；完整实施准入尚未通过。固定网页版本、鉴权边界和占位符规则见 [鉴权说明](../authentication.md)。

- 完整地址：`https://m.ctrip.com/restapi/soa2/11679/batchTranslateByMsgIds`
- 请求方法：`POST`
- 范围：网页消息/身份/联系入口及共享读取契约
- 编码：JSON；HTTP Content-Type 见下表，不能由 body.contentType 推断
- Authentication：本轮浏览器 Cookie 会话；逐项 Cookie 必需性未证明，见鉴权说明
- 原始证据：[evidence/2026-10-30/02-controlled-open.json](../evidence/2026-10-30/02-controlled-open.json)、[evidence/2026-10-30/08-controlled-start-chat.json](../evidence/2026-10-30/08-controlled-start-chat.json)、[evidence/2026-10-30/14-upload-full-payload.json](../evidence/2026-10-30/14-upload-full-payload.json)、[evidence/2026-10-30/21-transfer-conversation-open.json](../evidence/2026-10-30/21-transfer-conversation-open.json)、[evidence/2026-10-30/23-transfer-target-open.json](../evidence/2026-10-30/23-transfer-target-open.json)、[evidence/2026-10-30/27-return-to-controlled.json](../evidence/2026-10-30/27-return-to-controlled.json)、[evidence/2026-10-30/30-controlled-remove-jim.json](../evidence/2026-10-30/30-controlled-remove-jim.json)、[evidence/2026-10-30/35-controlled-ws-text-ack.json](../evidence/2026-10-30/35-controlled-ws-text-ack.json)、[evidence/2026-10-30/40-controlled-quote-send.json](../evidence/2026-10-30/40-controlled-quote-send.json)、[evidence/2026-10-30/49-controlled-reopen-after-finish.json](../evidence/2026-10-30/49-controlled-reopen-after-finish.json)、[evidence/2026-10-30/51-controlled-http-send-fallback.json](../evidence/2026-10-30/51-controlled-http-send-fallback.json)、[evidence/2026-10-30/55-controlled-sidebar-document.json](../evidence/2026-10-30/55-controlled-sidebar-document.json)

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
  "source": "AUTO",
  "target": "{{body.target:string}}",
  "sessionId": "{{body.sessionId:string}}",
  "groupId": "{{body.groupId:string}}",
  "bizType": 1513,
  "appId": "100017720",
  "messageIdList": [
    "{{body.messageIdList[0]:string}}",
    "{{body.messageIdList[1]:string}}",
    "{{body.messageIdList[2]:string}}",
    "{{body.messageIdList[3]:string}}",
    "{{body.messageIdList[4]:string}}",
    "{{body.messageIdList[5]:string}}",
    "{{body.messageIdList[6]:string}}",
    "{{body.messageIdList[7]:string}}",
    "{{body.messageIdList[8]:string}}"
  ]
}
```

### 样本 2：08-controlled-start-chat / HTTP 200 / Ack Success

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
  "source": "AUTO",
  "target": "{{body.target:string}}",
  "chatType": "{{body.chatType:string}}",
  "sessionId": "{{body.sessionId:string}}",
  "groupId": "{{body.groupId:string}}",
  "bizType": 1513,
  "appId": "100017720",
  "messageIdList": [
    "{{body.messageIdList[0]:string}}",
    "{{body.messageIdList[1]:string}}",
    "{{body.messageIdList[2]:string}}",
    "{{body.messageIdList[3]:string}}",
    "{{body.messageIdList[4]:string}}",
    "{{body.messageIdList[5]:string}}",
    "{{body.messageIdList[6]:string}}",
    "{{body.messageIdList[7]:string}}",
    "{{body.messageIdList[8]:string}}",
    "{{body.messageIdList[9]:string}}"
  ]
}
```

### 样本 3：27-return-to-controlled / HTTP 200 / Ack Success

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
  "source": "AUTO",
  "target": "{{body.target:string}}",
  "chatType": "{{body.chatType:string}}",
  "sessionId": "{{body.sessionId:string}}",
  "groupId": "{{body.groupId:string}}",
  "bizType": 1513,
  "appId": "100017720",
  "messageIdList": [
    "{{body.messageIdList[0]:string}}",
    "{{body.messageIdList[1]:string}}",
    "{{body.messageIdList[2]:string}}",
    "{{body.messageIdList[3]:string}}",
    "{{body.messageIdList[4]:string}}",
    "{{body.messageIdList[5]:string}}",
    "{{body.messageIdList[6]:string}}",
    "{{body.messageIdList[7]:string}}"
  ]
}
```

### 样本 4：23-transfer-target-open / HTTP 200 / Ack Success

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
  "source": "AUTO",
  "target": "{{body.target:string}}",
  "chatType": "{{body.chatType:string}}",
  "sessionId": "{{body.sessionId:string}}",
  "groupId": "{{body.groupId:string}}",
  "bizType": 1513,
  "appId": "100017720",
  "messageIdList": [
    "{{body.messageIdList[0]:string}}",
    "{{body.messageIdList[1]:string}}",
    "{{body.messageIdList[2]:string}}",
    "{{body.messageIdList[3]:string}}",
    "{{body.messageIdList[4]:string}}",
    "{{body.messageIdList[5]:string}}",
    "{{body.messageIdList[6]:string}}"
  ]
}
```

### 样本 5：51-controlled-http-send-fallback / HTTP 200 / Ack Success

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
  "source": "AUTO",
  "target": "{{body.target:string}}",
  "chatType": "groupchat",
  "sessionId": "{{body.sessionId:string}}",
  "groupId": "{{body.groupId:string}}",
  "bizType": 1513,
  "appId": "100017720",
  "messageIdList": [
    "{{body.messageIdList[0]:string}}"
  ]
}
```

### 样本 6：49-controlled-reopen-after-finish / HTTP 200 / Ack Success

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
  "source": "AUTO",
  "target": "{{body.target:string}}",
  "chatType": "groupchat",
  "sessionId": "{{body.sessionId:string}}",
  "groupId": "{{body.groupId:string}}",
  "bizType": 1513,
  "appId": "100017720",
  "messageIdList": [
    "{{body.messageIdList[0]:string}}",
    "{{body.messageIdList[1]:string}}",
    "{{body.messageIdList[2]:string}}",
    "{{body.messageIdList[3]:string}}",
    "{{body.messageIdList[4]:string}}",
    "{{body.messageIdList[5]:string}}",
    "{{body.messageIdList[6]:string}}",
    "{{body.messageIdList[7]:string}}",
    "{{body.messageIdList[8]:string}}"
  ]
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
| `source` | `string` | 本轮实际观测值；必填性、默认值及完整取值范围未由单次样本证明 |
| `target` | `string` | 待追溯：当前仅保留位置与类型，来源未闭环，阻塞自行构造请求 |
| `sessionId` | `string` | 当前会话 conversation.sessionId / startChatB2C 返回值 |
| `groupId` | `string` | 当前会话 conversation.gid；保留本调用点的原始类型 |
| `bizType` | `number` | 本轮实际观测值；必填性、默认值及完整取值范围未由单次样本证明 |
| `appId` | `string` | 本轮实际观测值；必填性、默认值及完整取值范围未由单次样本证明 |
| `messageIdList` | `array` | 本轮实际观测值；必填性、默认值及完整取值范围未由单次样本证明 |
| `messageIdList[]` | `string` | 当前待翻译消息的服务端 msgId 集合 |
| `chatType` | `string` | 当前调用点的单聊/群聊映射；不要直接用 B2C 替换 SDK 群聊枚举 |

“观测到”不等于“必填”。本轮未进行完整删字段/边界矩阵，不编造 required、默认值、枚举或省略行为。

## 响应与读回

完整响应结构和脱敏实例在以上证据的 responseSchema / responseTemplate；上传另有 xhr.response。HTTP 200、Ack Success 和最终业务状态分别判断。

```json
{
  "ResponseStatus": {
    "Timestamp": "{{response.ResponseStatus.Timestamp:string}}",
    "Ack": "Success",
    "Errors": [],
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
  "status": {
    "code": "0",
    "msg": ""
  },
  "supplier": "{{response.supplier:string}}",
  "translateMessageList": [
    {
      "msgId": "{{response.translateMessageList[0].msgId:string}}",
      "messageBody": "{{response.translateMessageList[0].messageBody:string}}",
      "fromJid": "{{response.translateMessageList[0].fromJid:string}}",
      "toJid": "{{response.translateMessageList[0].toJid:string}}",
      "threadId": "{{response.translateMessageList[0].threadId:string}}",
      "subject": "",
      "createTime": "{{response.translateMessageList[0].createTime:number}}",
      "bizType": "1513",
      "partner": "{{response.translateMessageList[0].partner:string}}",
      "type": "groupchat",
      "status": 0,
      "msgtype": 0,
      "isread": true,
      "receiptRange": 0
    },
    {
      "msgId": "{{response.translateMessageList[1].msgId:string}}",
      "messageBody": "{\"title\":\"{{response.translateMessageList[1].messageBody.$json.title:string}}\",\"action\":\"CTL01\",\"ext\":{\"templateId\":\"{{response.translateMessageList[1].messageBody.$json.ext.templateId:string}}\",\"type\":\"\",\"isPlay\":\"\",\"title\":\"{{response.translateMessageList[1].messageBody.$json.ext.title:string}}\",\"desc\":\"{{response.translateMessageList[1].messageBody.$json.ext.desc:string}}\",\"avatar\":\"\",\"nickName\":\"\",\"fromCardHide\":\"{{response.translateMessageList[1].messageBody.$json.ext.fromCardHide:string}}\",\"toCardHide\":\"\",\"dataInfoList\":[{\"Id\":\"{{response.translateMessageList[1].messageBody.$json.ext.dataInfoList[0].Id:string}}\",\"title\":\"{{response.translateMessageList[1].messageBody.$json.ext.dataInfoList[0].title:string}}\",\"text\":\"{{response.translateMessageList[1].messageBody.$json.ext.dataInfoList[0].text:string}}\"},{\"Id\":\"{{response.translateMessageList[1].messageBody.$json.ext.dataInfoList[1].Id:string}}\",\"title\":\"{{response.translateMessageList[1].messageBody.$json.ext.dataInfoList[1].title:string}}\",\"text\":\"{{response.translateMessageList[1].messageBody.$json.ext.dataInfoList[1].text:string}}\"},{\"Id\":\"{{response.translateMessageList[1].messageBody.$json.ext.dataInfoList[2].Id:string}}\",\"title\":\"{{response.translateMessageList[1].messageBody.$json.ext.dataInfoList[2].title:string}}\",\"text\":\"{{response.translateMessageList[1].messageBody.$json.ext.dataInfoList[2].text:string}}\"},{\"Id\":\"{{response.translateMessageList[1].messageBody.$json.ext.dataInfoList[3].Id:string}}\",\"title\":\"{{response.translateMessageList[1].messageBody.$json.ext.dataInfoList[3].title:string}}\",\"text\":\"{{response.translateMessageList[1].messageBody.$json.ext.dataInfoList[3].text:string}}\"},{\"Id\":\"{{response.translateMessageList[1].messageBody.$json.ext.dataInfoList[4].Id:string}}\",\"title\":\"{{response.translateMessageList[1].messageBody.$json.ext.dataInfoList[4].title:string}}\",\"text\":\"{{response.translateMessageList[1].messageBody.$json.ext.dataInfoList[4].text:string}}\"}],\"extendInfo\":{\"fromJumpUrl\":\"{{response.translateMessageList[1].messageBody.$json.ext.extendInfo.fromJumpUrl:string}}\",\"fromJumpUrlHybrid\":\"{{response.translateMessageList[1].messageBody.$json.ext.extendInfo.fromJumpUrlHybrid:string}}\",\"fromJumpUrlOnline\":\"{{response.translateMessageList[1].messageBody.$json.ext.extendInfo.fromJumpUrlOnline:string}}\",\"toJumpUrl\":\"{{response.translateMessageList[1].messageBody.$json.ext.extendInfo.toJumpUrl:string}}\",\"toJumpUrlHybrid\":\"{{response.translateMessageList[1].messageBody.$json.ext.extendInfo.toJumpUrlHybrid:string}}\",\"toJumpUrlOnline\":\"{{response.translateMessageList[1].messageBody.$json.ext.extendInfo.toJumpUrlOnline:string}}\",\"productId\":\"{{response.translateMessageList[1].messageBody.$json.ext.extendInfo.productId:string}}\",\"isSelfOwned\":\"{{response.translateMessageList[1].messageBody.$json.ext.extendInfo.isSelfOwned:string}}\",\"departCityId\":null,\"sessionId\":\"{{response.translateMessageList[1].messageBody.$json.ext.extendInfo.sessionId:string}}\",\"platformName\":\"{{response.translateMessageList[1].messageBody.$json.ext.extendInfo.platformName:string}}\",\"uid\":\"{{response.translateMessageList[1].messageBody.$json.ext.extendInfo.uid:string}}\",\"orderId\":\"{{response.translateMessageList[1].messageBody.$json.ext.extendInfo.orderId:string}}\",\"activityTripDefaultIMUrl\":\"{{response.translateMessageList[1].messageBody.$json.ext.extendInfo.activityTripDefaultIMUrl:string}}\",\"platformId\":2,\"DestinationType\":\"{{response.translateMessageList[1].messageBody.$json.ext.extendInfo.DestinationType:string}}\",\"shopping\":\"\",\"gid\":\"{{response.translateMessageList[1].messageBody.$json.ext.extendInfo.gid:string}}\",\"jid\":\"{{response.translateMessageList[1].messageBody.$json.ext.extendInfo.jid:string}}\",\"Platform\":\"APP\",\"departureCityName\":\"\",\"customerUid\":\"{{response.translateMessageList[1].messageBody.$json.ext.extendInfo.customerUid:string}}\",\"saleCityId\":null,\"providerProductName\":\"{{response.translateMessageList[1].messageBody.$json.ext.extendInfo.providerProductName:string}}\",\"Type\":\"3\",\"locale\":\"zh-CN\",\"providerId\":\"{{response.translateMessageList[1].messageBody.$json.ext.extendInfo.providerId:string}}\",\"singleChatUrl\":\"\"}}}",
      "fromJid": "{{response.translateMessageList[1].fromJid:string}}",
      "toJid": "{{response.translateMessageList[1].toJid:string}}",
      "threadId": "",
      "subject": "",
      "createTime": "{{response.translateMessageList[1].createTime:number}}",
      "bizType": "1513",
      "partner": "{{response.translateMessageList[1].partner:string}}",
      "type": "groupchat",
      "status": 0,
      "msgtype": 7,
      "isread": true,
      "receiptRange": 0
    },
    {
      "msgId": "{{response.translateMessageList[2].msgId:string}}",
      "messageBody": "{{response.translateMessageList[2].messageBody:string}}",
      "fromJid": "{{response.translateMessageList[2].fromJid:string}}",
      "toJid": "{{response.translateMessageList[2].toJid:string}}",
      "threadId": "{{response.translateMessageList[2].threadId:string}}",
      "subject": "",
      "createTime": "{{response.translateMessageList[2].createTime:number}}",
      "bizType": "1513",
      "partner": "{{response.translateMessageList[2].partner:string}}",
      "type": "groupchat",
      "status": 0,
      "msgtype": 0,
      "isread": true,
      "receiptRange": 0
    },
    {
      "msgId": "{{response.translateMessageList[3].msgId:string}}",
      "messageBody": "{\"isPresent\":false,\"title\":\"{{response.translateMessageList[3].messageBody.$json.title:string}}\",\"action\":\"NBZ37\",\"ext\":{\"nickName\":\"{{response.translateMessageList[3].messageBody.$json.ext.nickName:string}}\",\"visibleRule\":0,\"vendorUid\":\"{{response.translateMessageList[3].messageBody.$json.ext.vendorUid:string}}\"},\"sid\":\"{{response.translateMessageList[3].messageBody.$json.sid:string}}\",\"see\":0,\"bSee\":0,\"bsee\":0}",
      "fromJid": "{{response.translateMessageList[3].fromJid:string}}",
      "toJid": "{{response.translateMessageList[3].toJid:string}}",
      "threadId": "{{response.translateMessageList[3].threadId:string}}",
      "subject": "",
      "createTime": "{{response.translateMessageList[3].createTime:number}}",
      "bizType": "1513",
      "partner": "{{response.translateMessageList[3].partner:string}}",
      "type": "groupchat",
      "status": 0,
      "msgtype": 1007,
      "isread": true,
      "receiptRange": 0
    },
    {
      "msgId": "{{response.translateMessageList[4].msgId:string}}",
      "messageBody": "{\"isPresent\":false,\"title\":\"{{response.translateMessageList[4].messageBody.$json.title:string}}\",\"action\":\"NBZ37\",\"ext\":{\"nickName\":\"{{response.translateMessageList[4].messageBody.$json.ext.nickName:string}}\",\"visibleRule\":0,\"vendorUid\":\"{{response.translateMessageList[4].messageBody.$json.ext.vendorUid:string}}\"},\"sid\":\"{{response.translateMessageList[4].messageBody.$json.sid:string}}\",\"see\":0,\"bSee\":0,\"bsee\":0}",
      "fromJid": "{{response.translateMessageList[4].fromJid:string}}",
      "toJid": "{{response.translateMessageList[4].toJid:string}}",
      "threadId": "{{response.translateMessageList[4].threadId:string}}",
      "subject": "",
      "createTime": "{{response.translateMessageList[4].createTime:number}}",
      "bizType": "1513",
      "partner": "{{response.translateMessageList[4].partner:string}}",
      "type": "groupchat",
      "status": 0,
      "msgtype": 1007,
      "isread": true,
      "receiptRange": 0
    },
    {
      "msgId": "{{response.translateMessageList[5].msgId:string}}",
      "messageBody": "{\"isPresent\":false,\"title\":\"{{response.translateMessageList[5].messageBody.$json.title:string}}\",\"action\":\"NBZ37\",\"ext\":{\"nickName\":\"{{response.translateMessageList[5].messageBody.$json.ext.nickName:string}}\",\"visibleRule\":0,\"vendorUid\":\"{{response.translateMessageList[5].messageBody.$json.ext.vendorUid:string}}\"},\"sid\":\"{{response.translateMessageList[5].messageBody.$json.sid:string}}\",\"see\":0,\"bSee\":0,\"bsee\":0}",
      "fromJid": "{{response.translateMessageList[5].fromJid:string}}",
      "toJid": "{{response.translateMessageList[5].toJid:string}}",
      "threadId": "{{response.translateMessageList[5].threadId:string}}",
      "subject": "",
      "createTime": "{{response.translateMessageList[5].createTime:number}}",
      "bizType": "1513",
      "partner": "{{response.translateMessageList[5].partner:string}}",
      "type": "groupchat",
      "status": 0,
      "msgtype": 1007,
      "isread": true,
      "receiptRange": 0
    },
    {
      "msgId": "{{response.translateMessageList[6].msgId:string}}",
      "messageBody": "{{response.translateMessageList[6].messageBody:string}}",
      "fromJid": "{{response.translateMessageList[6].fromJid:string}}",
      "toJid": "{{response.translateMessageList[6].toJid:string}}",
      "threadId": "",
      "subject": "",
      "createTime": "{{response.translateMessageList[6].createTime:number}}",
      "bizType": "1513",
      "partner": "{{response.translateMessageList[6].partner:string}}",
      "type": "groupchat",
      "status": 0,
      "msgtype": 0,
      "isread": true,
      "receiptRange": 0
    },
    {
      "msgId": "{{response.translateMessageList[7].msgId:string}}",
      "messageBody": "{{response.translateMessageList[7].messageBody:string}}",
      "fromJid": "{{response.translateMessageList[7].fromJid:string}}",
      "toJid": "{{response.translateMessageList[7].toJid:string}}",
      "threadId": "",
      "subject": "",
      "createTime": "{{response.translateMessageList[7].createTime:number}}",
      "bizType": "1513",
      "partner": "{{response.translateMessageList[7].partner:string}}",
      "type": "groupchat",
      "status": 0,
      "msgtype": 0,
      "isread": true,
      "receiptRange": 0,
      "citeMsgId": "{{response.translateMessageList[7].citeMsgId:string}}"
    },
    {
      "msgId": "{{response.translateMessageList[8].msgId:string}}",
      "messageBody": "{{response.translateMessageList[8].messageBody:string}}",
      "fromJid": "{{response.translateMessageList[8].fromJid:string}}",
      "toJid": "{{response.translateMessageList[8].toJid:string}}",
      "threadId": "{{response.translateMessageList[8].threadId:string}}",
      "subject": "",
      "createTime": "{{response.translateMessageList[8].createTime:number}}",
      "bizType": "1513",
      "partner": "{{response.translateMessageList[8].partner:string}}",
      "type": "groupchat",
      "status": 0,
      "msgtype": 0,
      "isread": false,
      "receiptRange": 0
    }
  ],
  "idWithTranslatedMap": {
    "dynamic_ref_b56c98997d05": true,
    "dynamic_ref_620a630a0ba4": false,
    "dynamic_ref_bb2480cc3bbd": true,
    "dynamic_ref_509b92268894": false,
    "dynamic_ref_c395906f0d54": true,
    "dynamic_ref_982a89fca187": true,
    "dynamic_ref_b6a75b3e0cd8": true,
    "dynamic_ref_c303cbe00666": true,
    "dynamic_ref_e9e0690bd455": false
  }
}
```

写请求未知结果先读回，不自动重发。具体 UI 操作、目标和状态收敛见 [验证记录](../validation.md)。

## 未完成项

- 逐字段必填性、所有条件分支和失败范围尚未穷尽。
- 独立宿主 Origin/Profile/网络层尚未验证；页面内重放成功不能外推到原生 HTTP。
- 动态来源未闭环：`target`
