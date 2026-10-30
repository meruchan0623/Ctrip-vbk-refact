# POST m.ctrip.com/restapi/soa2/16037/getVenAgentByUid

状态：真实网页请求样本；完整实施准入尚未通过。固定网页版本、鉴权边界和占位符规则见 [鉴权说明](../authentication.md)。

- 完整地址：`https://m.ctrip.com/restapi/soa2/16037/getVenAgentByUid`
- 请求方法：`POST`
- 范围：网页消息/身份/联系入口及共享读取契约
- 编码：JSON；HTTP Content-Type 见下表，不能由 body.contentType 推断
- Authentication：本轮浏览器 Cookie 会话；逐项 Cookie 必需性未证明，见鉴权说明
- 原始证据：[evidence/2026-10-30/01-bootstrap.json](../evidence/2026-10-30/01-bootstrap.json)、[evidence/2026-10-30/54-sdk-restored-by-official-page-reload.json](../evidence/2026-10-30/54-sdk-restored-by-official-page-reload.json)、[evidence/2026-10-30/63-personal-settings-read.json](../evidence/2026-10-30/63-personal-settings-read.json)

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
| `x-ctx-country` | `CN` | 对应业务请求层/SDK；以本接口实际值为准 |
| `x-ctx-currency` | `CNY` | 对应业务请求层/SDK；以本接口实际值为准 |
| `x-ctx-locale` | `zh-CN` | 对应业务请求层/SDK；以本接口实际值为准 |
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
  }
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
  }
}
```

### 样本 3：63-personal-settings-read / HTTP 200 / Ack Success

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
  "venAgent": {
    "id": "{{response.venAgent.id:number}}",
    "loginName": "{{response.venAgent.loginName:string}}",
    "agentRefId": "{{response.venAgent.agentRefId:string}}",
    "ctripUid": "{{response.venAgent.ctripUid:string}}",
    "nickname": "{{response.venAgent.nickname:string}}",
    "avatar": "{{response.venAgent.avatar:string}}",
    "skillGroups": [],
    "buId": "{{response.venAgent.buId:number}}",
    "serviceLimit": 1,
    "jobPosition": "{{response.venAgent.jobPosition:string}}",
    "imUserMessageShow": false,
    "imEnterSendMsg": false,
    "imAutoMatchKnowledgeBase": false,
    "c2BCloseTransferMasterAgentBizTypes": [
      "{{response.venAgent.c2BCloseTransferMasterAgentBizTypes[0]:string}}",
      "{{response.venAgent.c2BCloseTransferMasterAgentBizTypes[1]:string}}"
    ],
    "o2BNotAllowCloseBizTypes": [
      "{{response.venAgent.o2BNotAllowCloseBizTypes[0]:string}}",
      "{{response.venAgent.o2BNotAllowCloseBizTypes[1]:string}}",
      "{{response.venAgent.o2BNotAllowCloseBizTypes[2]:string}}",
      "{{response.venAgent.o2BNotAllowCloseBizTypes[3]:string}}",
      "{{response.venAgent.o2BNotAllowCloseBizTypes[4]:string}}"
    ],
    "disableSetting": false,
    "bizTypesAllowActiveWhenClose": [
      "{{response.venAgent.bizTypesAllowActiveWhenClose[0]:string}}",
      "{{response.venAgent.bizTypesAllowActiveWhenClose[1]:string}}",
      "{{response.venAgent.bizTypesAllowActiveWhenClose[2]:string}}",
      "{{response.venAgent.bizTypesAllowActiveWhenClose[3]:string}}",
      "{{response.venAgent.bizTypesAllowActiveWhenClose[4]:string}}",
      "{{response.venAgent.bizTypesAllowActiveWhenClose[5]:string}}",
      "{{response.venAgent.bizTypesAllowActiveWhenClose[6]:string}}",
      "{{response.venAgent.bizTypesAllowActiveWhenClose[7]:string}}",
      "{{response.venAgent.bizTypesAllowActiveWhenClose[8]:string}}",
      "{{response.venAgent.bizTypesAllowActiveWhenClose[9]:string}}",
      "{{response.venAgent.bizTypesAllowActiveWhenClose[10]:string}}",
      "{{response.venAgent.bizTypesAllowActiveWhenClose[11]:string}}",
      "{{response.venAgent.bizTypesAllowActiveWhenClose[12]:string}}",
      "{{response.venAgent.bizTypesAllowActiveWhenClose[13]:string}}",
      "{{response.venAgent.bizTypesAllowActiveWhenClose[14]:string}}",
      "{{response.venAgent.bizTypesAllowActiveWhenClose[15]:string}}",
      "{{response.venAgent.bizTypesAllowActiveWhenClose[16]:string}}",
      "{{response.venAgent.bizTypesAllowActiveWhenClose[17]:string}}",
      "{{response.venAgent.bizTypesAllowActiveWhenClose[18]:string}}"
    ],
    "url2CardDomains": [
      "{{response.venAgent.url2CardDomains[0]:string}}",
      "{{response.venAgent.url2CardDomains[1]:string}}",
      "{{response.venAgent.url2CardDomains[2]:string}}",
      "{{response.venAgent.url2CardDomains[3]:string}}",
      "{{response.venAgent.url2CardDomains[4]:string}}",
      "{{response.venAgent.url2CardDomains[5]:string}}",
      "{{response.venAgent.url2CardDomains[6]:string}}",
      "{{response.venAgent.url2CardDomains[7]:string}}",
      "{{response.venAgent.url2CardDomains[8]:string}}",
      "{{response.venAgent.url2CardDomains[9]:string}}",
      "{{response.venAgent.url2CardDomains[10]:string}}",
      "{{response.venAgent.url2CardDomains[11]:string}}",
      "{{response.venAgent.url2CardDomains[12]:string}}",
      "{{response.venAgent.url2CardDomains[13]:string}}",
      "{{response.venAgent.url2CardDomains[14]:string}}",
      "{{response.venAgent.url2CardDomains[15]:string}}",
      "{{response.venAgent.url2CardDomains[16]:string}}",
      "{{response.venAgent.url2CardDomains[17]:string}}",
      "{{response.venAgent.url2CardDomains[18]:string}}",
      "{{response.venAgent.url2CardDomains[19]:string}}",
      "{{response.venAgent.url2CardDomains[20]:string}}",
      "{{response.venAgent.url2CardDomains[21]:string}}",
      "{{response.venAgent.url2CardDomains[22]:string}}",
      "{{response.venAgent.url2CardDomains[23]:string}}",
      "{{response.venAgent.url2CardDomains[24]:string}}",
      "{{response.venAgent.url2CardDomains[25]:string}}",
      "{{response.venAgent.url2CardDomains[26]:string}}",
      "{{response.venAgent.url2CardDomains[27]:string}}",
      "{{response.venAgent.url2CardDomains[28]:string}}",
      "{{response.venAgent.url2CardDomains[29]:string}}",
      "{{response.venAgent.url2CardDomains[30]:string}}",
      "{{response.venAgent.url2CardDomains[31]:string}}",
      "{{response.venAgent.url2CardDomains[32]:string}}",
      "{{response.venAgent.url2CardDomains[33]:string}}",
      "{{response.venAgent.url2CardDomains[34]:string}}",
      "{{response.venAgent.url2CardDomains[35]:string}}"
    ],
    "showSingleChatTab": true,
    "showSystemNoticeTab": true,
    "disableCommentBizTypes": [
      "{{response.venAgent.disableCommentBizTypes[0]:string}}",
      "{{response.venAgent.disableCommentBizTypes[1]:string}}",
      "{{response.venAgent.disableCommentBizTypes[2]:string}}",
      "{{response.venAgent.disableCommentBizTypes[3]:string}}",
      "{{response.venAgent.disableCommentBizTypes[4]:string}}",
      "{{response.venAgent.disableCommentBizTypes[5]:string}}"
    ],
    "systemNoticeBizTypes": [
      "{{response.venAgent.systemNoticeBizTypes[0]:string}}"
    ],
    "mailBizTypes": [
      "{{response.venAgent.mailBizTypes[0]:string}}"
    ],
    "disable": 0,
    "locale": "",
    "localeName": "",
    "email": "",
    "receiveLimit": 0
  },
  "venAgentOption": {
    "serviceTypeOptionList": [
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[0].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[0].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "relative_questions_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[20].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[21].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[21].descriptions:string}}"
          },
          {
            "optionCode": "agent_closeable_chat",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[22].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[0].venOptionList[22].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[1].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[1].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[1].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[2].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[2].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[2].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[3].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[3].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[3].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[4].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[4].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[4].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[5].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[5].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[5].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[6].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[6].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "report_harassment",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[20].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[21].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[6].venOptionList[21].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[7].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[7].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[7].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[8].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[8].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[8].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[9].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[9].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[9].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[10].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[10].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[20].descriptions:string}}"
          },
          {
            "optionCode": "agent_closeable_chat",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[21].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[10].venOptionList[21].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[11].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[11].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[11].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[12].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[12].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[20].descriptions:string}}"
          },
          {
            "optionCode": "agent_closeable_chat",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[21].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[12].venOptionList[21].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[13].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[13].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "relative_questions_size",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[6].optionValue:string}}",
            "descriptions": ""
          },
          {
            "optionCode": "relative_questions_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[7].optionValue:string}}",
            "descriptions": ""
          },
          {
            "optionCode": "report_harassment",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[20].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[21].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[21].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[22].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[22].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[23].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[23].descriptions:string}}"
          },
          {
            "optionCode": "agent_closeable_chat",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[24].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[13].venOptionList[24].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[14].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[14].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[14].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[15].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[15].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[15].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[16].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[16].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[16].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[17].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[17].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[20].descriptions:string}}"
          },
          {
            "optionCode": "agent_closeable_chat",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[21].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[17].venOptionList[21].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[18].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[18].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[18].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[19].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[19].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[19].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[20].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[20].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "report_harassment",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[20].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[21].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[21].descriptions:string}}"
          },
          {
            "optionCode": "questionnaire",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[22].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[20].venOptionList[22].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[21].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[21].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "report_harassment",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[20].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[21].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[21].descriptions:string}}"
          },
          {
            "optionCode": "agent_closeable_chat",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[22].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[21].venOptionList[22].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[22].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[22].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[22].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[23].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[23].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[23].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[24].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[24].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[24].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[25].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[25].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[25].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[26].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[26].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[26].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[27].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[27].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[27].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[28].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[28].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[28].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[29].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[29].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[29].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[30].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[30].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[30].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[31].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[31].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[2].optionValue:string}}",
            "descriptions": ""
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[3].optionValue:string}}",
            "descriptions": ""
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "report_harassment",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[20].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[21].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[31].venOptionList[21].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[32].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[32].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[20].descriptions:string}}"
          },
          {
            "optionCode": "agent_closeable_chat",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[21].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[32].venOptionList[21].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[33].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[33].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[33].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[34].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[34].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[34].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[35].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[35].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[35].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[36].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[36].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[36].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[37].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[37].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[37].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[38].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[38].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[38].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[39].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[39].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[39].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[40].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[40].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[40].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[41].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[41].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[41].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[42].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[42].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[42].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[43].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[43].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[43].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[44].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[44].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[44].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[45].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[45].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[45].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[46].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[46].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[46].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[47].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[47].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[47].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[48].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[48].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[48].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[49].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[49].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "report_harassment",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[20].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[21].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[49].venOptionList[21].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[50].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[50].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "grouptitle_modifiable",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "groupWelcome_modifiable",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "xing_qiu_hao",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[20].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[21].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[21].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[22].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[22].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[23].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[50].venOptionList[23].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[51].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[51].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[51].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[52].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[52].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[52].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[53].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[53].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[20].descriptions:string}}"
          },
          {
            "optionCode": "agent_closeable_chat",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[21].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[53].venOptionList[21].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[54].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[54].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[54].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[55].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[55].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "report_harassment",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[20].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[21].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[21].descriptions:string}}"
          },
          {
            "optionCode": "allow_b2mc_biztypes_config",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[22].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[55].venOptionList[22].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[56].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[56].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[56].venOptionList[20].descriptions:string}}"
          }
        ]
      },
      {
        "ownerType": "{{response.venAgentOption.serviceTypeOptionList[57].ownerType:string}}",
        "ownerCode": "{{response.venAgentOption.serviceTypeOptionList[57].ownerCode:string}}",
        "venOptionList": [
          {
            "optionCode": "allow_view_before_enter_group",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[0].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[0].descriptions:string}}"
          },
          {
            "optionCode": "contractor_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[1].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[1].descriptions:string}}"
          },
          {
            "optionCode": "display_msg_read_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[2].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[2].descriptions:string}}"
          },
          {
            "optionCode": "ebk_customer_allowed_to_invite",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[3].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[3].descriptions:string}}"
          },
          {
            "optionCode": "ebk_non_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[4].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[4].descriptions:string}}"
          },
          {
            "optionCode": "ebk_send_video_check",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[5].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[5].descriptions:string}}"
          },
          {
            "optionCode": "ebk_work_personnel_status",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[6].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[6].descriptions:string}}"
          },
          {
            "optionCode": "input_association",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[7].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[7].descriptions:string}}"
          },
          {
            "optionCode": "prompt_message_content",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[8].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[8].descriptions:string}}"
          },
          {
            "optionCode": "report_harassment",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[9].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[9].descriptions:string}}"
          },
          {
            "optionCode": "send_voice_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[10].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[10].descriptions:string}}"
          },
          {
            "optionCode": "server_msglist_sessionshow",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[11].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[11].descriptions:string}}"
          },
          {
            "optionCode": "show_insurance_recommendation",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[12].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[12].descriptions:string}}"
          },
          {
            "optionCode": "show_invite_page",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[13].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[13].descriptions:string}}"
          },
          {
            "optionCode": "show_prompt_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[14].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[14].descriptions:string}}"
          },
          {
            "optionCode": "support_quick_reply",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[15].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[15].descriptions:string}}"
          },
          {
            "optionCode": "support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[16].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[16].descriptions:string}}"
          },
          {
            "optionCode": "support_youyou",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[17].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[17].descriptions:string}}"
          },
          {
            "optionCode": "translate_message",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[18].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[18].descriptions:string}}"
          },
          {
            "optionCode": "over_support_score",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[19].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[19].descriptions:string}}"
          },
          {
            "optionCode": "show_driver_order",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[20].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[20].descriptions:string}}"
          },
          {
            "optionCode": "dynamic_group_name_switch",
            "optionValue": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[21].optionValue:string}}",
            "descriptions": "{{response.venAgentOption.serviceTypeOptionList[57].venOptionList[21].descriptions:string}}"
          }
        ]
      }
    ],
    "agentOption": {
      "ownerType": "{{response.venAgentOption.agentOption.ownerType:string}}",
      "ownerCode": "{{response.venAgentOption.agentOption.ownerCode:string}}",
      "venOptionList": [
        {
          "optionCode": "emojiFlag",
          "optionValue": "{{response.venAgentOption.agentOption.venOptionList[0].optionValue:string}}"
        },
        {
          "optionCode": "automatic_translation",
          "optionValue": "{{response.venAgentOption.agentOption.venOptionList[1].optionValue:string}}",
          "descriptions": "{{response.venAgentOption.agentOption.venOptionList[1].descriptions:string}}"
        },
        {
          "optionCode": "update_agent_avatar",
          "optionValue": "{{response.venAgentOption.agentOption.venOptionList[2].optionValue:string}}",
          "descriptions": ""
        },
        {
          "optionCode": "update_agent_nickname",
          "optionValue": "{{response.venAgentOption.agentOption.venOptionList[3].optionValue:string}}",
          "descriptions": ""
        },
        {
          "optionCode": "update_work_time",
          "optionValue": "{{response.venAgentOption.agentOption.venOptionList[4].optionValue:string}}",
          "descriptions": ""
        },
        {
          "optionCode": "view_work_time",
          "optionValue": "{{response.venAgentOption.agentOption.venOptionList[5].optionValue:string}}",
          "descriptions": ""
        },
        {
          "optionCode": "send_silence_email_notice",
          "optionValue": "{{response.venAgentOption.agentOption.venOptionList[6].optionValue:string}}"
        },
        {
          "optionCode": "send_silence_email_notice_entry",
          "optionValue": "{{response.venAgentOption.agentOption.venOptionList[7].optionValue:string}}"
        },
        {
          "optionCode": "update_auto_reply",
          "optionValue": "{{response.venAgentOption.agentOption.venOptionList[8].optionValue:string}}"
        },
        {
          "optionCode": "im_consultant",
          "optionValue": "{{response.venAgentOption.agentOption.venOptionList[9].optionValue:string}}"
        },
        {
          "optionCode": "xing_qiu_hao",
          "optionValue": "{{response.venAgentOption.agentOption.venOptionList[10].optionValue:string}}"
        }
      ]
    },
    "vendorOptionList": []
  },
  "hasTodoList": false,
  "abTestResult": "{{response.abTestResult:string}}"
}
```

写请求未知结果先读回，不自动重发。具体 UI 操作、目标和状态收敛见 [验证记录](../validation.md)。

## 未完成项

- 逐字段必填性、所有条件分支和失败范围尚未穷尽。
- 独立宿主 Origin/Profile/网络层尚未验证；页面内重放成功不能外推到原生 HTTP。
- 动态来源未闭环：见公共 head / 风控 / 身份来源的共同未完成项。
