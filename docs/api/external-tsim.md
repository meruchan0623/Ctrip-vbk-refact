# TSim 商家助手接口：当前源码契约

2026-10-30。这里是当前 companion 与 TSim_CS 拥有方源码的对照，不是浏览器抓包，不证明线上部署与本地源码一致。源文件 SHA-256、Git HEAD 和相关文件工作区状态见[来源指纹](evidence/2026-10-30/tsim-source-fingerprints.json)。本轮未登录 TSim、未提交翻译或套餐查询。

当前客户端在 [owned-service.ts](/Users/tashima_meru/Develop/trip_vendor_im_companion/host/owned-service.ts:9) 固定 API origin 为 `https://csapi.tsim.tech`；当前 vbk-electron 调查产物没有检索到相应集成调用，不能把 companion 的实现说成该产物已有能力。当前项目只按保留的商家助手范围引用以下契约。

## 公共 Header 与身份

| 字段 | 来源与规则 |
| --- | --- |
| `Accept: application/json` | 当前客户端通用请求层 |
| `Authorization: Bearer {{access_token}}` | TSim 登录/刷新返回的当前 token；登录请求不带此头，不使用携程 Cookie 替代 |
| `Content-Type: application/json` | 仅 JSON body；FormData 由运行时设置 multipart boundary，不手填 |
| Query | `URLSearchParams` 编码；`query_id`、`card_dataplan_id` 为字符串 |

客户端禁止重定向，响应体限 2 MiB；401/423 清除本地会话，403 不等同登出。JWT 到期前约五分钟刷新，无法读取 JWT 到期时间时采用客户端约三十分钟刷新周期。上述为客户端实现，不是服务端 token 有效期承诺。[请求与会话实现](/Users/tashima_meru/Develop/trip_vendor_im_companion/host/owned-service.ts:54)。

## 登录、身份、刷新与登出

| 方法、完整 URL | 编码与参数 | 响应及约束 |
| --- | --- | --- |
| POST `https://csapi.tsim.tech/agent/login` | 无 Bearer；multipart FormData：`username:string`、`password:string`，均必填 | `success:true,data:{access_token:string,token_type:"bearer",session_ref:string}`；密码只在登录 UI 输入，不保存到接口样本 |
| GET `https://csapi.tsim.tech/agent/profile` | Bearer；无 body、无 query | `APIResponse{success,message,data}`；当前客户端读取 `data.id,is_active,permissions:string[],outbound_wait`；其他 profile 字段不在本轮作完整类型承诺 |
| POST `https://csapi.tsim.tech/agent/auth/refresh` | Bearer；无 body | `success:true,data:{access_token,token_type,expires_at,session_ref}`；`expires_at` 为 ISO 字符串 |
| POST `https://csapi.tsim.tech/agent/logout` | Bearer；无 body | `success:true,message,data:null` |

服务端实际路由与返回见 [agent.py 登录](/Users/tashima_meru/Develop/TSim_CS/central-backend/api/routers/agent.py:1318)、[刷新](/Users/tashima_meru/Develop/TSim_CS/central-backend/api/routers/agent.py:1380)、[登出](/Users/tashima_meru/Develop/TSim_CS/central-backend/api/routers/agent.py:1425)、[profile](/Users/tashima_meru/Develop/TSim_CS/central-backend/api/routers/agent.py:9645)。携程登录按用户决定复用官方网页登录；这不代替独立的 TSim 身份。

## 出站翻译

`POST https://csapi.tsim.tech/agent/translate`，Bearer，JSON。当前 companion 实际发送以下六项，不另注入 `protocol`、`client_source`、`X-Client-Source` 或 HTTP 诊断字段：

```json
{
  "text": "{{用户当前待翻译文本:string}}",
  "target_lang": "en",
  "source_lang": "zh",
  "purpose": "outbound",
  "draft_request_id": "{{当前草稿请求ID:string}}",
  "composer_content_version": "{{当前编辑内容版本:string}}"
}
```

| 字段 | 拥有方请求类型 / 当前客户端约束 |
| --- | --- |
| `text` | 必填 `StrictStr`；客户端要求非空；翻译服务文本上限 20,000 字符 |
| `target_lang` | 服务端模型为必填 `str`；当前客户端允许 `zh,en,ja,ko,es,fr,de,ru,pt,it,ar,th,vi,id,ms,zh-TW,tr`，不要将客户端列表冒充服务端 Pydantic Literal |
| `source_lang` | 服务端默认 `"auto"`；当前出站客户端传 `"zh"` |
| `purpose` | 可选 `inbound / outbound / sent_message_review`；当前流程传 `outbound` |
| `draft_request_id` | 服务端可选 `StrictStr`；当前客户端总传，校验 1–100 位 `[-a-z0-9]` |
| `composer_content_version` | 服务端可选 `StrictStr`；当前客户端总传且限制不超过 25,000 字符；必须与当前编辑版本绑定 |
| `protocol` | 可选 `"agent-translation-items-v1" / null`；当前客户端省略，不能擅自切换响应协议 |
| `client_source` | 可选 `respondio_translate / travel_merchant_companion / external_plugin / null`；当前客户端省略，不能凭项目名编造已发送来源标记 |

