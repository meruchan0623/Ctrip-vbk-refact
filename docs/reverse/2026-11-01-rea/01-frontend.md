# 01 渲染层（前端）逆向报告

2026-11-01（rea 6.8.0 静态分析，Asia/Singapore）。对象：Mac 1.2.13（dist 的 aresVersion 为 1.2.18）与 Windows 1.2.12 的 `app.asar.unpacked/dist/`。
范围依据：[网页版范围决定](../../decisions/2026-10-30-web-only-scope.md)。全部结论来自静态证据，没有动态运行。缺陷编号 SEC/SUP/PRI/STA/MNT/PLG-xx 见 [03-defects.md](03-defects.md)；本文的 F-xx 只记录前端特有的问题。

**官方 / 插件判定**：Mac 1.2.13 包签名与公证校验都通过，未被插件注入（PLG-04），所以 Mac 渲染层的全部代码按**官方**判断。Windows 的插件注入只发生在主进程和启动层（PLG-01/02）。Windows dist 是同一套 Vite 构建，chunk 结构、哈希命名和 `__vite__mapDeps` 依赖图都与 Mac 一致，按**官方**判断，未发现插件改写渲染层的痕迹。下文没有特别说明的，都是官方代码。

## 0. 证据来源与方法

| 来源 | 用途 |
| --- | --- |
| `~/tools/rea-work/{mac,win}/dist-graph.evidence.json`、`dist-graph.summary.json` | rea `analyze_javascript_application` 结果：Mac 共检查 1220 个对象，状态为 complete-within-view；仍有 44 个应用图 unknown、53543 个语义图 unknown，另有 19 个 vendor 文件未纳入分析 |
| `facts/{mac,win}-dist-facts.tsv` | 7 个 endpoint、98 个 task、20 个 timer、37 个 boundary、18 个 listener |
| `facts/{mac,win}-dist-grep.txt` | appBridge 成员计数、域名、setInterval 周期、25 个页面入口 |
| `facts/{mac,win}-dist-split.txt` | 按 `;` 拆行后的代码，格式为「chunk<TAB>代码」。本文的关键字证据都来自这里 |
| `src/pages/*/index.html` | 入口脚本、modulepreload、CSP meta |
| `extracted/app/package.json` | 71 个 dependencies，没有 devDependencies |

辅助脚本放在 `~/tools/rea-work/fe/`：`lits.py` 按 chunk 提取中文字面量，`ctx.py` 用正则截取上下文（本机的 grep 是 ugrep，长上下文正则会超过复杂度限制，所以改用 python3 -I）。证据格式为 `chunk 名（去掉哈希）: 关键字`。

## 1. 技术栈与构建

### 1.1 依赖（package.json dependencies，共 71 个，渲染层与主进程混在一起）

| 类别 | 依赖 | 渲染层证据 |
| --- | --- | --- |
| UI 框架 | React（react-vendor 147KB）、antd 4.x（`@ctrip/nfes-antd@4.9.5`、`@ant-design/icons`、`react-slick`） | `react-vendor`、`antd-vendor`（1.11MB） |
| 状态 | `redux@4.0.4`、`redux-devtools-extension`、`zustand@5`、`@ctrip/nfes-store` | `BaseController: redux.js.org` |
| 时间 | `moment@2.30` | `antd-vendor`、`BaseController: momentjs.com`（locale 全量打包） |
| 表格 | `xlsx@0.18.5`（SheetJS） | `imWindow: sheetjs.com`，用于自定义表情的导入和导出 |
| 取色器 | jscolor（没有出现在 deps 里，是直接拷贝进来的） | `settingWindow: jscolor.com`、`new Function` 4 处 |
| 富文本 | `@tiptap/*`、`prosemirror-state` | `imWindow: tiptap` 9 处，输入框使用 |
| 虚拟列表 | `@tanstack/react-virtual` | `imWindow: measureElement` 4 处 |
| 拖拽 | `@dnd-kit/*` | `modifiers.esm`（45KB），用于快捷回复和表情排序 |
| 图片查看 | `viewerjs` | `imageWindow: viewerjs` |
| SSE | `@sentool/fetch-event-source` | `sdui-vendor: fetchEventSource`，AI 总结和推荐回复走流式接口 |
| 携程 SDUI | `@ctrip/xtaro*`、`xtaro-sdui-client-h5`、`xtaro-cds-h5`、`xtaro-biz-c-h5` | **只有 Mac**：`sdui-vendor`（1.66MB，`sdui` 出现 12071 次）、`SduiCard` |
| 携程框架 | `@ctrip/nfes-*`、`web-core`、`trip-component-*`、`vbk-hot-pc-component`、`schema-form` | `nfes-vendor`（272KB）、`BaseController`（229KB） |
| 埋点 | `@ctrip/ubt-web`、`trip-component-ubt` | Mac 在 `sdui-vendor` 里，Windows 单独拆成 `ubt`（35KB） |
| IM 上传 | `@ctrip/im-web-file-uploader` | `imWindow`：nephele / voice / video 上传域名 |
| 地图 | 高德 JSAPI 加载器；Google / 百度 / Mapbox 来自 xtaro | **只有 Mac**：`index-Bblg`（AMapUI/Loca 报错文案）、`sdui-vendor: maps.googleapis.com / api.map.baidu.com / api.mapbox.com` |
| 本地库 | `drizzle-orm`（sqlite-proxy）+ 主进程的 `better-sqlite3`/`sqlite3` | `BaseController: drizzle` 10 处，`dist/drizzle/*.sql` 迁移文件共 516KB |

主进程专用的依赖（`s-node-imclient-core`、`electron-*`、`sharp`、`jimp`、`paddleocr`、`onnxruntime-web`、`node-screenshots`、`request`、`heapdump`）不在本文范围，见 02 号报告与 STA-07、MNT-02、MNT-04。

### 1.2 构建形态

