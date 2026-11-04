# 官方桌面通知中心查询逻辑（2026-11-03）

范围：只读静态分析本机官方 Mac 1.2.13 的 JS，不启动官方程序、不读取账号凭据、不请求远端、不更新已读。没有浏览器操作。结论是客户端调用逻辑，不是服务端实测契约。源版本定位依据 `docs/reverse/2026-11-01-rea/00-README.md`。

## 可复核源

下列 `@数字` 均为 Python 解码 UTF-8 后字符串的 **0 起始字符偏移**，不是字节偏移。minify 文件不能依赖行号，可用 `s.find(needle)` 或 `s[offset:offset+length]` 核查。

目录：`/Applications/旅游商家桌面版.app/Contents/Resources/app.asar.unpacked/dist/js/`

| 简称 | 文件 | SHA-256 |
| --- | --- | --- |
| N | `noticeWindow-D7ZYbLt3.js` | `887c63db411cdf1c3db85f7441324fe35d8a1ae7585b67763ff78c3eec6bfbbe` |
| B | `BaseController-B_9ex1XX.js` | `517db0fb51fc9dbb1f34a4176a8b5f436f8fe37e9180a6a7d1ce66800288756c` |
| P | `parseTranslateResponse-u6ZbR6b9.js` | `12592870947ee9964338a6db35baa559123d0e4289e62d329af32fd318e2d79e` |

另有 `/Applications/旅游商家桌面版.app/Contents/Resources/app.asar` 内 `dist-electron/main/index.js`（下称 M），内容 SHA-256 `2aaef0bc5c53b3d4cf37df6d80015010782a2ac7c9b52b487f86ef4ec1e4466b`。直接解析 ASAR header 查 offset/size 后只读载入，没有执行包内代码。

## 接口与 head

生产基础 URL 为 `https://m.ctrip.com/restapi/soa2`（P @4770 一带 `m={FAT:...,UAT:...,PROD:...}` 与 `function D`）。B @130880～131310 的 API 表定义以下路径。

| 操作 | POST 路径 | 官方请求体（除框架默认 head） | 响应读取 |
| --- | --- | --- | --- |
| 分类/未读概览 | `/11679/getIQConversations` | `{head:getHead("1001"),lastMsgTime:0}` | `categoryList[]`，各父分类的 `categorySubList[]` |
| 分类消息/历史 | `/11679/getIQMessages` | `{categoryId,categorySubId,lastMsgTime,pageSize:100}` | `iqMessages[]` |
| 已读（本次未调用） | `/11679/putAdviceofreadIQMessage` | `{categoryId,categorySubId,msgId}` | `checkResponse` 成功后清子分类未读 |

分类调用：N @33033 `async getNoticeList()`。先按 `buid` 读取本地分类缓存并展示，再联网用 `lastMsgTime:0` 查询，完成后写回。

`getHead("1001")` 经 B @226977 与 P @6023 附近 `function U(e,n,r)` 展开：

```js
{
  cver: "2", appId: "1001",
  extension: [
    {name:"cpc", value:"pc"},
    {name:"protocal", value:"https"},
    {name:"amp-product-type", value:"IM"},
    {name:"amp-account-source", value:"VBK"},
    {name:"client-source", value: hashQuery["client-source"] || "pc-1001"},
    {name:"locale", value: locale || "zh-CN"}
  ]
}
```

消息列表与已读调用没有显式 head。B @222453 `async post` 以 `{head:this.getVBKHead(),...r}` 组 body，所以它们使用 P 的 `function P(e)`：

```js
{cid:GUID,ctok:"",cver:"1.0",lang:"01",sid:"8888",syscode:"09",auth:"",extension:[]}
```

因此不能把分类的 1001 head 或 IM 的 900004 head 直接推给所有通知请求。默认 JSON headers：`Content-Type:application/json`、`x-ctx-locale:<locale>`、`x-tour-auth-from:vbk_online`；`credentials:"include"`。分类和消息列表显式 `{browser:true}`，走当前 BrowserView 的 `window.fetch`（B @219405），不是全账号 cookie 桥接。

## 分类、消息与未读结构

N @10627 的分类 UI 读取 `categoryId,categoryName,lastMsg,lastMsgId,lastMsgTime,unreadCount,optStatus,soundUrl`；父分类还读 `categoryIcon,categorySubList`。子分类自身的 `categoryId` 在消息请求里变成 `categorySubId`，父分类 `categoryId` 保持不变。

