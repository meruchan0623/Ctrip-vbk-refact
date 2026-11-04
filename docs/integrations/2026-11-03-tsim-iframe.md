# TSIM 查询 iframe 接入

客户端参考 `trip_vendor_im_companion/runtime/page/operator-overlay.ts`：订单点击先由宿主核对账号、客户会话、订单修订及 TSIM 登录代次，再把临时授权保存在页面闭包内。查询页使用官方 `/embed/operator?source=travel-merchant-companion&session=handoff`，iframe 按整个视口布局，裁剪层跟随 TSIM 上报的窗口边界；右下套餐速览沿用插件卡片和贴边布局。

速览留在右栏正常布局中，底部与右侧贴边，高度约占可用视口六成，上方订单区可滚动，不用浮层覆盖订单字段。临时切换应用或浏览器标签保留当前查询；切换客户、账号和实际页面卸载仍清理 iframe。

令牌只应答固定 `https://csagent.tsim.tech`、当前 iframe、同一订单和 requestId 的 V2 `TSIM_OPERATOR_NEEDS_SESSION`。切换客户、账号、订单修订、TSIM 代次或工作台页面会销毁 iframe。每次打开建立新 iframe，旧页面无法接收新订单。iframe 加载完成后 8 秒仍未请求交接时保留页面内登录与关闭入口，并拒绝晚到的授权请求；网络加载耗时不占用交接窗口，请求到达后停止该计时。TSIM 页面自身的登录和查询结果仍以该页面为准。

## 尚未发布的配套改动

2026-11-03 本次通过 ego-browser 打开正式站并核对其实际入口资源 `assets/index-C4aMasmo.js`：线上父来源白名单仍只有 `null` 和 `file://`，会拒绝 Tauri 客户端发送的登录态。这是重复要求登录的已确认断点。

本地 `TSim_CS/agent-frontend/src/pages/operatorEmbedSession.ts` 已有未提交的来源兼容修复，接受 `tauri://localhost`、`http://tauri.localhost`、`https://tauri.localhost`，仍核对直接父窗口、订单和 requestId。相关 `operatorEmbedSession.test.ts` 的 8 项测试本次通过。这些现有修改不是本次新写；正式站尚未包含它们。

同目录 `2026-11-03-tsim-tauri-parent.patch` 已同步为当前本地兼容改动的可审阅 diff，仅包含父来源白名单及其测试。必须发布该前端兼容修复，再用正式打包客户端验证连续打开不同订单无需重复输入账号密码。普通 `localhost:端口` 开发预览不在白名单中。客户端不通过中转页面绕过来源校验。

用户本轮明确要求仅本地落盘、不发布正式服。本次没有执行远程命令、发布、提交或推送。线上生效和正式客户端免重复登录验收留待后续发布。

## 本地验证

`operator-overlay.test.ts` 使用离线 DOM 夹具检查错误 origin/source/requestId 不获令牌、授权过期及换会话销毁、超时拒绝晚到令牌、可见关闭入口和几何裁剪。`order-info.test.ts` 检查在途授权跨会话或登录代次失效。CSP gate 仅允许固定 TSIM iframe 来源，并有额外主机和通配主机的拒绝夹具。上述检查不代替 macOS WebKit / Windows WebView2 的第三方存储及正式服务器验收。