- **Vite 多页面应用**：25 个 HTML 入口在 `src/pages/<name>/index.html`，各自 `<script type="module" src="../../../js/<x>Window-<hash>.js">`，并用 `modulepreload` 预取共享 chunk。动态 import 使用 `__vite__mapDeps`（证据：`imWindow: AW(()=>import("./buildTranslateRequest-…js")…, __vite__mapDeps([3,1,2]))`）。
- **手工拆分的 vendor chunk**：`react-vendor`、`antd-vendor`、`nfes-vendor`、`sdui-vendor`（只有 Mac）。chunk 命名有错位：Rollup 把渲染层的**桥接封装和 IPC 枚举**合进了一个叫 `parseTranslateResponse-*.js` 的 chunk（Mac 14.5KB）；Windows 上同一份代码叫 `ubt-*.js`。所以 rea 的 appBridge 计数在 Mac 上归到 parseTranslateResponse，在 Windows 上归到 ubt。
- **体积**（js 目录）：

| 指标 | Mac 1.2.13 | Windows 1.2.12 |
| --- | --- | --- |
| js 总量（约） | 6.9MB / 49 个文件 | 5.5MB / 48 个文件 |
| 最大的 5 个 | imWindow 2.78MB、sdui-vendor 1.66MB、antd-vendor 1.11MB、nfes-vendor 272KB、BaseController 229KB | imWindow 2.77MB、antd-vendor 1.11MB、BaseController 382KB、nfes-vendor 271KB、loginWindow 186KB |
| static/ | 9.8MB：voice 5.2MB、yy-emoji 2.7MB、imyoyo 1.8MB、icon 48KB、IM_online 36KB、avatar 16KB | 同 |
| asset/（css/png/svg/ttf） | 1.6MB | 同 |
| dist 总量 | 19MB | 17MB |

- **热更新**：`dist/packageVersion.json` 的 `aresName=vbk-electron-v27`、`aresVersion=1.2.18`，`distUrl=https://file.tripcdn.com/files/8/tour_vbkadminuser/vbk-electron-v27/1.2.13/dist/1.2.18/dist.zip`。整份 dist 由 ares 热替换，传输与校验问题见 SUP-01。Mac 的 71 个 js/html 文件修改时间都是 2026-10-30 13:36，与一次热更新落盘相符。

## 2. 窗口 / 页面清单（25 个入口）

「范围」一列以 web-only-scope 为准：删除的只有携程业务模块，本项目自有能力（多账号、托盘、强提醒、商家助手、截图/OCR、更新）全部保留。

| # | 入口 src/pages/ | 入口 chunk（Mac） | `<title>` | 用途（证据） | 范围 |
| --- | --- | --- | --- | --- | --- |
| 1 | main | mainWindow（16.8KB） | Vbooking | 主壳：左侧菜单 12 项（`事件/产品/订单/公告/数据/商服/点评/消息/通知/工作台/首页/设置`），`setMainMessageHandler` 汇总未读 | **保留（重写）**：只留消息、通知、设置和账号标签 |
| 2 | imPlus | imWindow（2.78MB） | Home | IM 主体，见 3.1 | **保留** |
| 3 | notice | noticeWindow（42.6KB） | Vbooking | **通知中心**（不是公告）：分类、特别关注、免打扰、自定义声音、派单详情、LLM 翻译 | **保留**（特别关注和分类声音按决定不实现） |
| 4 | login | loginWindow（186KB） | Vbooking | 登录、注册、网络设置，见 3.2 | **保留** |
| 5 | setting | settingWindow（123KB） | Notifier（标题写错） | 设置，见 3.3 | **保留**（去掉业务项） |
| 6 | alarm | alarmWindow（8.3KB） | Alarm | 回复超时提醒列表：`XX个回复超时提醒`、`全部清除`，1s 计时 | **保留**（按 dev/03 重新设计） |
| 7 | notifier | notifierWindow（2.5KB） | Notifier | 新消息弹窗（设置中「新消息弹窗位置 右下角/左下角」） | **保留** |
| 8 | toolTip | toolTipWindow（6.0KB） | ToolTip | 托盘悬浮的未读详情（推断依据：设置项「状态栏显示未读消息详情」；无中文字面量） | **保留** |
| 9 | screenshots | screenshotsWindow（2.8KB）+ app（55KB） | Screenshots | 截图编辑：`矩形/椭圆/箭头/画笔/文本/马赛克/撤销/重做/保存` | **保留** |
| 10 | screenshotsOverlay | screenshotsOverlayWindow（1.9KB）+ app | Screenshots | 多屏遮罩，`on capture/reset/windowInfo` | **保留** |
| 11 | image | imageWindow（50KB） | Image | viewerjs 看图，`提取文字/识别结果`（OCR） | **保留** |
| 12 | video | videoWindow（2.5KB） | 视频查看器 | 视频播放，失败时 `videoPlayerFallback` 改用浏览器打开 | **保留** |
| 13 | update | updateWindow（2.7KB） | Vbooking | `发现新版本XXXX/后台更新/更新并重启` | **保留** |
| 14 | launch | launchWindow（2.0KB） | Vbooking | 启动闪屏（内联 base64 PNG，**没有 CSP**） | 保留（可选） |
| 15 | ai | aiWindow（8.8KB） | 总结消息 | 会话 AI 总结：`客户述求/客服小结/情感标签`，SSE `streamSummary` | **待定**：属于网页 IM 附属能力，按网页版是否提供来决定 |
| 16 | web | webWindow（8.3KB） | Vbooking | 通用远程页容器：`页面正在加载…/系统浏览器打开/回到主界面/工作台 - …`，URL 由主进程 `getWebInfoList` 下发 | **收缩保留**：只承载订单详情等最小入口 |
| 17 | home | homeWindow（12KB） | Home | 首页 | 删除 |
| 18 | event | eventWindow（2.0KB） | Event | 事件 | 删除 |
| 19 | bulletin | bulletinWindow（2.0KB） | Event | 公告 | 删除 |
| 20 | product | productWindow（2.2KB） | Product | 产品 | 删除 |
| 21 | bi | dataWindow（5.1KB） | Event | 数据（BI），含 16ms 轮询 | 删除 |
| 22 | comment | commentWindow（2.2KB） | Product | 点评 | 删除 |
| 23 | order | orderWindow（2.2KB） | Event | 完整订单管理（壳加远程页） | 删除（只保留 IM 内按订单号开会话） |
| 24 | course | courseWindow（2.2KB） | Event | 课程 | 删除 |
| 25 | archGuide | archGuideWindow（3.6KB） | 版本切换提示 | 芯片与安装包不匹配时引导下载（Mac x86_64 / arm64，见 STA-08） | 删除（Tauri 原生构建双架构，用不到） |

