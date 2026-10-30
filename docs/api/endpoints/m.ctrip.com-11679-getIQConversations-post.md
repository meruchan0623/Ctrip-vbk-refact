# POST m.ctrip.com/restapi/soa2/11679/getIQConversations

状态：真实网页请求样本；完整实施准入尚未通过。固定网页版本、鉴权边界和占位符规则见 [鉴权说明](../authentication.md)。

- 完整地址：`https://m.ctrip.com/restapi/soa2/11679/getIQConversations`
- 请求方法：`POST`
- 范围：网页消息/身份/联系入口及共享读取契约
- 编码：JSON；HTTP Content-Type 见下表，不能由 body.contentType 推断
- Authentication：本轮浏览器 Cookie 会话；逐项 Cookie 必需性未证明，见鉴权说明
- 原始证据：[evidence/2026-10-30/01-bootstrap.json](../evidence/2026-10-30/01-bootstrap.json)、[evidence/2026-10-30/54-sdk-restored-by-official-page-reload.json](../evidence/2026-10-30/54-sdk-restored-by-official-page-reload.json)、[evidence/2026-10-30/58-order-list-page-initialization.json](../evidence/2026-10-30/58-order-list-page-initialization.json)、[evidence/2026-10-30/60-controlled-order-detail.json](../evidence/2026-10-30/60-controlled-order-detail.json)

## HTTP 请求 Header

| Header | 本轮值/占位符 | 生成方 |
| --- | --- | --- |
| `:authority` | `{{header.:authority:string}}` | HTTP/2 传输层伪头；不写入应用 fetch headers |
| `:method` | `{{header.:method:string}}` | HTTP/2 传输层伪头；不写入应用 fetch headers |
| `:path` | `{{header.:path:string}}` | HTTP/2 传输层伪头；不写入应用 fetch headers |
| `:scheme` | `{{header.:scheme:string}}` | HTTP/2 传输层伪头；不写入应用 fetch headers |
| `accept` | `application/json, text/plain, */*` | 对应业务请求层/SDK；以本接口实际值为准 |
| `accept-encoding` | `{{header.accept-encoding:string}}` | 浏览器/网络栈；复用当前 Profile，不手工设置受限头 |
| `accept-language` | `{{header.accept-language:string}}` | 浏览器/网络栈；复用当前 Profile，不手工设置受限头 |
| `content-length` | `{{header.content-length:string}}` | 浏览器/网络栈；复用当前 Profile，不手工设置受限头 |
| `content-type` | `application/json;charset=UTF-8` | 对应业务请求层/SDK；以本接口实际值为准 |
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

以上为观察到的请求头，包含 CDP ExtraInfo。出现不代表逐项必需；浏览器自动字段、风控字段和应用字段分开处理。

## Query 参数

```json
{}
```

`_fxpcqlniredt`、`x-traceID` 如出现，由平台公共请求层处理；nonce、时间戳和上传 rand 不可复制为常量。

## 完整请求样本与分支

`{{字段路径:类型}}` 是脱敏占位符，不能作为字面量发出。数字占位符的原始类型以参数表为准。数组不截断；JSON 字符串仍保留字符串编码。

### 样本 1：60-controlled-order-detail / HTTP 200 / Ack Success