B @209022 `IQConversationInfo` 本地 schema 进一步包含：`buid,parentId,categoryId,categoryName,categoryIcon,categoryNameShark,unreadCount,unreadTimeline,lastMsg,lastMsgTime,msgType,lastMsgId,localNextTime,optStatus,soundUrl`。这是客户端存储/消费结构，不代表服务端必须返回所有字段。

B @209610 `IQMessageContent`：`categoryId,categorySubId,buid,msgId,messageBody,msgType,bizType,messageCode,createTime,status`。N @22900 一带 `wt` reducer 解析每条 `messageBody` JSON，合并 `{...row,...parsedBody}`；失败时尝试把原始换行、换页、回车、tab 转义后重试。按 `msgId` 去重并按 `createTime` 升序展示。内容主要消费 `ext.title`、`ext.desc`、`ext.extendInfo.toJumpUrlOnline`；不可把整个 `messageBody` 当纯文本。

实时消息是另一种 envelope：N @1493 一带 `te` 把 `messageId→msgId`、`messageType→msgType`，数字化 `createTime,bizType`，支持 ext JSON 字符串、对象或 `extPropertys`，缺少 messageBody 时合成 `JSON.stringify({ext})`。N @28210 的 `onReceiveNewNotice` 接收 `newNotice`，`messageType==1021/1022` 清分类未读，其余更新消息和未读。不要将此 envelope 与历史 row 混为固定同一结构。

时间：代码直接把 createTime 数值化，并与 `Date.now()` 做差（N @34631）；因此客户端按 **毫秒** 使用，不做秒乘 1000。没有活体响应，不能据此排除异常服务端数据。

`optStatus` 常量 B @125092：`follow:"0",ignore:"1",alert:"2"`。N @35200 一带 `checkUnreadCnt` 对所有子分类求和时排除 `ignore`，再向主窗口发 `{type:"notice",buid,count}`。N @13161 同样按子分类求父 badge，父 `ignore` 显示 0；ignore 分类仍展示。N @21750 的初始化默认将子分类 110 设 alert，其余 follow，服务端/本地旧设置优先。通知开关、特别关注、声音偏好不应混入历史查询的必要参数。

## 历史分页与已读边界

N @35571～37100：

1. `changeCategory(parent,sub)` 重置当前分类/消息，开始查询；**首次 `lastMsgTime` 默认 0**，并不使用分类概览的 lastMsgTime。
2. 请求固定 `pageSize:100`，先读本地同 `buid/categoryId/categorySubId` 缓存，再发 `getIQMessages`。
3. N @22900 的 reducer 合并消息后以当前完整列表最旧 `createTime` 更新当前分类 `lastMsgTime`。
4. 再次加载历史沿用该时间游标；网络返回 `iqMessages.length<100` 即 `noMore:true`（N @36648）。没有 pageNo/pageIndex。
5. 本地查询按游标限制 createTime、按时间降序 limit(100)；本地水位 `localNextTime` 用于缓存覆盖判断（N @26800、@35900）。没有证据支持把分类 lastMsgTime 当初始历史游标。

N @37117 `putAdvice` 用当前已加载消息列表最后一条（升序列表的最新一条）的 `msgId`。UI 在消息更新且可见、重新可见、滚动方向等条件触发（N @7931～8690）。**它不是每行独立“已读”模型**。成功才清该子分类全部未读并更新汇总。仅静态记录，不进行远端写入。

## 账号/租户边界

M @253376 `createBrowserView(e,t)`：`session.fromPartition("persist:"+t)`，notice 与 imPlus 用 preload/im.js。每个 buid 的 notice BrowserView 使用该分区 cookie，消息 HTTP 请求体没有顶层 buid、tenantId、providerId。M @227551 的登录成功流程把登录票据写入对应分区（本次只看键名/代码，未读取任何票据值）。

本地分类缓存：B @214404 `Dd.read` 在每层用 `parentId` 与 `buid` 过滤，写入以 `(categoryId,buid)` 冲突键；本地历史：N @26800 同时过滤 `categoryId/categorySubId/buid`。但 B 的消息表仅 `msgId` 全局 unique，N 的通知去重也仅按 msgId，不能据此主张官方本地存储完全免跨账号碰撞。

未发现通知三接口的显式租户字段。可支持的结论是“官方按 buid 对应 session cookie 隔离”，不能推断任意附加 tenant 参数可切租户，也不能从静态逻辑证明服务端隔离已经正确。

## 本项目现状偏差（读取时快照）