**合计**：保留 16 个（其中 main 需要重写、web 收缩、ai 待定、launch 可选），删除 9 个。`工作台` 和 `商服` 没有独立入口，它们是 main 菜单项，通过 web 窗口加载远程页，随菜单一起删除。注意：任务描述里把 notice 列为「公告」，但证据显示 notice 是**通知中心**（`setIMMessageHandler` 接收通知，未读类型为 `"notice"`），公告是 bulletin。

删除类页面（7 个 2KB 壳页）都依赖 `index-7Lsk`（一个刷新按钮），并加载远程业务页，本身几乎没有逻辑。

## 3. 前端功能清单

编号 FE-xx，证据格式为「chunk: 关键字」。「官方」是默认值。

### 3.1 IM（imPlus → imWindow，2.78MB）

**连接与会话列表**

| ID | 功能点 | 证据 |
| --- | --- | --- |
| FE-01 | 会话列表 5s 轮询（**增量**：`startTime`=上次响应 `lastUpdateTime`，无变化返回空列表；刷新/重置时 `startTime` 置空才全量），同时检查回复超时 | `imWindow: startLoopConvList … setInterval(async()=>{await this.getConversationList(),this.checkConvTimeout()},5e3)` |
| FE-02 | 连接状态心跳：向主进程发 `connectStatusChange`，连续失败后 `reconnectImPort` | `imWindow: postImMessage({event:Ca.connectStatusChange})`、`reconnectImPort` |
| FE-03 | 置顶 / 取消置顶、标记会话、会话标注 | `置顶/取消置顶/标记会话`；settingWindow `会话标注` |
| FE-04 | 草稿 | `草稿`、`draft` 10 处 |
| FE-05 | 群聊列表、被移出的群聊（`您已经被移出会话`、`清除所有移出的群聊`） | imWindow 字面量 |
| FE-06 | 上下班与聊天状态：`上班/下班/聊天状态/上班状态/岗位/上班时间/指定放假日期/指定工作日期` | imWindow、index-qM01 `工作时间/时区/周期` |
| FE-07 | 未读计数上报主窗和托盘 | `postMainMessage({event:unreadCountChange,detail:{type:"message",buid,count}})`、`sendUnreadMsgCount` |
| FE-08 | 新消息系统通知和弹窗 | `sendNewMessageNotice → new_message`；`您有新消息` |
| FE-09 | 会话列表使用虚拟列表 | `measureElement`（@tanstack/react-virtual） |

**消息类型**（摘要文案与渲染分支，`messageType` 为数值）

| ID | 类型 | 证据 |
| --- | --- | --- |
| FE-10 | 文本（含链接自动识别，设置项「链接文本自动可点击」） | `链接`；settingWindow |
| FE-11 | 图片 `[图片]` | `[${n[D.picture]||"图片"}]`、`查看图片`、`保存图片` |
| FE-12 | 语音 | `语音` |
| FE-13 | 视频（大小和时长限制） | `视频大小不可超过XXM`、`视频时长超出XX分钟`、`static/IM_online/video_cover.png` |
| FE-14 | 文件 `[文件] name`（pdf/word/excel 图标） | `[${n[D.file]…}]`、`static/icon/file_pdf.png` 等 |
| FE-15 | 位置 `[位置]` | `[${n[D.location]…}]` |
| FE-16 | 卡片 / 商品 / 订单卡片 | `卡片`、`商品`、`orderCard` 2 处、`使用日期`、`订单号` |
| FE-17 | **SDUI 卡片消息**（只有 Mac） | `imWindow: [卡片消息]`、`SduiCard`（xtaro SDUI 渲染） |
| FE-18 | 问答消息、游游机器人 | `问答消息`、`游游机器人` |
| FE-19 | 系统消息、撤回提示、关键词预警 | `系统`、`撤回了一条消息`、`触发关键词预警，请关注，类型为：` |
| FE-20 | 评价消息 | `请对XXXX本次服务进行评价`、`本次{0}的服务{1}。` |
| FE-21 | 不支持的类型兜底 | `不支持的消息类型`、`###不支持的消息类型###` |

**发送与输入**

| ID | 功能点 | 证据 |
| --- | --- | --- |
| FE-22 | 富文本输入框（tiptap），快捷键可配置 | `tiptap`；settingWindow `快捷键/发送消息` |
| FE-23 | 发送走 MessagePort 交给主进程 IM 进程，并回传发送状态 | `postImMessage({event:Ca.sendMessage,detail})`；事件 `messageSendStatus` |
| FE-24 | 拖拽或选择文件发送，有限额 | `拖到这里发送文件`、`一次只能上传XX个文件`、`不能上传超过10M的图片`、`文件不能超过30M`、`暂不支持发送该类型文件` |
| FE-25 | 上传域名（生产） | `nephele.ctrip.com/file/v1/api/upload`、`nephele.tripcdn.com`、`voice.c-ctrip.com`、`video.c-ctrip.com` |
| FE-26 | 上传域名（测试，打进了生产包） | `ws.uploadfile.fx.{uat,fws}.qa.nt.ctripcorp.com/file/v1/api/upload`、`ws.voice.upload.fx.*`、`ws.video.upload.fx.*`、`voice/video.{uat,fws}.qa…`、`uploadimg.{uat,fws}.qa.nt.{ctripcorp,tripqate}.com` |
| FE-27 | 截图后粘贴发送，可设置截图时隐藏窗口 | `截图时隐藏当前窗口`；bridge `openScreenShotPanel`/`pasteScreenShot`/`screenShotReady` |
| FE-28 | 敏感信息拦截 | `内容中包含敏感信息，请修改后再发` |
| FE-29 | **反自动化输入检测**（新发现）：按评分拦截发送，检测项包括 webdriver、自动化 UA、plugins 为空、语言异常、CDP 运行时特征、JS 注入痕迹、脚本关键词（`puppeteer|playwright|selenium|…|fetch\(|postMessage`）、链接密度、重复度、输入速度峰值、粘贴占比、鼠标轨迹缺失或过于机械、非可信（`isTrusted`）事件比例 | `imWindow: X4e="系统检测到当前消息存在异常自动化输入风险，已拦截发送…"`、`n.webdriver&&(t+=35,…)` |
| FE-30 | 正在输入状态 | `对方正在输入...`；事件 `sendInputState` |
| FE-31 | 错别字修正（拼写检查，由主进程模型执行） | `错别字修正/忽略`；bridge `spellCheck → spell_check` |
| FE-32 | 发送频率限制提示 | `消息发送过于频繁`、`消息发送超过上限` |