```json
{
  "lastMsgTime": "{{body.lastMsgTime:number}}",
  "head": {
    "cver": "2",
    "appId": "1001",
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
| `lastMsgTime` | `number` | 通知增量游标，来自上一响应 |
| `head` | `object` | 该接口所属请求层生成；见 authentication.md 两类 head |
| `head.cver` | `string` | 对应请求层的公共 head；见 authentication.md，不与 HTTP Header 合并 |
| `head.appId` | `string` | 对应请求层的公共 head；见 authentication.md，不与 HTTP Header 合并 |
| `head.extension` | `array` | 对应请求层的公共 head；见 authentication.md，不与 HTTP Header 合并 |
| `head.extension[]` | `object` | 对应请求层的公共 head；见 authentication.md，不与 HTTP Header 合并 |
| `head.extension[].name` | `string` | 对应 head 配置的准确名称，protocol 与 protocal 不同 |
| `head.extension[].value` | `string` | 对应协议扩展的实际常量或运行时上下文，见完整示例与鉴权文档 |

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
  "latestMsgTime": "{{response.latestMsgTime:number}}",
  "haveRest": false,
  "categoryList": [
    {
      "categoryId": 1,
      "categoryName": "{{response.categoryList[0].categoryName:string}}",
      "categoryIcon": "{{response.categoryList[0].categoryIcon:string}}",
      "categoryNameShark": "{{response.categoryList[0].categoryNameShark:string}}",
      "unreadCount": 0,
      "categorySubList": [
        {
          "categoryId": 125,
          "categoryName": "{{response.categoryList[0].categorySubList[0].categoryName:string}}",
          "categoryIcon": "{{response.categoryList[0].categorySubList[0].categoryIcon:string}}",
          "categoryNameShark": "{{response.categoryList[0].categorySubList[0].categoryNameShark:string}}",
          "unreadCount": 0,
          "unreadTimeline": "{{response.categoryList[0].categorySubList[0].unreadTimeline:number}}",
          "categorySubList": [],
          "lastMsg": "{\"ext\":{\"nickName\":\"\",\"toCardHide\":\"\",\"avatar\":\"\",\"templateId\":\"{{response.categoryList[0].categorySubList[0].lastMsg.$json.ext.templateId:string}}\",\"type\":\"\",\"title\":\"{{response.categoryList[0].categorySubList[0].lastMsg.$json.ext.title:string}}\",\"extendInfo\":{\"toJumpUrlOnline\":\"{{response.categoryList[0].categorySubList[0].lastMsg.$json.ext.extendInfo.toJumpUrlOnline:string}}\",\"toJumpUrl\":\"{{response.categoryList[0].categorySubList[0].lastMsg.$json.ext.extendInfo.toJumpUrl:string}}\",\"fromJumpUrlOnline\":\"{{response.categoryList[0].categorySubList[0].lastMsg.$json.ext.extendInfo.fromJumpUrlOnline:string}}\"},\"fromCardHide\":\"{{response.categoryList[0].categorySubList[0].lastMsg.$json.ext.fromCardHide:string}}\",\"categorySubId\":\"{{response.categoryList[0].categorySubList[0].lastMsg.$json.ext.categorySubId:string}}\",\"playSound\":\"\",\"isPlay\":\"\",\"soundUrl\":\"{{response.categoryList[0].categorySubList[0].lastMsg.$json.ext.soundUrl:string}}\",\"categoryId\":\"{{response.categoryList[0].categorySubList[0].lastMsg.$json.ext.categoryId:string}}\",\"desc\":\"{{response.categoryList[0].categorySubList[0].lastMsg.$json.ext.desc:string}}\"},\"action\":\"CTL01\",\"title\":\"\",\"operation\":\"\"}",
          "lastMsgTime": "{{response.categoryList[0].categorySubList[0].lastMsgTime:number}}",
          "msgType": 7,
          "lastMsgId": "{{response.categoryList[0].categorySubList[0].lastMsgId:string}}"
        },
        {
          "categoryId": 101,
          "categoryName": "{{response.categoryList[0].categorySubList[1].categoryName:string}}",
          "categoryIcon": "{{response.categoryList[0].categorySubList[1].categoryIcon:string}}",
          "categoryNameShark": "{{response.categoryList[0].categorySubList[1].categoryNameShark:string}}",
          "unreadCount": 0
        },
        {
          "categoryId": 103,
          "categoryName": "{{response.categoryList[0].categorySubList[2].categoryName:string}}",
          "categoryIcon": "{{response.categoryList[0].categorySubList[2].categoryIcon:string}}",
          "categoryNameShark": "{{response.categoryList[0].categorySubList[2].categoryNameShark:string}}",
          "unreadCount": 0
        },
        {
          "categoryId": 107,
          "categoryName": "{{response.categoryList[0].categorySubList[3].categoryName:string}}",
          "categoryIcon": "{{response.categoryList[0].categorySubList[3].categoryIcon:string}}",
          "categoryNameShark": "{{response.categoryList[0].categorySubList[3].categoryNameShark:string}}",
          "unreadCount": 0
        },
        {
          "categoryId": 120,
          "categoryName": "{{response.categoryList[0].categorySubList[4].categoryName:string}}",
          "categoryNameShark": "{{response.categoryList[0].categorySubList[4].categoryNameShark:string}}",
          "unreadCount": 0
        }
      ],
      "lastMsgTime": "{{response.categoryList[0].lastMsgTime:number}}"
    },
    {
      "categoryId": 3,
      "categoryName": "{{response.categoryList[1].categoryName:string}}",
      "categoryIcon": "{{response.categoryList[1].categoryIcon:string}}",
      "categoryNameShark": "{{response.categoryList[1].categoryNameShark:string}}",
      "unreadCount": 1029,
      "categorySubList": [
        {
          "categoryId": 112,
          "categoryName": "{{response.categoryList[1].categorySubList[0].categoryName:string}}",
          "categoryIcon": "{{response.categoryList[1].categorySubList[0].categoryIcon:string}}",
          "categoryNameShark": "{{response.categoryList[1].categorySubList[0].categoryNameShark:string}}",
          "unreadCount": 1029,
          "unreadTimeline": "{{response.categoryList[1].categorySubList[0].unreadTimeline:number}}",
          "categorySubList": [],
          "lastMsg": "{\"ext\":{\"nickName\":\"\",\"toCardHide\":\"\",\"avatar\":\"\",\"templateId\":\"{{response.categoryList[1].categorySubList[0].lastMsg.$json.ext.templateId:string}}\",\"type\":\"\",\"title\":\"{{response.categoryList[1].categorySubList[0].lastMsg.$json.ext.title:string}}\",\"extendInfo\":{\"toJumpUrlOnline\":\"{{response.categoryList[1].categorySubList[0].lastMsg.$json.ext.extendInfo.toJumpUrlOnline:string}}\",\"toJumpUrl\":\"{{response.categoryList[1].categorySubList[0].lastMsg.$json.ext.extendInfo.toJumpUrl:string}}\",\"fromJumpUrlOnline\":\"{{response.categoryList[1].categorySubList[0].lastMsg.$json.ext.extendInfo.fromJumpUrlOnline:string}}\"},\"fromCardHide\":\"{{response.categoryList[1].categorySubList[0].lastMsg.$json.ext.fromCardHide:string}}\",\"categorySubId\":\"{{response.categoryList[1].categorySubList[0].lastMsg.$json.ext.categorySubId:string}}\",\"playSound\":\"\",\"isPlay\":\"\",\"soundUrl\":\"{{response.categoryList[1].categorySubList[0].lastMsg.$json.ext.soundUrl:string}}\",\"categoryId\":\"{{response.categoryList[1].categorySubList[0].lastMsg.$json.ext.categoryId:string}}\",\"desc\":\"{{response.categoryList[1].categorySubList[0].lastMsg.$json.ext.desc:string}}\"},\"action\":\"CTL01\",\"title\":\"\",\"operation\":\"\"}",
          "lastMsgTime": "{{response.categoryList[1].categorySubList[0].lastMsgTime:number}}",
          "msgType": 7,
          "lastMsgId": "{{response.categoryList[1].categorySubList[0].lastMsgId:string}}"
        },
        {
          "categoryId": 102,
          "categoryName": "{{response.categoryList[1].categorySubList[1].categoryName:string}}",
          "categoryIcon": "{{response.categoryList[1].categorySubList[1].categoryIcon:string}}",
          "categoryNameShark": "{{response.categoryList[1].categorySubList[1].categoryNameShark:string}}",
          "unreadCount": 0
        },
        {
          "categoryId": 109,
          "categoryName": "{{response.categoryList[1].categorySubList[2].categoryName:string}}",
          "categoryIcon": "{{response.categoryList[1].categorySubList[2].categoryIcon:string}}",
          "categoryNameShark": "{{response.categoryList[1].categorySubList[2].categoryNameShark:string}}",
          "unreadCount": 0
        },
        {
          "categoryId": 110,
          "categoryName": "{{response.categoryList[1].categorySubList[3].categoryName:string}}",
          "categoryIcon": "{{response.categoryList[1].categorySubList[3].categoryIcon:string}}",
          "categoryNameShark": "{{response.categoryList[1].categorySubList[3].categoryNameShark:string}}",
          "unreadCount": 0
        },
        {
          "categoryId": 111,
          "categoryName": "{{response.categoryList[1].categorySubList[4].categoryName:string}}",
          "categoryIcon": "{{response.categoryList[1].categorySubList[4].categoryIcon:string}}",
          "categoryNameShark": "{{response.categoryList[1].categorySubList[4].categoryNameShark:string}}",
          "unreadCount": 0
        }
      ],
      "lastMsgTime": "{{response.categoryList[1].lastMsgTime:number}}"
    },
    {
      "categoryId": 2,
      "categoryName": "{{response.categoryList[2].categoryName:string}}",
      "categoryIcon": "{{response.categoryList[2].categoryIcon:string}}",
      "categoryNameShark": "{{response.categoryList[2].categoryNameShark:string}}",
      "unreadCount": 0,
      "categorySubList": [
        {
          "categoryId": 104,
          "categoryName": "{{response.categoryList[2].categorySubList[0].categoryName:string}}",
          "categoryIcon": "{{response.categoryList[2].categorySubList[0].categoryIcon:string}}",
          "categoryNameShark": "{{response.categoryList[2].categorySubList[0].categoryNameShark:string}}",
          "unreadCount": 0
        },
        {
          "categoryId": 108,
          "categoryName": "{{response.categoryList[2].categorySubList[1].categoryName:string}}",
          "categoryIcon": "{{response.categoryList[2].categorySubList[1].categoryIcon:string}}",
          "categoryNameShark": "{{response.categoryList[2].categorySubList[1].categoryNameShark:string}}",
          "unreadCount": 0
        },
        {
          "categoryId": 124,
          "categoryName": "{{response.categoryList[2].categorySubList[2].categoryName:string}}",
          "categoryIcon": "{{response.categoryList[2].categorySubList[2].categoryIcon:string}}",
          "categoryNameShark": "{{response.categoryList[2].categorySubList[2].categoryNameShark:string}}",
          "unreadCount": 0
        }
      ]
    },
    {
      "categoryId": 8,
      "categoryName": "{{response.categoryList[3].categoryName:string}}",
      "categoryIcon": "{{response.categoryList[3].categoryIcon:string}}",
      "categoryNameShark": "{{response.categoryList[3].categoryNameShark:string}}",
      "unreadCount": 0,
      "categorySubList": [
        {
          "categoryId": 118,
          "categoryName": "{{response.categoryList[3].categorySubList[0].categoryName:string}}",
          "categoryNameShark": "{{response.categoryList[3].categorySubList[0].categoryNameShark:string}}",
          "unreadCount": 0
        },
        {
          "categoryId": 119,
          "categoryName": "{{response.categoryList[3].categorySubList[1].categoryName:string}}",
          "categoryNameShark": "{{response.categoryList[3].categorySubList[1].categoryNameShark:string}}",
          "unreadCount": 0
        },
        {
          "categoryId": 121,
          "categoryName": "{{response.categoryList[3].categorySubList[2].categoryName:string}}",
          "categoryNameShark": "{{response.categoryList[3].categorySubList[2].categoryNameShark:string}}",
          "unreadCount": 0
        },
        {
          "categoryId": 122,
          "categoryName": "{{response.categoryList[3].categorySubList[3].categoryName:string}}",
          "categoryNameShark": "{{response.categoryList[3].categorySubList[3].categoryNameShark:string}}",
          "unreadCount": 0
        },
        {
          "categoryId": 123,
          "categoryName": "{{response.categoryList[3].categorySubList[4].categoryName:string}}",
          "categoryNameShark": "{{response.categoryList[3].categorySubList[4].categoryNameShark:string}}",
          "unreadCount": 0
        }
      ]
    },
    {
      "categoryId": 4,
      "categoryName": "{{response.categoryList[4].categoryName:string}}",
      "categoryIcon": "{{response.categoryList[4].categoryIcon:string}}",
      "categoryNameShark": "{{response.categoryList[4].categoryNameShark:string}}",
      "unreadCount": 0,
      "categorySubList": [
        {
          "categoryId": 106,
          "categoryName": "{{response.categoryList[4].categorySubList[0].categoryName:string}}",
          "categoryIcon": "{{response.categoryList[4].categorySubList[0].categoryIcon:string}}",
          "categoryNameShark": "{{response.categoryList[4].categorySubList[0].categoryNameShark:string}}",
          "unreadCount": 0
        },
        {
          "categoryId": 114,
          "categoryName": "{{response.categoryList[4].categorySubList[1].categoryName:string}}",
          "categoryIcon": "{{response.categoryList[4].categorySubList[1].categoryIcon:string}}",
          "categoryNameShark": "{{response.categoryList[4].categorySubList[1].categoryNameShark:string}}",
          "unreadCount": 0
        }
      ]
    },
    {
      "categoryId": 5,
      "categoryName": "{{response.categoryList[5].categoryName:string}}",
      "categoryIcon": "{{response.categoryList[5].categoryIcon:string}}",
      "categoryNameShark": "{{response.categoryList[5].categoryNameShark:string}}",
      "unreadCount": 345,
      "categorySubList": [
        {
          "categoryId": 105,
          "categoryName": "{{response.categoryList[5].categorySubList[0].categoryName:string}}",
          "categoryIcon": "{{response.categoryList[5].categorySubList[0].categoryIcon:string}}",
          "categoryNameShark": "{{response.categoryList[5].categorySubList[0].categoryNameShark:string}}",
          "unreadCount": 330,
          "unreadTimeline": "{{response.categoryList[5].categorySubList[0].unreadTimeline:number}}",
          "categorySubList": [],
          "lastMsg": "{\"ext\":{\"nickName\":\"\",\"toCardHide\":\"\",\"avatar\":\"\",\"templateId\":\"{{response.categoryList[5].categorySubList[0].lastMsg.$json.ext.templateId:string}}\",\"type\":\"\",\"title\":\"{{response.categoryList[5].categorySubList[0].lastMsg.$json.ext.title:string}}\",\"extendInfo\":{\"toJumpUrlOnline\":\"{{response.categoryList[5].categorySubList[0].lastMsg.$json.ext.extendInfo.toJumpUrlOnline:string}}\",\"toJumpUrl\":\"{{response.categoryList[5].categorySubList[0].lastMsg.$json.ext.extendInfo.toJumpUrl:string}}\",\"fromJumpUrlOnline\":\"{{response.categoryList[5].categorySubList[0].lastMsg.$json.ext.extendInfo.fromJumpUrlOnline:string}}\"},\"fromCardHide\":\"{{response.categoryList[5].categorySubList[0].lastMsg.$json.ext.fromCardHide:string}}\",\"categorySubId\":\"{{response.categoryList[5].categorySubList[0].lastMsg.$json.ext.categorySubId:string}}\",\"playSound\":\"\",\"isPlay\":\"\",\"soundUrl\":\"{{response.categoryList[5].categorySubList[0].lastMsg.$json.ext.soundUrl:string}}\",\"categoryId\":\"{{response.categoryList[5].categorySubList[0].lastMsg.$json.ext.categoryId:string}}\",\"desc\":\"{{response.categoryList[5].categorySubList[0].lastMsg.$json.ext.desc:string}}\"},\"action\":\"CTL01\",\"title\":\"\",\"operation\":\"\"}",
          "lastMsgTime": "{{response.categoryList[5].categorySubList[0].lastMsgTime:number}}",
          "msgType": 7,
          "lastMsgId": "{{response.categoryList[5].categorySubList[0].lastMsgId:string}}"
        },
        {
          "categoryId": 113,
          "categoryName": "{{response.categoryList[5].categorySubList[1].categoryName:string}}",
          "categoryIcon": "{{response.categoryList[5].categorySubList[1].categoryIcon:string}}",
          "categoryNameShark": "{{response.categoryList[5].categorySubList[1].categoryNameShark:string}}",
          "unreadCount": 15,
          "unreadTimeline": "{{response.categoryList[5].categorySubList[1].unreadTimeline:number}}",
          "categorySubList": [],
          "lastMsg": "{\"ext\":{\"nickName\":\"\",\"toCardHide\":\"\",\"avatar\":\"\",\"templateId\":\"{{response.categoryList[5].categorySubList[1].lastMsg.$json.ext.templateId:string}}\",\"type\":\"\",\"title\":\"{{response.categoryList[5].categorySubList[1].lastMsg.$json.ext.title:string}}\",\"extendInfo\":{\"toJumpUrlOnline\":\"\",\"toJumpUrl\":\"{{response.categoryList[5].categorySubList[1].lastMsg.$json.ext.extendInfo.toJumpUrl:string}}\",\"fromJumpUrlOnline\":\"\"},\"fromCardHide\":\"{{response.categoryList[5].categorySubList[1].lastMsg.$json.ext.fromCardHide:string}}\",\"categorySubId\":\"{{response.categoryList[5].categorySubList[1].lastMsg.$json.ext.categorySubId:string}}\",\"playSound\":\"\",\"isPlay\":\"\",\"soundUrl\":\"{{response.categoryList[5].categorySubList[1].lastMsg.$json.ext.soundUrl:string}}\",\"categoryId\":\"{{response.categoryList[5].categorySubList[1].lastMsg.$json.ext.categoryId:string}}\",\"desc\":\"{{response.categoryList[5].categorySubList[1].lastMsg.$json.ext.desc:string}}\"},\"action\":\"CTL01\",\"title\":\"\",\"operation\":\"\"}",
          "lastMsgTime": "{{response.categoryList[5].categorySubList[1].lastMsgTime:number}}",
          "msgType": 7,
          "lastMsgId": "{{response.categoryList[5].categorySubList[1].lastMsgId:string}}"
        },
        {
          "categoryId": 117,
          "categoryName": "{{response.categoryList[5].categorySubList[2].categoryName:string}}",
          "categoryNameShark": "{{response.categoryList[5].categorySubList[2].categoryNameShark:string}}",
          "unreadCount": 0
        }
      ],
      "lastMsgTime": "{{response.categoryList[5].lastMsgTime:number}}"
    }
  ]
}
```

写请求未知结果先读回，不自动重发。具体 UI 操作、目标和状态收敛见 [验证记录](../validation.md)。

## 未完成项

- 逐字段必填性、所有条件分支和失败范围尚未穷尽。
- 独立宿主 Origin/Profile/网络层尚未验证；页面内重放成功不能外推到原生 HTTP。
- 动态来源未闭环：见公共 head / 风控 / 身份来源的共同未完成项。