拥有方模型 `TranslateRequest(BaseModel)` 使用 `extra:"forbid"`，未列字段会被拒绝。[完整模型](/Users/tashima_meru/Develop/TSim_CS/central-backend/api/routers/agent.py:952)、[客户端唯一 body 映射](/Users/tashima_meru/Develop/trip_vendor_im_companion/src/shared/translation-request.ts:7)、[服务文本上限](/Users/tashima_meru/Develop/TSim_CS/central-backend/services/translation_service.py:54)。

当前单文本成功分支为 `success:true,data.translated_text`，出站分支回显草稿 ID 和内容版本；客户端要求非空译文且不超过 50,000 字符，并核对回显后才能将结果用于对应草稿。接口成功不是客户消息已发送。[出站 endpoint](/Users/tashima_meru/Develop/TSim_CS/central-backend/api/routers/agent.py:3890)。当前 endpoint 的认证依赖是 `get_current_agent`，没有该路由直接声明的 `TRANSLATION_PERMISSION_REQUIRED` gate；不要沿用旧归档把任意 403 都解释为统一翻译权限错误。

## 套餐速览与查询

全部使用 Bearer。前两步取得查询与套餐标识，再读取套餐详情；不以订单号拼造套餐 ID。

| 顺序 | 方法、完整 URL | 参数与当前成功判据 |
| --- | --- | --- |
| 1 | POST `https://csapi.tsim.tech/agent/package-query/perform` | JSON `{ "order_nums": "{{订单标识:string}}" }`；当前客户端要求非空、trim、长度不超过 128 且没有 CR/LF/NUL；成功使用 raw envelope `code=1或2,result.query_id` |
| 2 | GET `https://csapi.tsim.tech/agent/package-query/dataplan-list` | Query `query_id:string` 必填；`code=1,result:array`，客户端最多接收 100 项 |
| 3 | GET `https://csapi.tsim.tech/agent/package-query/detail` | Query `card_dataplan_id:string` 必填；`code=1,result:object` |
| 4（补充） | GET `https://csapi.tsim.tech/agent/package-query/live-detail` | 同一 `card_dataplan_id:string`；当前客户端将非 `code=1` 的补充区块视为空，不等于基础套餐查询失败 |
| 5（补充） | GET `https://csapi.tsim.tech/agent/package-query/cdr-more` | 同一 `card_dataplan_id:string`；同样单独处理补充区块失败 |

这些 Query 参数在服务端声明为 `str = Query(...)`，没有整数契约。客户端仅接受原字符串或安全整数转换出的字符串，然后要求匹配 `^[-A-Za-z0-9_]{1,128}$`，再 URL 编码；不能将大整数先转 JavaScript Number 再转回字符串。[查询编排](/Users/tashima_meru/Develop/trip_vendor_im_companion/electron/order-summary-query.ts:185)、[服务端列表](/Users/tashima_meru/Develop/TSim_CS/central-backend/api/routers/agent_package_query.py:1159)、[详情](/Users/tashima_meru/Develop/TSim_CS/central-backend/api/routers/agent_package_query.py:1217)、[实时补充](/Users/tashima_meru/Develop/TSim_CS/central-backend/api/routers/agent_package_query.py:1248)、[CDR](/Users/tashima_meru/Develop/TSim_CS/central-backend/api/routers/agent_package_query.py:1447)。

服务端授权允许 `package_query` 或 `complaint_records`，超级管理员另有 bypass；销售账号还验证 scope 和套餐归属。当前 companion 的本地门禁更严格，要求 `complaint_records`，不能把客户端约束写成服务端唯一规则。[权限依赖](/Users/tashima_meru/Develop/TSim_CS/central-backend/auth/dependencies.py:260)。套餐接口的 raw `code/result` 与登录、翻译的 `success/data` 是不同 envelope，不使用同一个成功解析模板。

## 错误与未验证边界

| 情形 | 源码中的语义 |
| --- | --- |
| 缺少、无效或过期 Bearer | 401；仅适用于需要登录的路由 |
| 账号被停用等状态 | 423；登录还存在锁定/状态变化的 423、409 分支 |
| 套餐缺权限或销售 scope 越权 | 403；不自动解释为 token 过期 |
| 翻译输入/配置不符 | 422 / 413 等，按实际 detail 处理 |
| 翻译限流、保护、服务异常 | 429 / 503 / 500 等，不等同客户发送失败 |

