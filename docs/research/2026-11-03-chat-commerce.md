# 聊天流产品推荐与快捷回复接通

2026-11-03，Asia/Singapore。本轮在现有未提交工作区上定点实现，未提交、推送或安装发布。

## 需求与断点

原需求见 `docs/plan/02-im-and-service-operations.md` OPS-03 与产品推荐段、`docs/plan/2026-11-02-reverse-driven-improvement-plan.md` I-23。快捷回复选择只能填入草稿；产品推荐属于当前会话，不是产品管理模块。查询要保留关键词、城市、分页、客户语言/币种和模板分支。

原主窗产品推荐按钮由 `notWired` 禁用，已有 `sendProductCard` 没有 UI/RPC/宿主消费者。原快捷回复调用 `getCustomerScripts`，但所有非空结果都转成 `unsupported`，没有分类列表或正文插入。

## 官方逻辑证据

静态读取 `/Applications/旅游商家桌面版.app/Contents/Resources/app.asar.unpacked/dist/js/`，没有修改官方应用。

| 文件 | SHA-256 | 定位（Unicode 字符偏移，0 起） |
| --- | --- | --- |
| imWindow-BaGPtUvK.js | 9b4894abe8eab7274749169b8db0660e43301beeebdd30a4bc384ce216bfce47 | Iht/j2e 2275410/2276160；Lht 2278660；K4e 2616717；QOt 2622324；fmt 2549990 |
| BaseController-B_9ex1XX.js | 517db0fb51fc9dbb1f34a4176a8b5f436f8fe37e9180a6a7d1ce66800288756c | getRecommendSessionUrls 133819 |

- 分类：`getCategories {typeList:[VAGENT或VSKILLGROUP],categoryType:CUSTOMSCRIPT,status:ACTIVE}`；选中内容按纯文本段落追加到草稿。
- 联想：200ms 防抖 `getCustomerScripts {content:trim(keyword)}`；消费 `content/type`，选中后替换草稿。两者都不直接发送。
- 官方桌面产品入口：`15529/getSessionUrls`，带 gid/customerUid/source=2/chatType/sessionId/loginState，取推荐 URL 打开 iframe。查询与卡片组装位于远程业务页，不能将桌面 API 枚举当作实际调用。
- 本项目采用原生查询面板，依据既有 `docs/research/2026-10-30-im-peripheral-apis.md` §4、证据 38/39，并重新核对官方侧栏 `https://bd-s.tripcdn.cn/modules/vacation/tour-im-extra-area/js/6-7b0c231aee.js` 的城市与客户卡片分支。

## 实现

- `vbk/ui/apps/main/quick-replies.ts`：个人/团队分类、正文/快捷键筛选、追加草稿、200ms 联想与替换草稿；按账号代次、会话 revision、草稿版本丢弃旧结果。
- `vbk/ui/apps/main/recommend-panel.ts`：关键词、出发/目的城市候选、0 起分页、加载/空/权限/失败状态、选择产品卡片。切换查询清除旧结果；过期选择先刷新，等待再次明确点击。
- `vbk/ui/packages/web-adapter/src/recommend.ts`：真实查询和城市接口；服务端返回项保存在会话绑定令牌中，UI 不能自填客户身份、模板或卡片字段。1513/2384 选客户版本并保留币种/扩展名称；2508/2510 使用 relatedCustomerUid；发送前重新核对会话身份与在群状态。
- IPC/RPC/宿主四个命令完成接线；主窗 ACL；产品写入沿用持久 journal，未知结果不因关闭重开、新令牌或进程重启而自动重放。明确未提交允许新的显式尝试。产品发送仍使用 `sendCardMessageForOffline`、`inSession:true`。
- 快捷回复分类与推荐模态框会阻止遮挡消息自动已读；联想浮层不阻断可见消息。

## 验证

- `npm test`：1104/1104；`npm run typecheck` 通过。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：233/233。
- `npm run gates`：193 个门禁夹具符合预期，源码 0 违规。
- `npm run bundle:ui`：6 HTML 入口、126 文件，适配器 46 模块打包成功。
- 独立评审发现并修复默认城市 -1 的 Rust 无符号类型不兼容、明确失败缓存不释放、模态框下已读误报；补充过期刷新跨会话提示污染回归。
- ego-browser 本地模拟 UI：个人/团队、筛选无结果与恢复、分类追加、联想替换、无文本发送、产品查询/翻页/城市选择、模拟发送一次后禁用按钮。模拟截图 `.runtime/commerce-recommend-ui.png`，不代表真实客户发送。

## 当前登录态只读核对

通过 ego-browser 的独立任务页打开官方工作台，捕获当前页面读请求的 head，浏览器凭据由页面自动携带；不输出/保存凭据或完整客户标识。直接重放下列已知读取接口，仅证明浏览器登录态与响应结构，不等于 Tauri 宿主实机端到端通过。

| 读取 | 本轮观测 |
| --- | --- |
| getCategories / 个人 | HTTP 200、Ack Success，1 分类、8 条话术；id/shortCut/content/type/sortNo |
| getCustomerScripts | HTTP 200、Ack Success，6 条非空话术，与解析字段一致 |
| queryRecommendProductList / 首页 | HTTP 200、Ack Success、权限 true，客服/客户列表各 10 条，总数 139；业务 1513、客户 de-DE、EUR、有模板 |
| queryIMSuggestCityList / 上海 | HTTP 200、Ack Success，3 个候选，cityId/cityName/cityEName 等字段 |
| getLatestConversationByGid | 身份字段类型均匹配；status=2、inGroup=0。因此该会话不满足本实现卡片发送的在群前置条件 |

本轮没有发送真实客户消息、修改话术或改变上下班状态。打开官方会话可能触发官方页自身已读动作，不宣称浏览过程完全无副作用。没有完成当前 Tauri 真机上的真实卡片发送/读回验收，也未安装新包；不得将 mock 成功升级为正式发送成功。话术 CRUD 与完整服务端历史搜索不属于此次两个聊天入口修复。