**消息操作、已读与历史**

| ID | 功能点 | 证据 |
| --- | --- | --- |
| FE-33 | 复制、引用、转发 | `复制/引用/转发/引用内容详情/引用内容已撤回/引用到输入框` |
| FE-34 | 撤回（2 分钟限制）与重新编辑 | `recall` 16 处、`不允许撤回发送超过2分钟的消息`、`重新编辑` |
| FE-35 | 已读 / 未读回执 | `已读/未读`；`postImMessage({event:Ca.sendMessageReceipt})` |
| FE-36 | 会话历史（分页） | `historyMessage` 8 处、`与XXXX的会话历史`、`没有更多了`、`往前/往后` |
| FE-37 | 聊天记录搜索：按用户、日期、内容，只能查 3 个月内 | `聊天记录/指定搜索内容/用户/日期/未找到相关内容/仅支持查找3个月内的记录` |
| FE-38 | 本地聊天记录缓存天数 | settingWindow `本地聊天记录缓存时长 天` |
| FE-39 | 打码信息解码（会留痕），先校验实名或企业微信 | `点击后解码，此操作将会被记录`；index-qM01 `该账号暂未实名认证`、`请使用本人企业微信扫码验证`、`请在手机上完成人脸验证` |

**群、转接与会话生命周期**

| ID | 功能点 | 证据 |
| --- | --- | --- |
| FE-40 | 邀请客服 / 商户进群（单选或多选，按部门、员工、业务线） | `邀请客服/邀请商户/邀请成员/部门/员工/业务线/供应商客服/携程客服`、`invite` 15 处 |
| FE-41 | 转移主客服（转接） | `转移主客服`、`请选择一位作为主客服`、`转移主客服目标仅可为一人`、`请先转移主客服`、`transfer` 10 处 |
| FE-42 | 移除成员、改群名、群欢迎语、复制并新建群 | 同名字面量 |
| FE-43 | 结束会话 | `确定结束会话吗？`、`请您回复后再退出会话` |
| FE-44 | 转人工与排队（客人侧状态展示） | `转人工/您已处于人工模式/前方排队XX人/退出排队` |
| FE-45 | 邀请评价 | `评价/已发表过评价/评价失败/评价已提交` |
| FE-46 | **按订单号开会话** | `请输入订单号`、`订单号有误`、`创建会话失败`、`开始聊天` |
| FE-47 | 跳转到指定会话（从通知或弹窗进入） | bridge `jumpToConversation` |

**翻译（官方）**

| ID | 功能点 | 证据 |
| --- | --- | --- |
| FE-48 | 收到的消息逐条翻译和整段对话翻译，可隐藏 | `翻译/翻译为/翻译为显示语言/翻译当前对话/隐藏翻译/当前会话暂不支持翻译/来自XXXX翻译/正在翻译…/未找到翻译结果/点击重试` |
| FE-49 | **边写边译**（出站翻译）：输入时翻译，可「使用」替换原文；目标语言有简体、繁体、日语、English 等 | `imWindow: realTimeTranslate`，动态 import `buildTranslateRequest`/`parseTranslateResponse`；`开启边写边译/关闭边写边译/输入内容后自动翻译/使用`；`kOt=3e3`（防抖） |
| FE-50 | 翻译请求结构 | `buildTranslateRequest: {sessionId,groupId,messageTxt,source:"AUTO",target,appId:"9000***",bizType,timeoutInSeconds:10}`；响应字段 `success`/`translatedText` |

判定：Mac 包未被注入，这两个 chunk 是 Vite 构建产物，由 imWindow 用 `__vite__mapDeps` 懒加载，所以是**官方**功能。本项目「商家助手的出站翻译」与官方 FE-49 功能重叠，设计时要注意 FE-29：用程序写入输入框的文字可能触发「非可信事件 / 粘贴占比」评分。

**表情、提示音与 AI**

| ID | 功能点 | 证据 |
| --- | --- | --- |
| FE-51 | 内置小表情 `[龇牙]…[托眼镜]`（约 80 个） | imWindow、index-DKzk；`static/yy-emoji/`（2.7MB） |
| FE-52 | 游游动图表情 | `static/imyoyo/im_emoji_youyou_*.gif`（1.8MB） |
| FE-53 | 自定义表情：添加、编辑、命名搜索、排序、**Excel 导入导出**（SheetJS） | `添加自定义表情/表情名称可用于搜索和自动联想/上传表情(PNG、JPG、GIF ≤5M)/导入/导出/表情导入成功`；`sheetjs.com` |
| FE-54 | 快捷回复：个人或团队、分类、增删改、移动、拖拽排序，显示「被问XX次」 | `快捷回复/编辑快捷回复/个人/团队/新增分类/移动至/被问XX次`（imWindow、index-qM01）、`fastReply` |
| FE-55 | 提示音：新消息 `msgSound.wav`，可选 `B01–B04.wav`（voiceType 1–4），支持自定义声音 | `pu="/static/voice/msgSound.wav"`、`xh=[{voiceType:1,url:"/static/voice/B01.wav"}…]`；bridge `setLocalVoice` |
| FE-56 | 推荐回复（「助小游」）：SSE 生成，可直接发送或引用到输入框，可关闭 | `推荐回复/AI回复/推荐回复生成中.../生成超时/我是助小游，您的智能回复助手`；`m.ctrip.com/restapi/tour/agentstudio/sse/shoppingGuide` |
| FE-57 | 产品推荐、线路推荐 | `产品推荐/线路推荐` |
| FE-58 | 会话 AI 总结（打开 ai 窗口） | `总结消息`、`aiSummary`；bridge `openAiWindow`；aiWindow `m.ctrip.com/restapi/package/conversationsummary/streamSummary` |
| FE-59 | 账号状态提示：登录态过期、会话断开、账号下线、版本过低、断网 | `账号下线提醒/当前账号登录态过期/会话连接已断开/当前应用版本过低/当前无法连接网络` |
| FE-60 | 浏览器网页登录授权确认 | `登录授权提示/您正在使用XXXX身份登录浏览器网页…/是我本人，继续授权/取消授权` |
| FE-61 | 远程资源：IM 内嵌页与静态资源 | `vbooking.ctrip.com/ivbk/accountV2/vbkChat`、`/tour/im/ex-area/b`、`webresource.c-ctrip.com/ares2/basebiz.im/agent-site-static/`、`vendor.package.ctripcorp.com` |

