# POST m.ctrip.com/restapi/soa2/16037/startChatB2C

状态：真实网页请求样本；完整实施准入尚未通过。固定网页版本、鉴权边界和占位符规则见 [鉴权说明](../authentication.md)。

- 完整地址：`https://m.ctrip.com/restapi/soa2/16037/startChatB2C`
- 请求方法：`POST`
- 范围：网页消息/身份/联系入口及共享读取契约
- 编码：JSON；HTTP Content-Type 见下表，不能由 body.contentType 推断
- Authentication：本轮浏览器 Cookie 会话；逐项 Cookie 必需性未证明，见鉴权说明
- 原始证据：[evidence/2026-10-30/08-controlled-start-chat.json](../evidence/2026-10-30/08-controlled-start-chat.json)、[evidence/2026-10-30/14-upload-full-payload.json](../evidence/2026-10-30/14-upload-full-payload.json)、[evidence/2026-10-30/21-transfer-conversation-open.json](../evidence/2026-10-30/21-transfer-conversation-open.json)、[evidence/2026-10-30/23-transfer-target-open.json](../evidence/2026-10-30/23-transfer-target-open.json)、[evidence/2026-10-30/27-return-to-controlled.json](../evidence/2026-10-30/27-return-to-controlled.json)、[evidence/2026-10-30/49-controlled-reopen-after-finish.json](../evidence/2026-10-30/49-controlled-reopen-after-finish.json)

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

### 样本 1：14-upload-full-payload / HTTP 200 / Ack Success

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
  "serviceType": "1513",
  "vendorRefId": "{{body.vendorRefId:string}}",
  "role": "{{body.role:string}}",
  "threadId": "{{body.threadId:string}}",
  "extParams": {
    "parentsid": "{{body.extParams.parentsid:string}}",
    "clientid": "{{body.extParams.clientid:string}}",
    "needsendusermessage": "{{body.extParams.needsendusermessage:string}}",
    "imreqmsgid": "{{body.extParams.imreqmsgid:string}}",
    "latitude": "{{body.extParams.latitude:string}}",
    "channel": "VAC",
    "ibuclientversion": "{{body.extParams.ibuclientversion:string}}",
    "title": "{{body.extParams.title:string}}",
    "pageid": "{{body.extParams.pageid:string}}",
    "locale": "zh_HK",
    "aitoken": "",
    "bu": "{{body.extParams.bu:string}}",
    "thirdpartytoken": "{{body.extParams.thirdpartytoken:string}}",
    "tag": "",
    "longitude": "{{body.extParams.longitude:string}}",
    "imassignscene": "{{body.extParams.imassignscene:string}}",
    "supplierid": "{{body.extParams.supplierid:string}}",
    "coordinate": "{{body.extParams.coordinate:string}}",
    "clientversion": "{{body.extParams.clientversion:string}}",
    "orderid": "{{body.extParams.orderid:string}}",
    "cityname": "{{body.extParams.cityname:string}}",
    "relationorderid": "{{body.extParams.relationorderid:string}}",
    "appversion": "{{body.extParams.appversion:string}}",
    "cityid": "{{body.extParams.cityid:string}}",
    "supplierpid": "",
    "vendorUid": "{{body.extParams.vendorUid:string}}",
    "token": "{{body.extParams.token:string}}",
    "imclientip": "{{body.extParams.imclientip:string}}",
    "vtoken": "{{body.extParams.vtoken:string}}",
    "ctype": "{{body.extParams.ctype:string}}",
    "pagefrom": "{{body.extParams.pagefrom:string}}",
    "cid": "{{body.extParams.cid:string}}"
  },
  "customerUid": "{{body.customerUid:string}}",
  "groupId": "{{body.groupId:string}}",
  "languageInfo": {
    "lang": "zh_HK",
    "customerSource": "",
    "terminalChannel": ""
  }
}
```

### 样本 2：21-transfer-conversation-open / HTTP 200 / Ack Success

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
  "serviceType": "1513",
  "vendorRefId": "{{body.vendorRefId:string}}",
  "role": "{{body.role:string}}",
  "threadId": "{{body.threadId:string}}",
  "extParams": {
    "parentsid": "{{body.extParams.parentsid:string}}",
    "orderactionurl": "{{body.extParams.orderactionurl:string}}",
    "clientid": "{{body.extParams.clientid:string}}",
    "needsendusermessage": "{{body.extParams.needsendusermessage:string}}",
    "imreqmsgid": "{{body.extParams.imreqmsgid:string}}",
    "latitude": "{{body.extParams.latitude:string}}",
    "channel": "VAC",
    "ibuclientversion": "{{body.extParams.ibuclientversion:string}}",
    "title": "{{body.extParams.title:string}}",
    "locale": "en_XX",
    "aitoken": "",
    "biz": "{{body.extParams.biz:string}}",
    "price": "{{body.extParams.price:string}}",
    "currency": "MYR",
    "tag": "",
    "longitude": "{{body.extParams.longitude:string}}",
    "imassignscene": "{{body.extParams.imassignscene:string}}",
    "amount": "{{body.extParams.amount:string}}",
    "supplierid": "",
    "coordinate": "{{body.extParams.coordinate:string}}",
    "clientversion": "{{body.extParams.clientversion:string}}",
    "orderid": "{{body.extParams.orderid:string}}",
    "cityname": "{{body.extParams.cityname:string}}",
    "relationorderid": "{{body.extParams.relationorderid:string}}",
    "appversion": "{{body.extParams.appversion:string}}",
    "cityid": "{{body.extParams.cityid:string}}",
    "supplierpid": "",
    "token": "{{body.extParams.token:string}}",
    "imclientip": "{{body.extParams.imclientip:string}}",
    "vtoken": "{{body.extParams.vtoken:string}}",
    "ctype": "{{body.extParams.ctype:string}}",
    "pagefrom": "{{body.extParams.pagefrom:string}}",
    "cid": "{{body.extParams.cid:string}}",
    "desc": "{{body.extParams.desc:string}}",
    "status": "Confirmed"
  },
  "customerUid": "{{body.customerUid:string}}",
  "groupId": "{{body.groupId:string}}",
  "languageInfo": {
    "lang": "en_XX",
    "customerSource": "",
    "terminalChannel": ""
  }
}
```

