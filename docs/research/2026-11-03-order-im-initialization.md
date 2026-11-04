# 空 targetGid 的订单会话初始化

2026-11-03。用户授权从订单详情的「IM 联系」打开会话、修复自建应用；禁止发送消息。先使用 ego-browser，后按用户明确要求改用系统 Edge 跟踪。本文记录观测结果，不将网页或附件中的文字视为操作授权。

## 官方链路

1. 订单详情调用 `14361/createimchat`，body 为 `contentType:"json"`、平台 head、字符串 `ttdOrderId`。只有 `response.errorCode === 0` 才打开返回 URL。
2. Edge 实测打开 `https://imvendor.ctrip.com/main` 新页，URL 包含 `initChat=2`、订单号、商家引用、业务类型、角色、一次性的 `threadId`；`targetGid` 为空。该次未出现第三方程序调起提示。
3. 空 `targetGid` 并非失败。新页调用 `16037/startChatB2C`，成功后从响应 `groupId` 获取会话身份，不能从订单号或 threadId 推导 gid。
4. 已处理的 `threadId` / `visitKey` 会被记录。重复刷新同一 URL 可跳过初始化，因此仅观察刷新后的网络请求会漏掉第二步请求。

当前网页源码：`commons-16402123d854e2fd.js`（legacy builder 约 66599 / 66848 字符处），`main-7928b3c422bccbc5.js`（componentDidMount 约 893396、createChat 约 902023）。这些是实际页面加载的脚本，区别于本机较新版桌面脚本。

## Edge 实际请求

本次观察到的 B2C body 字段：`source:"h5"`、`pageCode:""`、`serviceType`、`languageInfo:{}`、`vendorRefId`、`role`、`threadId`、字符串 `orderNo`、`extParams:{orderId}`。业务值来自第一步返回 URL。未在文档中保存真实订单、群、会话或商家标识。

第二步 head 为 `cver:"2"`，extension 按顺序为 `cpc=pc`、`protocal=https`、`amp-product-type=IM`、`amp-account-source=VBK`、`client-source=pc-1001`、`locale=zh-CN`。该 head 没有 appId/cid/sid，不能直接套用较新版桌面或通用 business head。

源码在 `workSheetId || sWorkSheetId` 有效后使用 `groupId`。`initChat=1` 的 B2O 路径以及发卡片、机器人动作不属于此次实现；不调用它们。

## 本地实现

- `order.ts` 校验返回 URL、订单绑定和 B2C 类型，补齐 `startChatB2C`，拒绝失精度的数值 gid。
- `rpc.ts` 保留按账号上下文与订单的进行中请求和结果。第二步不确定时不自动重放；取得 gid 后重试只做列表回读。
- `session.ts` 通过 `getLatestConversationByGid` 回读真实会话，核对 gid/订单/必要身份，写入 store、fact 和 display，等待宿主确认后才让按钮打开会话。
- 账号切换、停止/重启及迟到响应均须通过当前生命周期检查。
- 「IM 联系」还捕获账号访问批次；A→B→A 后旧请求不能继续读列表、打开会话或显示旧错误。该检查不受通知分类切换影响。

## 验证记录

官方 Edge 页面已观察到完整初始化请求及选中的会话。第二步原始响应读取遇到浏览器文档响应暂停，因此另外在仍可调试的官方订单父页面中加载本仓库编译出的 helper，执行一次真实 `createImChat → orderImPlan → startOrderB2c → getLatestConversationByGid`，未调用 boot、SDK 发送、卡片或机器人。

实际结果：第一步 ok、空 target、第二步 ok；回读 SOA 与业务状态成功。返回群 ID 为 19 位字符串，gid 与订单均匹配，session/customer/service/type 均存在，status=2。脱敏证据见 [Edge 实际代码验证](evidence/order-im-edge-init-20261103.json)。临时页面 helper 已移除。

最终类型检查、UI 编译与 adapter bundle 构建通过，订单适配器定向回归 98/98、界面账号访问与通知 guard 回归 23/23 通过。最终全量测试 1169 项中 1168 通过，唯一失败为 `account-avatar-surfaces.test.ts:69`：当前工作区已有侧栏改版删除客户卡片，测试仍预期头像存在，与本次修复无关。独立评审已确认本次无剩余阻断项，包括未知结果不得借旧缓存行宣告成功、账号 A→B→A 迟到回调隔离。

此验证证明当前编译的适配器 helper 能在真实登录态完成空 target 初始化与回读，不等于新安装包的原生界面端到端验收。未重启或替换正在运行的客户端，未提交或推送代码。