### 3.2 登录（loginWindow，186KB）

| ID | 功能点 | 证据 |
| --- | --- | --- |
| FE-62 | 手机号加短信验证码（按国家码，约 230 个国家或地区） | `请输入你的手机号/请输入验证码`、`verifyCode` 9 处、`sms` 14 处；`soa2/31477/json/getcountrycode`、`www.trip.com/m/home/getcountrycode` |
| FE-63 | 账号密码，可记住密码、自动登录 | `password` 31 处、`记住密码`、`rememberPassword`、`autoLogin`；密码明文落盘问题见 PRI-01 |
| FE-64 | 扫码登录（旅游商家 App） | `打开旅游商家app扫一扫登录/二维码过期/点击刷新/扫描成功，请在手机上点击登录`、`qrcode` |
| FE-65 | 滑块验证（captcha） | `SlidItem`（37KB，15s 超时）、`slider` |
| FE-66 | 手机号或邮箱注册、密码强度、重置密码跳转 | `手机号注册/邮箱注册/密码长度为8-20位/弱/中/强`；`business.ctrip.com/user/resetpwd.html` |
| FE-67 | 协议勾选 | `请先阅读并同意相关协议和政策` |
| FE-68 | 网络设置：网关（默认或携程网关）、网络优化、使用系统代理、健康检查、DNS 修复教程 | `网络设置/网关/携程网关/网络优化/使用系统代理`、`soa2/12405/checkhealth`、`pages.ctrip.com/ebooking/other/dns-fix-guide.html` |
| FE-69 | 多账号：已登录账号提示、添加账号、账号列表排序 | `当前账号已经登录`；bridge `addAccount/getCacheAccountList/sortAccountList/removeCachePassword` |
| FE-70 | 登录错误码文案（约 30 条） | imWindow 与 login 共用：`风控验证失败/账号已注销/动态码验证失败/调用issueLoginSession异常/账号不存在或密码错误…` |

### 3.3 设置（settingWindow，123KB）

| ID | 分组 | 设置项（字面量） |
| --- | --- | --- |
| FE-71 | 通用设置 | 显示每条消息时间、时间精确到秒、链接自动可点击、新开页面默认全屏、开机自启、会话标注、拼写检查、本地聊天记录缓存时长、语言、缩放比例（特小到特大）、GPU 加速（重启后生效） |
| FE-72 | IM 通知设置 | 新消息通知、通知弹窗、状态栏未读详情、通知音（自定义、替换、播放、清除，作用范围为当前账号或所有账号）、弹窗位置（右下角或左下角）、**回复超时提醒、超时提示音、超时阈值（XX 秒）** |
| FE-73 | 系统通知设置 | 新系统通知、弹窗、状态栏未读、提示音、事件未处理红点（删除） |
| FE-74 | 快捷键 | 发送消息、截图、显示或隐藏工作台（可录制） |
| FE-75 | 帮助工具 | 打开安装目录、打开数据目录、清除缓存数据 |
| FE-76 | 个人设置 | 工作时间、快捷回复、自动答复 |
| FE-77 | 关于 | 版本检测、更新、芯片版本适配（删除）、使用教程、下载官网、常见问题设置（`vbooking.ctrip.com/imAdmin/FAQconfiguration`）、意见反馈、问卷（`trippoll.ctrip.com`）、旅游商家 App 二维码 |
| FE-78 | 调试工具 | 环境切换 PROD/UAT/…、堡垒开关（`toggle_baolei`）、启动时打开 DevTools；其中至少「启动时打开开发者工具」带有 `visible:e==="development"`，分组本身是否隐藏未确认 |

### 3.4 其他窗口

| ID | 窗口 | 功能点 | 证据 |
| --- | --- | --- | --- |
| FE-79 | notice | 通知分类列表、特别关注、免打扰、自定义声音、未读上报（type=notice） | `postMainMessage({…type:"notice"})`、`设置特别关注/通知免打扰` |
| FE-80 | notice | 定制派单：派单详情（需求单号、出发地、目的地、日期、人数）、申请接单 | `派单详情/申请接单/您确定要申请派单吗？`；`…/dingzhivbk/dispatchDetail`、`/micro/ttl_vendor/customistPageList` |
| FE-81 | notice | 通知内容 LLM 翻译 | `以上译文由 LLM 大语言模型生成，仅供参考` |
| FE-82 | alarm | 回复超时列表，按秒计时，可单条或全部清除 | `setInterval(…,1e3)` 2 处；`XX个回复超时提醒/全部清除` |
| FE-83 | image | 看图（前一张、后一张）、右键菜单、OCR 提取文字 | `已是最后一张/提取文字/识别结果`；bridge `recognizeImage/recognizeImageBuffer/cancelRecognition/popContextMenu/imageOption` |
| FE-84 | video | 播放失败时回退到系统浏览器，并上报播放日志 | `videoPlayerFallback/videoPlayerLog` |
| FE-85 | screenshots | 标注工具与确定、取消、保存 | `app: 矩形…马赛克/确定(Enter)/取消(Esc)`；`window.screenshots` 41 处 |
| FE-86 | update | 检测、下载（后台）、安装重启 | bridge `checkNewVersion/downloadNewVersion/installNewVersion/updateStatusChange` |
| FE-87 | web | 远程页容器：页内查找、系统浏览器打开、回到主界面 | bridge `findInPage/stopFindInPage/foundInPage/openWithSystemBrowser/commonWebOption` |
| FE-88 | main | 账号切换与昵称、窗口闪烁、全屏 | `请输入昵称`；bridge `changeAccount/flashMainWindow/windowFullScreen` |

