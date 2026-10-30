# 接口鉴权与请求上下文：观测契约

本文件记录 2026-10-30 当前网页版本 `1793340371237`、业务包 `296-1776b2655d6f3342.js` 和 SDK 资源的源码与脱敏实测。旧版 `179256…` 仅作历史参考。这里的字段是对应请求的观测值，不等于所有接口的必填清单；各接口的方法、完整请求体和响应仍需结合各自证据核实，尚不能据此宣布全项目开发就绪。占位符均须来自当前会话或请求，不是可直接发送的字面值。

## 登录范围：复用官方网页

按用户本轮明确决定，携程登录直接打开 [官方登录页](https://vbooking.ctrip.com/ivbk/accountV2/login)，在对应账号隔离的浏览器 Profile 中完成；验证码、密码验证、风险校验和内部登录请求均由官方页面处理。本项目不重写 `pwdLogin`、验证码或 `authToken` 协议，也不读取用户密码，不因缺少这些内部接口抓包而要求另备测试账号。登录后的身份读取、Cookie/Profile 隔离、失效回到官方登录页仍属于接入边界，需要分别验证。

## 三种不同的“头”

- HTTP Header 是请求协议层字段，例如 `Content-Type`、`Cookie`、`Authorization`、`x-tour-auth-from`；按具体接口构造。
- JSON `body.head` 是 SOA 请求体内的对象，包含客户端上下文和 `extension`，不是 HTTP Header，也不能代替 Cookie。
- `body.contentType` 若出现在某个业务请求中，是该 JSON 的业务字段；它不设置 HTTP `Content-Type`，字段值和含义必须按对应接口确认。上传文件的 HTTP `Content-Type` 是文件 MIME 类型。

### 网页业务 head（一次中文 PC 会话观测）

```json
{
  "cid": "{{当前上下文cid}}", "ctok": "", "cver": "2", "lang": "01",
  "sid": "{{当前上下文sid}}", "syscode": "09", "auth": "", "xsid": "",
  "extension": [
    {"name":"cpc","value":"pc"},
    {"name":"protocal","value":"https"},
    {"name":"amp-product-type","value":"IM"},
    {"name":"amp-account-source","value":"VBK"},
    {"name":"client-source","value":"pc-900004"},
    {"name":"locale","value":"zh-CN"}
  ],
  "appId": "900004"
}
```

拼写 `protocal` 是实际观测值。业务包模块 69106 的 `$.cq` 只构造部分 head；公共请求库随后合并 `cid/ctok/lang/sid/syscode/auth/xsid` 等上下文。不要把 `$.cq` 的输出当成最终请求，也不要仅因为源码其他位置读取 GUID 就断定此处 `cid` 一定来自 GUID。本轮页面内 `getMessageList.head.cid` 与可读 Cookie `GUID`、`vbk_login_cid` 同时相等，`sid` 为 `8888`，`auth`、`ctok`、`xsid` 为空；这仅是动态相等性观察，不能确定唯一取值路径或其他会话同值。动态来源仍需追全；locale 等也是该次观测。

### IM SDK head（一次启动请求观测）

```json
{
  "cver":"1.0.7",
  "extension":[
    {"name":"protocol","value":"https:"},
    {"name":"cpc","value":"pc"},
    {"name":"appid","value":"100067816"},
    {"name":"language","value":"zh-CN"},
    {"name":"amp-product-type","value":"IM"},
    {"name":"amp-account-source","value":"vbk"},
    {"name":"client-source","value":""}
  ]
}
```

SDK 使用 `protocol`、带冒号的 `https:`、小写 `vbk`，与网页业务 head 不同；不要混用。启动抓包中 `getRecentMessages` 和 `GetMyInfo.json` 使用该形态。其他服务例如 `18088/getAppConfig.json` 有独立 head，不能一律套用上述模板。[启动证据](evidence/2026-10-30/01-bootstrap.json)。

## SOA：Cookie、请求头和业务结果

以 `POST https://m.ctrip.com/restapi/soa2/13500/checkMemberStatus` 为例，该会话的请求体为业务 head 加 `groupId`，HTTP `Content-Type: application/json`；观测到 `cookieOrigin: https://vbooking.ctrip.com`、`x-tour-auth-from: vbk_online`、`x-ctx-Locale: zh-CN`、`x-ctx-Currency: CNY`、`x-ctx-Country: CN`，以及请求上下文、追踪和浏览器生成的头。公共请求库从 `getClientId` 或默认客户端 ID 提供器得到 `t`；当 `t` 非空时追加 `_fxpcqlniredt=t` 和 `x-traceID=t + "-" + 当前毫秒时间戳 + "-" + floor(1e7 * Math.random())`。客户端 ID 的全部取值路径及这两个参数的服务端必要性仍未闭环。请求模板及完整脱敏头见 [成员请求证据](evidence/2026-10-30/12-auth-readonly-replay.json)。其他网页业务请求包括会话列表、邀请和移除的实际头分别见 [17](evidence/2026-10-30/17-full-list-exact-replay.json)、[25](evidence/2026-10-30/25-invite-jim-for-transfer.json)、[26](evidence/2026-10-30/26-transfer-master-to-jim.json)、[29](evidence/2026-10-30/29-controlled-invite-jim.json)、[30](evidence/2026-10-30/30-controlled-remove-jim.json)。

在当前已登录页面内，对相同成员查询进行只读重放：`credentials: include` 返回 HTTP 200 且 `ResponseStatus.Ack: Success`；`credentials: omit` 同样返回 HTTP 200，但 `Ack: Failure`、成员为空，原始诊断为 `AccountsMobileRequestFilterException`。因此必须检查业务 Ack、Errors 和各接口业务状态，不能把 HTTP 200 当成功。[脱敏结果](evidence/2026-10-30/12-auth-readonly-results.json) 对诊断字段做了脱敏；失败分类来自当次诊断观察。

后续已按同一控制条件补采保留完整错误枚举的[鉴权失败样本](evidence/2026-10-30/43-auth-failure-code-preserved.json)；最初对照保留其历史脱敏状态，不倒填为原始抓包。

浏览器实际附带过 `bticket`、`vbkticket` 等 Cookie；逐个 Cookie 的必要性没有隔离验证。所观察 SOA 请求未见 HTTP `Authorization`，不能推广为所有接口不使用 Authorization。Cookie 由浏览器依域、路径及安全策略选择；浏览器页面里的成功重放不证明 Rust 原生客户端或独立 WebView 能直接复用登录态、跨域或风控上下文。

`Origin`、`Cookie`、`Sec-*` 等受浏览器控制，不应依赖页面 `fetch` 强行设置；实际请求中可见的 Cookie 与其他头应结合 CDP `Network.requestWillBeSentExtraInfo`，不能把拦截前 `requestWillBeSent` 或 JS `setRequestHeader` 记录当作线上最终头。证据采集器合并这两类信息并标记 `extraInfoObserved`：[capture-support.mjs](../../tools/contracts/capture-support.mjs)。公共请求库在满足配置和请求条件时，生成 `x-ctx-wclient-req`：对 `path+query;method;trace;GUID;UBT_VID;DUID;_RF1` 做 MD5，缺失 Cookie 值用空字符串；传入摘要函数的 `n` 正是上述 `x-traceID` 的生成值，method 使用请求对象中的实际值。`w-payload-source` 的一条生成路径是对请求 body 做 MD5 后交给 `window.c_sign.toString`，触发受配置和 URL 条件控制；`c_sign` 实现及风控依赖仍未完全追清。两者及 trace 为动态上下文，不能硬编码，也不能当作已证实的鉴权凭证；鉴权、风控或业务失败应先诊断，勿盲目重试。[源码锚点与哈希](evidence/2026-10-30/source-anchors.json)。

## 图片上传：独立授权

1. 网页先以 `POST /restapi/soa2/16037/uploadTokenCreate` 获取上传 token，观测参数 `channel: im_business`、`type: img`；此请求使用网页业务上下文。token 动态获取，不保存真实值。
2. `POST https://nephele.ctrip.com/image/v2/api/upload?channel=im_business&scene={{动态scene}}&rand={{动态rand}}`。请求体是原始 `File` 字节，不是 multipart；观测图片的 `Content-Type: image/png`，`Accept: application/json, text/plain, */*`。
3. 源码构造 `Authorization: Nephele {{random32}}/{{yyyyMMddHHmm}}/{{channel}}/{{btoa('token:' + token)}}`。源码 `randomString` 默认 32 位，从 `ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678` 用 `Math.random` 逐位选取；`getFormatDate` 使用浏览器本地时间的年月日时分。token 的过期与重用规则仍需核实。`Content-MD5` 是文件内容 MD5 的十六进制字符串：实测与文件 hex 相等，与 Base64 不相等。[值来源验证](evidence/2026-10-30/14-upload-value-sources.json)。
4. 本次 HTTP 200 响应含 `Code: 2000` 和 `Content.url`、`Content.file_name`；必须同时判断业务结果。[完整上传证据](evidence/2026-10-30/14-upload-full-payload.json)。

后续[完整值来源验证](evidence/2026-10-30/44-image-auth-value-proof.json)已确认实际 scheme 为 Nephele、随机串 32 位且字符集匹配、时间字段 12 位、channel 为 im_business；授权串最后一段 Base64 解码后精确等于 `token:` 加本次 uploadTokenCreate 返回值，MD5 hex 与对应 fixture 一致。因此它既不等于原始 token，也不是 Bearer token。有效期与复用规则仍未验证。

## 普通文件上传：另一条链路

[文件上传证据](evidence/2026-10-30/33-controlled-file-full-contract.json) 中，`POST https://nephele.ctrip.com/file/v1/api/upload?channel=im&public=1` 的请求体是原始 PDF `File`，`Content-Type: application/pdf`；同次 CDP 实际头未见 Cookie、Authorization 或 Content-MD5，不能套用图片上传签名。HTTP 200 的 XHR `loadend` 记录响应 `{file_name, url}`。CDP 响应体已被清除，响应结构由同次 XHR 观察补充；这是单次 PDF 样本，不能据此推断所有文件的鉴权、安全策略或 `public=1` 的普遍含义。

## 视频上传与处理

[本轮视频样本](evidence/2026-10-30/68-controlled-video-upload.json)先调用 uploadTokenCreate，业务值为 `channel:"im",type:"video"`；之后 `POST https://nephele.ctrip.com/video/v3/api/upload?channel=im&rand={{动态值}}`。实际 body 为原始 MP4 File，HTTP `Content-Type: video/mp4`，带 Authorization、Content-MD5；不能直接沿用图片的 channel、token 或 endpoint。

同次 XHR 响应为 `Code:2000,Content:{file_name,preview_url,size,video:{duration,codec,height,width,bitrate,fps,start_time}}`。随后实际 `POST /video/v1/api/proc?video={{当前视频标识}}`，JSON body 是 `{"extract":{"interval":20,"end_second":3}}`，返回 image/video/audio 区块。完整 Query、Header、响应与 WS 消息见该证据。这里只验证了小视频直接上传，不把它冒充大文件/分片上传契约。

## 尚待核实

- 各接口的动态 head、query、风控字段来源、有效期及必需性；不同身份、环境和语言的差异。
- 各 Cookie 的独立必要性、失效处理，以及原生或独立 WebView 的实际登录态和跨域能力。
- 图片 token 生命周期；普通文件其他类型与失败响应。
- 各业务接口完整参数、权限和错误语义；抓包 schema 仅说明观测形态，不证明必填性。不得把单次成功当作全接口验收。