- `vbk/ui/packages/web-adapter/src/notice.ts` 的分类请求使用 `businessHead(900004)`，官方分类明确为 1001；list/read 同样复用 businessHead，官方则是默认 platform head（sid 固定 8888，非项目 context.sid）。这些差异是否导致业务失败仍需真实只读响应验证。
- `vbk/ui/packages/web-adapter/src/rpc.ts` `noticeList` 将 `state.categories.get(id)?.lastMsgTime` 作为首次列表游标，而官方首次是 0，随后用已加载列表最旧时间；项目当前没有通知历史游标/hasMore 输出。可能漏最新条目且无法继续查更早历史。
- 项目 `iqMessageToNotice` 支持常见 ext 内容，但 `fetchNoticeList` 固定传 `unreadTimeline:null`，而正常历史 row 未必带 isread/isRead；因此有未读分类也可能得到全 false 的逐行 unread，UI 点击可能不触发 read。应按真实分类 unreadTimeline 或明确分类级已读模型处理，不能猜每条 false。
- 项目返回扁平子分类，未保留父分组、optStatus；官方保留分组且汇总排除 ignore。若产品只做简化分组，也需明确计数口径。
- 本项目通过 AccountContext 传递身份与 runtime 状态，不应照搬官方仅 msgId 全局唯一的缓存/去重规则。建议状态至少按完整账号/环境/会话 generation 和分类隔离。

建议先修正只读查询 head 与起始游标，以脱敏只读实际响应确认 categories/iqMessages；再加入按分类隔离的历史游标、去重及 hasMore，读状态单独验收。静态证据足以确定调用方式，不能把未采集的 getIQMessages 远端响应标为实测通过。

## 本轮实现与验证

2026-11-03 已接入本项目通知适配器及通知中心：分类专属 head、首页游标 0、100 条历史分页、真实 messageBody/ext 映射、分类 unreadTimeline 派生行状态、查询失败/加载/空态分离、刷新重试。通知查询独立于聊天加载；账号与分类切换采用请求代次保护。分类级已读仍由用户明确操作触发，不因进入通知页自动写回。已读失败不会清状态或打开迟到的旧通知页面。

- 真实只读证据：[notification-query-live-20261103.json](evidence/notification-query-live-20261103.json)。当前浏览器登录态返回 6 个父分类、23 个子分类；首批和下一批各 100 行，下一批与首批无重叠且均早于游标。浏览器账号未核对为截图中的 Bob；未执行真实已读写入。
- `npm run typecheck`、`npm run bundle:ui` 通过；`npm test` 最终 1067/1067 通过，日志 `/tmp/vbk-notice-regression-20261103.log`。
- `cargo check --manifest-path src-tauri/Cargo.toml` 通过。`cargo test --manifest-path src-tauri/Cargo.toml --lib` 为 224/225；失败为工作区并行修改的 `chrome_cookie_store::mac::tests::native_conversion_keeps_expiry_same_site_and_non_http_only`（`!native.isHTTPOnly()`），未在本任务中修改该模块。
- ego-browser 本地真实 UI 操作（mock IPC）验证通知分类与正文展示，注入分类查询失败后显示错误与重试，恢复后重新加载成功。不能把该 UI 检查当作 Tauri 真实登录链路验收。
- 独立 Sol/xhigh 评审提出的 5 项均已修复：去重后的页长度误判、外部打开 ABA、分类已读/行状态同步、分页全局排序、adapter 分类缓存乱序覆盖；复核定向测试 74/74。
- 时间分页沿用官方 createTime 游标；同时间戳超过一页的完整性未证明，游标不推进时停止。官方 optStatus 的特别关注/忽略设置未在本轮新增。代码与 UI 构建已更新，未替换运行中的安装包，未提交或推送。

## 后续只读网页样本验证

主代理于同日通过 ego-browser 使用当前已登录官方网页账号采集了脱敏只读证据：[`evidence/notification-query-live-20261103.json`](evidence/notification-query-live-20261103.json)。分类请求使用上述 1001 head，返回 Ack Success、6 个父分类及 23 个子分类；消息请求用初始游标 0 返回 100 条，再以首批最旧时间为游标返回 100 条，两个批次无重叠且第二批全部严格早于游标。该样本支持当前账号的只读查询及向前分页逻辑。

实际列表请求 head 未含 cid，也返回成功：这仅证明该样本在继承网页登录态下可成功，不足以证明所有宿主、账号或服务端版本都不要求 cid。样本账号未确认为截图中的 Bob 账号；未执行已读写入，亦非本机 Tauri 原生端到端验收。