**web 窗口加载的远程 URL**：webWindow 本身没有 URL 字面量，URL 由主进程 `get_web_info_list` / `open_extra_window` 下发（见 02 报告）。渲染层能看到的远程地址：settingWindow 的 `imAdmin/FAQconfiguration`、`micro/ivbk/accountV2/noticemanagement`、`ivbk/accountV2/promotionalPage`、`zuchebao.ctrip.com/calabi/im/customerServiceManagement`、`trippoll.ctrip.com`；BaseController 的多语言站点首页 `m.ctrip.com/webapp/vbooking/home`、`{hk,jp,kr,th}.trip.com/m/vbooking/home`（以及对应的 fat6/uat 测试域名）。

**功能点统计**：共 88 项（IM 61、登录 9、设置 8、其他 10）。

## 4. 渲染层与主进程的边界

### 4.1 预加载暴露与实际使用

preload 暴露了 11 个 contextBridge 键（`appBridge`、`postImMessage`、`postMainMessage`、`postPortMessage`、`setIMMessageHandler`、`setMainMessageHandler`、`getImPortStatus`、`reconnectImPort`、`screenshots` 等，见 `facts/mac-main-facts.tsv` 的 context-bridge-api 一节）。渲染层实际使用的情况：

| 成员 | 调用次数（Mac split） | 用途 |
| --- | --- | --- |
| `appBridge.send` | 29 | 单向 IPC（channel 来自枚举） |
| `appBridge.invoke` | 24 | 请求 / 响应 IPC |
| `appBridge.receive` | 20 | 订阅主进程事件 |
| `appBridge.getLoginCookie` / `getCacheAccountList` | 2 / 2 | 读取登录态和账号列表 |
| `appBridge.getAllLoginCookies` | 1 | **读取全部账号的 cookie**（`getCommonData` 分支） |
| `appBridge.dbQuery` | 1 | **通用 SQL 执行**：`dbExecute(e,n=[],r="all"){return window.appBridge.dbQuery(e,n,r)}`，BaseController 用 drizzle sqlite-proxy 拼 SQL：`kd(async(...o)=>({rows:await at.dbExecute(...o)}),{schema:Sd})` |
| `appBridge.netFetch` | 1 | 让主进程代发请求：`BaseController.fetch(n,r,l){return l===!1?window.appBridge.netFetch(n,r):…}` |
| `appBridge.downloadFile` / `openExtraWindow` / `setLocalVoice` | 各 1 | 下载、打开额外窗口、设置本地提示音 |
| `postImMessage` / `postMainMessage` | 5 / 2 | MessagePort 消息 |
| `setIMMessageHandler` / `setMainMessageHandler` | 2 / 1 | 接收 port 消息（imWindow、noticeWindow / mainWindow） |
| `reconnectImPort` | 2 | 心跳失败后重连 |
| `window.screenshots.*` | 41 | 截图专用 preload（cancel/captureWindow/getAllSettings/imageLoaded/ok/save/on/off…） |

未发现渲染层直接使用 `getImPortStatus` 和 `postPortMessage`（minify 后可能经过别名，静态上不能完全排除）。

### 4.2 IPC channel 枚举（渲染层侧，约 93 个）

定义在共享 chunk（Mac `parseTranslateResponse-*`，Windows `ubt-*`）的 `const o={getAppConfig:"get_app_config",…}`。按领域分组：

- **配置 / 环境**：get_app_config、get_shark_info、change_shark_locale、change_env、toggle_baolei、clear_user_store、get/change_user_preferences
- **账号 / 登录**：get_login_cookie、get_all_login_cookies、get_cache_account_list、remove_cache_password、sort_account_list、get_current_user_info、get_account_list、login_success、login_failure、add_account、change_account、logout、begin_to_login、refresh_data
- **窗口**：main_view_changed、web_view_changed、get_web_info_list、flash_main_window、close_window、show_window、window_loaded、window_full_screen、window_height_change、open_window、open_extra_window、close_extra_window、force_focus、open_ai_window、open/close_finder_window、find_in_page、stop_find_in_page、found_in_page、pop_context_menu、common_web_option、open_with_system_browser
- **芯片引导（删除）**：arch_detect_result、show_arch_guide、arch_guide_action、arch_guide_render、arch_guide_action_ubt、arch_guide_download_progress、arch_guide_download_done、request_arch_guide
- **文件 / 系统**：download_file、open_install_dir、open_data_dir、get/set_cache_data、get/clear_cache_url_list、get_stay_duration、get_launch_count、set_local_voice、image_option、video_player_log、video_player_fallback
- **截图 / OCR / 拼写**：open_screen_shot_panel、paste_screen_shot、screen_shot_ready、recognize_image、recognize_image_buffer、cancel_recognition、spell_check
- **更新**：get_cur_version_info、get_update_info、check_new_version、update_new_version、download_new_version、install_new_version、update_status_change
- **IM / 端口**：get_im_channel_port、im_process_started、get_main_channel_port、send_main_channel_port、send_broadcast_event、unread_message_count、reply_timeout、clear_message_by_user、new_message、notify_info、jump_to_conversation、execute_db、get_current_messages、net_fetch

### 4.3 MessagePort 消息类型

IM 进程、IM 渲染页和主窗之间的事件枚举 `Ca`：`newMessage`、`newNotice`、`sendMessage`、`messageSendStatus`、`sendInputState`、`sendMessageReceipt`、`unreadCountChange`、`buTypeChanged`、`connectStatusChange`（字符串形如 `connect_status_change`）。负载形状：

- 渲染层到 IM 进程：`postImMessage({event, detail})`，event 为 connectStatusChange、sendMessage 或 sendMessageReceipt
- 渲染层到主窗：`postMainMessage({event:"unreadCountChange", detail:{type:"message"|"notice", buid, count}})`
- IM 进程到渲染层：`setIMMessageHandler(({from, data}) => …)`
- 各账号到主窗：`setMainMessageHandler(({buid, portId, data}) => …)`

### 4.4 边界评价

渲染层把**数据库（任意 SQL）、网络代理（netFetch）、全部账号 cookie** 当作通用能力使用，主进程只做透传；业务逻辑（会话轮询、超时判定、反自动化、翻译）都在渲染层。远程页面也注入了同一个 preload（SEC-07），所以这些通用能力对远程页同样开放。Tauri 重构时边界必须反过来：由后端提供窄口命令。

## 5. Mac 与 Windows 差异

