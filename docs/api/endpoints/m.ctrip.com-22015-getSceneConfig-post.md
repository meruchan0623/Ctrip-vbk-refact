# POST m.ctrip.com/restapi/soa2/22015/getSceneConfig

状态：真实网页请求样本；完整实施准入尚未通过。固定网页版本、鉴权边界和占位符规则见 [鉴权说明](../authentication.md)。

- 完整地址：`https://m.ctrip.com/restapi/soa2/22015/getSceneConfig`
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
{}
```

`_fxpcqlniredt`、`x-traceID` 如出现，由平台公共请求层处理；nonce、时间戳和上传 rand 不可复制为常量。

## 完整请求样本与分支

`{{字段路径:类型}}` 是脱敏占位符，不能作为字面量发出。数字占位符的原始类型以参数表为准。数组不截断；JSON 字符串仍保留字符串编码。

### 样本 1：60-controlled-order-detail / HTTP 200 / Ack Success

```json
{
  "head": {
    "cid": "",
    "cver": "",
    "extension": [
      {
        "name": "platform",
        "value": "{{body.head.extension[0].value:string}}"
      },
      {
        "name": "vid",
        "value": "{{body.head.extension[1].value:string}}"
      },
      {
        "name": "ipollOnlineSdkVer",
        "value": "{{body.head.extension[2].value:string}}"
      },
      {
        "name": "amp-account-source",
        "value": "vbk"
      },
      {
        "name": "amp-product-type",
        "value": "ipoll"
      }
    ],
    "appid": ""
  },
  "platform": 2,
  "locale": "zh-CN",
  "pageId": "{{body.pageId:string}}"
}
```

### 样本 2：60-controlled-order-detail / HTTP 200 / Ack 本链路无该字段或未获取

```json
{
  "head": {
    "cid": "",
    "cver": "",
    "extension": [
      {
        "name": "platform",
        "value": "{{body.head.extension[0].value:string}}"
      },
      {
        "name": "vid",
        "value": "{{body.head.extension[1].value:string}}"
      },
      {
        "name": "ipollOnlineSdkVer",
        "value": "{{body.head.extension[2].value:string}}"
      },
      {
        "name": "amp-account-source",
        "value": "vbk"
      },
      {
        "name": "amp-product-type",
        "value": "ipoll"
      }
    ],
    "appid": ""
  },
  "platform": 2,
  "locale": "zh-CN",
  "pageId": "{{body.pageId:string}}"
}
```

## 参数类型与来源

| 位置 | 实测类型 | 来源与限制 |
| --- | --- | --- |
| `(body)` | `object` | 本轮实际观测值；必填性、默认值及完整取值范围未由单次样本证明 |
| `head` | `object` | 该接口所属请求层生成；见 authentication.md 两类 head |
| `head.cid` | `string` | 公共请求层补入的客户端标识；具体合并来源尚需逐调用点核实 |
| `head.cver` | `string` | 对应请求层的公共 head；见 authentication.md，不与 HTTP Header 合并 |
| `head.extension` | `array` | 对应请求层的公共 head；见 authentication.md，不与 HTTP Header 合并 |
| `head.extension[]` | `object` | 对应请求层的公共 head；见 authentication.md，不与 HTTP Header 合并 |
| `head.extension[].name` | `string` | 对应 head 配置的准确名称，protocol 与 protocal 不同 |
| `head.extension[].value` | `string` | 对应协议扩展的实际常量或运行时上下文，见完整示例与鉴权文档 |
| `head.appid` | `string` | 对应请求层的公共 head；见 authentication.md，不与 HTTP Header 合并 |
| `platform` | `number` | 本轮实际观测值；必填性、默认值及完整取值范围未由单次样本证明 |
| `locale` | `string` | 当前页面/账号语言；不要替换成客户语言 |
| `pageId` | `string` | 待追溯：当前仅保留位置与类型，来源未闭环，阻塞自行构造请求 |

“观测到”不等于“必填”。本轮未进行完整删字段/边界矩阵，不编造 required、默认值、枚举或省略行为。

## 响应与读回

完整响应结构和脱敏实例在以上证据的 responseSchema / responseTemplate；上传另有 xhr.response。HTTP 200、Ack Success 和最终业务状态分别判断。

```json
{
  "header": {
    "errorCode": "Success",
    "message": "{{response.header.message:string}}"
  },
  "ResponseStatus": {
    "Timestamp": "{{response.ResponseStatus.Timestamp:string}}",
    "Ack": "Success",
    "Errors": [],
    "Extension": [
      {
        "Id": "{{response.ResponseStatus.Extension[0].Id:string}}",
        "Version": "{{response.ResponseStatus.Extension[0].Version:string}}"
      },
      {
        "Id": "{{response.ResponseStatus.Extension[1].Id:string}}",
        "Value": "{{response.ResponseStatus.Extension[1].Value:string}}"
      },
      {
        "Id": "{{response.ResponseStatus.Extension[2].Id:string}}",
        "Value": "{{response.ResponseStatus.Extension[2].Value:string}}"
      }
    ]
  },
  "sceneInfoList": []
}
```

写请求未知结果先读回，不自动重发。具体 UI 操作、目标和状态收敛见 [验证记录](../validation.md)。

## 未完成项

- 逐字段必填性、所有条件分支和失败范围尚未穷尽。
- 独立宿主 Origin/Profile/网络层尚未验证；页面内重放成功不能外推到原生 HTTP。
- 动态来源未闭环：`pageId`