### 样本 3：23-transfer-target-open / HTTP 200 / Ack Success

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
  "serviceType": "1513",
  "vendorRefId": "{{body.vendorRefId:string}}",
  "role": "{{body.role:string}}",
  "threadId": "{{body.threadId:string}}",
  "extParams": {
    "parentsid": "{{body.extParams.parentsid:string}}",
    "clientid": "{{body.extParams.clientid:string}}",
    "imreqmsgid": "{{body.extParams.imreqmsgid:string}}",
    "latitude": "{{body.extParams.latitude:string}}",
    "channel": "VAC",
    "ibuclientversion": "{{body.extParams.ibuclientversion:string}}",
    "title": "{{body.extParams.title:string}}",
    "pageid": "{{body.extParams.pageid:string}}",
    "locale": "en_US",
    "aitoken": "",
    "biz": "{{body.extParams.biz:string}}",
    "bu": "{{body.extParams.bu:string}}",
    "thirdpartytoken": "{{body.extParams.thirdpartytoken:string}}",
    "tag": "",
    "longitude": "{{body.extParams.longitude:string}}",
    "imassignscene": "{{body.extParams.imassignscene:string}}",
    "supplierid": "{{body.extParams.supplierid:string}}",
    "coordinate": "{{body.extParams.coordinate:string}}",
    "clientversion": "{{body.extParams.clientversion:string}}",
    "orderid": "{{body.extParams.orderid:string}}",
    "cityname": "{{body.extParams.cityname:string}}",
    "relationorderid": "{{body.extParams.relationorderid:string}}",
    "appversion": "{{body.extParams.appversion:string}}",
    "cityid": "{{body.extParams.cityid:string}}",
    "supplierpid": "",
    "token": "{{body.extParams.token:string}}",
    "imclientip": "{{body.extParams.imclientip:string}}",
    "vtoken": "{{body.extParams.vtoken:string}}",
    "ctype": "{{body.extParams.ctype:string}}",
    "pagefrom": "{{body.extParams.pagefrom:string}}",
    "cid": "{{body.extParams.cid:string}}"
  },
  "customerUid": "{{body.customerUid:string}}",
  "groupId": "{{body.groupId:string}}",
  "languageInfo": {
    "lang": "en_US",
    "customerSource": "",
    "terminalChannel": ""
  }
}
```

### 样本 4：27-return-to-controlled / HTTP 200 / Ack Success

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
  "serviceType": "1513",
  "vendorRefId": "{{body.vendorRefId:string}}",
  "role": "{{body.role:string}}",
  "threadId": "{{body.threadId:string}}",
  "extParams": {
    "parentsid": "{{body.extParams.parentsid:string}}",
    "clientid": "{{body.extParams.clientid:string}}",
    "needsendusermessage": "{{body.extParams.needsendusermessage:string}}",
    "imreqmsgid": "{{body.extParams.imreqmsgid:string}}",
    "latitude": "{{body.extParams.latitude:string}}",
    "channel": "VAC",
    "ibuclientversion": "{{body.extParams.ibuclientversion:string}}",
    "title": "{{body.extParams.title:string}}",
    "pageid": "{{body.extParams.pageid:string}}",
    "locale": "zh_HK",
    "aitoken": "",
    "bu": "{{body.extParams.bu:string}}",
    "thirdpartytoken": "{{body.extParams.thirdpartytoken:string}}",
    "tag": "",
    "longitude": "{{body.extParams.longitude:string}}",
    "imassignscene": "{{body.extParams.imassignscene:string}}",
    "supplierid": "{{body.extParams.supplierid:string}}",
    "coordinate": "{{body.extParams.coordinate:string}}",
    "clientversion": "{{body.extParams.clientversion:string}}",
    "orderid": "{{body.extParams.orderid:string}}",
    "cityname": "{{body.extParams.cityname:string}}",
    "relationorderid": "{{body.extParams.relationorderid:string}}",
    "appversion": "{{body.extParams.appversion:string}}",
    "cityid": "{{body.extParams.cityid:string}}",
    "supplierpid": "",
    "vendorUid": "{{body.extParams.vendorUid:string}}",
    "token": "{{body.extParams.token:string}}",
    "imclientip": "{{body.extParams.imclientip:string}}",
    "vtoken": "{{body.extParams.vtoken:string}}",
    "ctype": "{{body.extParams.ctype:string}}",
    "pagefrom": "{{body.extParams.pagefrom:string}}",
    "cid": "{{body.extParams.cid:string}}"
  },
  "customerUid": "{{body.customerUid:string}}",
  "groupId": "{{body.groupId:string}}",
  "languageInfo": {
    "lang": "zh_HK",
    "customerSource": "",
    "terminalChannel": ""
  }
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
  "serviceType": "1513",
  "vendorRefId": "{{body.vendorRefId:string}}",
  "role": "VBK",
  "threadId": "{{body.threadId:string}}",
  "extParams": {
    "parentsid": "{{body.extParams.parentsid:string}}",
    "clientid": "{{body.extParams.clientid:string}}",
    "needsendusermessage": "{{body.extParams.needsendusermessage:string}}",
    "imreqmsgid": "{{body.extParams.imreqmsgid:string}}",
    "latitude": "{{body.extParams.latitude:string}}",
    "channel": "VAC",
    "ibuclientversion": "{{body.extParams.ibuclientversion:string}}",
    "title": "{{body.extParams.title:string}}",
    "pageid": "{{body.extParams.pageid:string}}",
    "locale": "zh_HK",
    "aitoken": "",
    "bu": "{{body.extParams.bu:string}}",
    "thirdpartytoken": "{{body.extParams.thirdpartytoken:string}}",
    "tag": "",
    "longitude": "{{body.extParams.longitude:string}}",
    "imassignscene": "{{body.extParams.imassignscene:string}}",
    "supplierid": "{{body.extParams.supplierid:string}}",
    "coordinate": "{{body.extParams.coordinate:string}}",
    "clientversion": "{{body.extParams.clientversion:string}}",
    "orderid": "{{body.extParams.orderid:string}}",
    "cityname": "{{body.extParams.cityname:string}}",
    "relationorderid": "{{body.extParams.relationorderid:string}}",
    "appversion": "{{body.extParams.appversion:string}}",
    "cityid": "{{body.extParams.cityid:string}}",
    "supplierpid": "",
    "vendorUid": "{{body.extParams.vendorUid:string}}",
    "token": "{{body.extParams.token:string}}",
    "imclientip": "{{body.extParams.imclientip:string}}",
    "vtoken": "{{body.extParams.vtoken:string}}",
    "ctype": "{{body.extParams.ctype:string}}",
    "pagefrom": "{{body.extParams.pagefrom:string}}",
    "cid": "{{body.extParams.cid:string}}"
  },
  "customerUid": "{{body.customerUid:string}}",
  "groupId": "{{body.groupId:string}}",
  "languageInfo": {
    "lang": "zh_HK",
    "customerSource": "",
    "terminalChannel": ""
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
| `serviceType` | `string` | 当前会话 conversation.serviceType，不全局硬编码 1513 |
| `vendorRefId` | `string` | 已授权会话/官方订单联系入口所给供应商引用 |
| `role` | `string` | 官方会话/订单联系入口的 vendorRole；只使用原入口授权的值 |
| `threadId` | `string` | 当前会话 threadId |
| `extParams` | `object` | 官方会话或联系入口返回的 ext；完整透传结构见样本，票据必须取当前值 |
| `extParams.parentsid` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.clientid` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.needsendusermessage` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.imreqmsgid` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.latitude` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.channel` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.ibuclientversion` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.title` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.pageid` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.locale` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.aitoken` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.bu` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.thirdpartytoken` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.tag` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.longitude` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.imassignscene` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.supplierid` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.coordinate` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.clientversion` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.orderid` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.cityname` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.relationorderid` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.appversion` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.cityid` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.supplierpid` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.vendorUid` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.token` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.imclientip` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.vtoken` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.ctype` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.pagefrom` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.cid` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `customerUid` | `string` | 已授权当前会话客户 uid；只凭 UID 不构成新建会话授权 |
| `groupId` | `string` | 当前会话 conversation.gid；保留本调用点的原始类型 |
| `languageInfo` | `object` | 当前会话语言上下文；完整子结构见本接口样本 |
| `languageInfo.lang` | `string` | 当前会话 languageInfo 同名字段 |
| `languageInfo.customerSource` | `string` | 当前会话 languageInfo 同名字段 |
| `languageInfo.terminalChannel` | `string` | 当前会话 languageInfo 同名字段 |
| `extParams.orderactionurl` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.biz` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.price` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.currency` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.amount` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.desc` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |
| `extParams.status` | `string` | 已授权当前会话 extParams 同名字段；动态票据不得复用旧值 |

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
  "groupId": "{{response.groupId:string}}",
  "sessionId": "{{response.sessionId:string}}",
  "workSheetId": "{{response.workSheetId:number}}",
  "conversationKey": "{{response.conversationKey:string}}",
  "taskKey": "{{response.taskKey:string}}",
  "customerUid": "{{response.customerUid:string}}"
}
```

写请求未知结果先读回，不自动重发。具体 UI 操作、目标和状态收敛见 [验证记录](../validation.md)。

## 未完成项

- 逐字段必填性、所有条件分支和失败范围尚未穷尽。
- 独立宿主 Origin/Profile/网络层尚未验证；页面内重放成功不能外推到原生 HTTP。
- 动态来源未闭环：见公共 head / 风控 / 身份来源的共同未完成项。