| 项 | Mac 1.2.13（ares 1.2.18） | Windows 1.2.12 | 说明 |
| --- | --- | --- | --- |
| 独有 chunk | `sdui-vendor`（1.66MB）、`SduiCard`（5KB） | `ubt`（35KB） | Mac 新增 xtaro SDUI 渲染；Windows 的 ubt 和桥接封装放在 ubt chunk |
| 地图 | 高德加载器 `index-Bblg` 加 Google、百度、Mapbox（在 sdui-vendor 内） | 没有 | 地图 SDK 随 SDUI 引入，不是 IM 主动使用 |
| BaseController | 229KB | 382KB | Windows 把公共依赖留在 BaseController，Mac 拆进了 sdui-vendor |
| imWindow | 2,783,190B | 2,773,443B | 字面量差异只有 `[卡片消息]`（SDUI 卡片消息），其余只是 minify 变量名不同（`D.`/`W.`） |
| 共享桥接 chunk | parseTranslateResponse 14.5KB | parseTranslateResponse 5.1KB 加 ubt 35KB | Mac 多一个 `mediaType` 字段 |
| 其他同名页面 | 大小差异都小于 0.5% | — | 登录、设置、通知、截图等功能一致 |
| 分析覆盖 | dist 证据 210MB | dist 证据 217MB | rea 结构相同 |

结论：两版渲染层功能基本一致。Mac 多出的「SDUI 卡片消息」（FE-17）带来约 1.66MB vendor 和 4 套地图 SDK 引用；Windows 1.2.12 没有这项能力。没有做 `compare-application-versions` 全量对比（两份证据各 200MB 以上，超出本轮预算），以上对比基于 chunk 清单、大小和逐 chunk 中文字面量与枚举键集合的差集。

## 6. 前端问题（F-xx）

同一问题已有 03 号报告编号的，只引用编号，不另立 F 号。

| ID | 级别 | 问题 | 证据 | 关联 |
| --- | --- | --- | --- | --- |
| F-01 | **P0** | 渲染层依赖**通用 SQL 执行**：drizzle sqlite-proxy 经 `appBridge.dbQuery(sql, params, mode)` 在主进程执行任意 SQL，没有表或语句白名单；页面一旦出现 XSS，就能读写全部本地聊天库 | `parseTranslateResponse: dbExecute(e,n=[],r="all"){return window.appBridge.dbQuery(e,n,r)}`、`BaseController: kd(async(...o)=>…dbExecute…)` | SEC-07、PRI-02 |
| F-02 | **P0** | 渲染层可调用 `getAllLoginCookies` 与 `netFetch`，任意脚本都能拿到全部账号的登录 cookie，并借主进程绕开同源限制发请求 | `getCommonData: e===o.getAllLoginCookies?window.appBridge.getAllLoginCookies()`、`BaseController.fetch → appBridge.netFetch` | SEC-07、SEC-01 |
| F-03 | P1 | IM 渲染使用 `dangerouslySetInnerHTML` 25 处（另有通知 2、alarm 2、toolTip 2）；在通配 CSP（SEC-03）和 webSecurity:false（SEC-01）下，只要转义有一处疏漏就会形成 XSS，并连到 F-01/F-02。是否全部经过净化，静态上未确认 | split 计数 `dangerouslySetInnerHTML=imWindow:25` | SEC-03 |
| F-04 | P1 | 每个小窗口都 modulepreload 全量 vendor：alarm（8KB）、ai、notifier、toolTip 等都预取 react、antd、sdui-vendor（1.66MB）、BaseController、nfes，单窗冷启动约 3.3MB 以上的 JS。原因是桥接枚举被 Rollup 合进了依赖 sdui 的共享 chunk | `alarm/index.html` 的 modulepreload 列表含 `sdui-vendor`、`antd-vendor`、`BaseController` | STA-07 |
| F-05 | P1 | 超大单 chunk：imWindow 2.78MB 没有按路由或功能拆分（SheetJS 表情导入导出、tiptap、翻译、群管理、反自动化等全部打在一起），只有翻译做了懒加载 | 文件大小；`sheetjs.com`、`tiptap` 都在 imWindow | — |
| F-06 | P1 | 会话列表**每 5s 增量拉取**（`POST 16037/getConversationList`，体 `{head,startTime,needTodoList:1}`，实测间隔 5.0s，`startTime` 恒等于上次响应 `lastUpdateTime`）并在同一回调里做超时检查；另有**每 3s 一次**的 `POST 15529/getSessionEmpathyPhraseInfo`（会话未结束且已选中时）。`checkManualAgentStatus … 3e3` 仅在「排队中」系统消息组件挂载期间存在，不是全局坐席轮询。轮询均无退避，也不随窗口可见性暂停（只有重连逻辑检查了 visibility）。多账号时请求量按账号数线性增长 （2026-11-02 实机抓包修正，见 [验证报告](../../reviews/2026-11-02-desktop-live-capture-verification.md)）。多账号时请求量按账号数线性增长 | `startLoopConvList … 5e3`、`checkManualAgentStatus … 3e3` | STA-02、STA-03 |
| F-07 | P2 | 测试和预发域名打进生产包：`*.fat29/uat/fws.qa.nt.ctripcorp.com`、`*.qa.nt.tripqate.com` 分布在 sdui-vendor 12 处、imWindow 7 处、settingWindow、noticeWindow、BaseController、loginWindow（全量域名统计见 dist-grep：fat29 14 次、uat 13 次） | `facts/mac-dist-grep.txt` 域名一节 | PRI-04、SEC-06 |
| F-08 | P2 | 生产设置页带「调试工具」：环境切换 PROD/UAT、堡垒开关、启动时开 DevTools，只有部分项受 `visible:e==="development"` 控制；切换到非 PROD 会联动 SEC-06（忽略证书错误） | `settingWindow: groupName:s[v.debugTools]…options:[{text:"PROD"…},{text:"UAT"…}]`；bridge `change_env/toggle_baolei` | SEC-06、SEC-12 |
| F-09 | P2 | 硬编码 http 明文网关：xtaro 的 `DOMAIN_SERVER_MAP` 把 **PROD 映射到 `http://apigateway.ctripcorp.com`**，DEV/FAT/UAT 映射到 `http://gateway.m.*.qa…`；另有 `http://` 前缀拼接 2 处 | `sdui-vendor: DOMAIN_SERVER_MAP={…PROD:"http://apigateway.ctripcorp.com"…}` | SUP-01（同为明文问题） |
| F-10 | P2 | 同时打包多套地图和 UI 库：高德（index-Bblg）、Google、百度、Mapbox 加载代码，xtaro H5 组件库与 antd 4 并存，moment 带全量 locale，redux 与 zustand 并存 | 第 1 节依赖表 | STA-07、MNT-02 |
| F-11 | P2 | 反自动化输入检测完全在客户端做：可被绕过，也可能误伤合规的辅助输入（输入法、粘贴、无障碍工具、本项目的出站翻译回填） | `imWindow: X4e="系统检测到当前消息存在异常自动化输入风险…"`、评分规则 | PLG-01（插件开 CDP 会命中「CDP 运行时特征」） |
| F-12 | P2 | `new Function` 与 `eval(`：settingWindow 4 处（jscolor 等）、imWindow 1 处、loginWindow 1 处、sdui-vendor 3 处，导致 CSP 必须放开 `unsafe-eval` | split 计数 | SEC-03 |
| F-13 | P3 | 高频定时器：dataWindow 16ms（`setInterval(B,16)`，删除模块）、sdui-vendor 100ms `readyStateCheckInterval`、另有 1 处 10ms（未定位到业务代码）；alarm 两个 1s 计时器在窗口隐藏时是否停止未确认 | dist-grep 的 setInterval 周期一节；`dataWindow: window.setInterval(B,16)` | STA-03 |
| F-14 | P3 | 无界数据：会话列表首次/重置时全量返回（稳态为增量），未见分页参数；本地聊天缓存靠「缓存时长（天）」控制，没有条数上限；`get_cache_url_list` 等缓存 URL 列表没有上限 | FE-01、FE-38 | STA-05 |
| F-15 | P3 | 构建产物质量：chunk 命名错位（桥接代码在 `parseTranslateResponse`/`ubt`）、页面 `<title>` 写错（setting 为 Notifier，bi、order、bulletin、course 为 Event，comment 为 Product，imPlus 为 Home）、生产包没有 source map | 第 2 节表格 | MNT-01 |
| F-16 | P3 | 静态资源偏大：提示音 wav 5.2MB、表情 4.5MB 未压缩（可改用 opus 或 webp），launch 页把 PNG 内联成 base64 | `static/voice` 5.2MB | STA-07 |