以上静态签名已经核对，但线上认证、真实套餐归属、可选补充区块、协议切换及超时行为未动态验收。不使用真实凭据或客户正文补造成功样本。

## 2026-10-31 Windows 本地订单套餐入口（新增修复轮）

以下是本仓库新增的宿主IPC契约，TSim服务器的上述HTTP协议不变，线上验收状态以本轮运行记录为准。`context_revision`来自官方WebView适配器当前完整客户/服务会话边界的非秘密随机代次；不会将订单号当聊天室、套餐ID或ICCID。此实现仍依赖官方页面/SDK，不是脱离浏览器的携程协议客户端。

| IPC | 请求与返回 | 绑定与权限 |
| --- | --- | --- |
| `assistant_tsim_status` / login / logout | 状态增加 `session_epoch:number`；同名重登也变化 | 凭据留宿主；登录/退出存储错误不可假报成功；本地 `assistant://tsim-status` 仅传状态、用户名和epoch |
| `assistant_order_summary` | `{account,gid,order_id,context_revision,session_epoch}` → 回显上述边界及 `{query_handle,plans,total,fetched_at_ms}` | main角色；每次外部请求前后核对当前官方会话及TSim身份；固定 `/perform` → `/dataplan-list`，订单以10或16位字符串保真 |
| `assistant_package_detail_open` | `{account,gid,query_handle,detail_handle}` → 打开本地受限详情窗口 | 只接受宿主实际列表签发的两个随机句柄；前端不能传真实card ID、token或URL |
| `assistant_package_detail` | 无参数 → 当前窗口已绑定套餐、白名单详情/实时字段/CDR及读取时间 | 详情角色；窗口实例、完整会话及TSim代次仍有效才可读取，固定 `/detail`、`/live-detail`、`/cdr-more` |

自动摘要保留列表内全部套餐（最多100项，超出明确失败），不静默选第一条。列表缺用量时用量/百分比为未知；点击每份套餐再读取实际详情和补充块，不从套餐名称猜流量或把未知填为0。已有 `{iccid}` 速览保留作为没有关联订单时的后备。

缓存和句柄在宿主按完整scope及TSim代次隔离；普通消息、未读数和备注广播不等于更换客户身份。身份失效后旧结果和详情不可重新绑定到新账号。详情是本地只读投影，不复制旧助手的远端iframe/token handoff，不包含退款、订单修改或权限操作。全部时间、字段是否在线有效，需用户正常登录后的实际查询验证。

本地资源边界：查询结果复用60秒，句柄有效期5分钟，最多保留16组查询，同时最多8个详情窗口；CDR按接口源顺序最多展示前100条并在界面标明。详情的补充接口无可显示结果时明确显示“未返回可显示的数据/用量记录”，不据空投影推断套餐实际没有用量。

Windows只读来源核对：本机TSim `agent-frontend/src/types/package.ts` 的 `PackageInfo`、详情和CDR类型，以及 `central-backend/api/routers/agent_package_query.py` 的 perform/list/detail/live/CDR 路由。已安装助手实际使用远端 `csagent.tsim.tech/embed/operator` 的会话handoff，本地实现没有复用其令牌或嵌入协议；本机源字段与安装代码仅证明契约来源，不证明线上请求已经成功。

## 用户授权的已有浏览器会话导入

2026-10-31用户明确要求尝试从Edge/Chrome已登录的TSim会话复用登录态，更新此前仅手动密码登录的限制。设置专属 `assistant_tsim_import_session {access_token:string}` 返回常规非秘密 `TsimStatus`；它不是账号密码登录替代协议，也不能用携程Cookie认证TSim。

初次导入只向固定 `https://csapi.tsim.tech` 发送两个带Bearer的GET：`/agent/profile` 核对真实用户、active与当前客户端套餐权限，`/agent/auth/session-status` 要求 `data.state="active"` 并读取服务端真实 `session_ref`。后者即使 `success:true` 也可能expired/invalid/revoked/inactive，均不能报登录成功；JWT解码只用于到期调度，不作为认证，也不拿JWT sid伪造session_ref。密码、token、session_ref不放入状态DTO、偏好或日志；输入提交前清空，保存系统凭据库成功后才就绪。

本地TSim拥有方源码的refresh保留sid、epoch和session_ref，只更换jti；logout会撤销同一会话及关联业务会话。因此导入来源必须在宿主持久标为共享，贯穿刷新和重启恢复；本地退出或替换登录不能调用该共享会话的远端logout。浏览器或服务端撤销原会话仍会使复用失效，需重新验证。共享会话使用独立系统凭据槽，避免旧版回退将它误当成密码登录的自有会话。

这些是本机拥有方源码确认的契约与本地导入边界；线上部署一致性和实际导入结果以新包验收记录为准。真实认证材料不写入文档、样本或Git。