CSP 实测：24 个页面都有 `<meta http-equiv="Content-Security-Policy" content="default-src * self blob: data: gap:; script-src * 'self' 'unsafe-eval' 'unsafe-inline' …">`，相当于没有 CSP；launch 页连 meta 都没有。这就是 SEC-03，不另立 F 号。

**前端 Top 10**（按风险排序）：F-01、F-02、F-03、F-06、F-04、F-05、F-08、F-07、F-09、F-11。

## 7. 对 Tauri 重构前端层的建议

### 7.1 可以复用（作为契约或参考，不复用源码）

1. **IPC 枚举（93 个）与 MessagePort 事件（9 个）**：作为 Tauri command 和 event 的需求清单，按第 4.2 节分组，删除 arch_guide、业务页相关项后约剩 60 个。
2. **设置项清单（FE-71 到 FE-77）**：可直接作为偏好设置的 schema，去掉 GPU、芯片适配和调试工具。
3. **消息类型与摘要文案（FE-10 到 FE-21）、错误码文案（FE-70）、上传限额（图片 10M、文件 30M、表情 5M、撤回 2 分钟、历史搜索 3 个月）**：作为前端校验和展示规则。
4. **翻译请求形状（FE-50）与边写边译的交互**（3s 防抖，可「使用」替换原文）：可供商家助手出站翻译参考。是否直接调用官方接口，需要按网页版实际入口取样验证。
5. **drizzle 迁移 SQL（`dist/drizzle/*.sql`）**：作为本地库 schema 参考，Rust 侧可以改用 rusqlite 或 sqlx 重建。
6. **提醒逻辑**：`checkConvTimeout` 与回复超时阈值、提示音选择（voiceType 1–4、自定义声音、作用范围）。
7. **静态资源**：提示音和表情图片在技术上可以直接用，但属于携程素材，需要确认授权；如果要分发，建议替换成自有资源。

### 7.2 必须重写

1. **全部 UI**：产物经过 minify，没有 source map，并且与 antd 4、xtaro、nfes 私有包深度耦合，不能迁移。按本仓库原型（docs/design/prototype）重写，并合并成一个 SPA 加少量原生窗口（alarm、notifier、截图遮罩）。
2. **桥接层**：不能再提供 `dbQuery`、`netFetch`、`getAllLoginCookies` 这类通用能力。改成按领域划分的窄口 Tauri command（例如 `conversation_list(account)`、`message_history(conv, cursor)`），SQL 只在 Rust 侧，cookie 不出后端（对应 F-01、F-02）。
3. **会话同步**：用事件推送替代 5s 增量轮询（官方已是增量，仍需 3s 共情话术轮询），加入可见性暂停与指数退避（F-06）。
4. **消息渲染**：禁止拼 HTML，统一走结构化渲染加白名单 markdown 或链接识别（F-03）；配严格 CSP（Tauri 默认），不使用 `unsafe-eval`（F-12）。
5. **环境与调试**：生产构建不带测试域名、环境切换和 DevTools 开关，环境在构建期注入（F-07、F-08）。
6. **SDUI 卡片和地图**：属于订单或业务卡片，按范围决定只保留订单最小入口，不引入 xtaro 和地图 SDK；订单信息用本项目的套餐速览和订单查询面板展示。
7. **出站翻译和辅助输入**：如果最终把文字写进官方网页的输入框，要考虑 FE-29 的评分（非可信事件、粘贴占比、CDP 特征）。优先走官方接口直接发送，或者在 UI 上明确由人工确认后发送，不要模拟键鼠输入。

### 7.3 未验证与后续

- 第 4.1 节「未直接使用 getImPortStatus/postPortMessage」受 minify 别名影响，可能有遗漏。
- `dangerouslySetInnerHTML` 的输入来源与净化情况、alarm 计时器在窗口隐藏时是否停止，需要动态核实。
- Mac 与 Windows 的全量 `compare-application-versions` 没有运行，第 5 节结论基于 chunk 与字面量差集。
