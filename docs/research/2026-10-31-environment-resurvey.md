# 环境重勘与示例项目定位

日期：2026-10-31，Asia/Singapore。用户重新布置环境后重新采证；先前“插件载荷缺失”的结论已失效。

## 当前环境

- 官方 `/Applications/旅游商家桌面版.app`：版本 1.2.12，`CFBundleExecutable=TripVendorLauncher`。Launcher、官方进程、助手、WindowHelper 均运行。
- 插件回执版本 0.7.5；助手运行日志应用版本 0.3.2。日志已见 `panel-mounted`、`attached=true`、`composerSource=verified-editor`，证明实际挂载。
- 助手日志在本地 02:07:40 曾出现 TSim auth ready；02:08:58 及 02:09:58 出现 auth failed/phase failed。认证最新健康仍需重验，不能把挂载成功算成 TSim 功能通过。
- CUA 按官方及助手准确应用路径连接均 `timeoutReached`；当前原因未确定。原生视觉/操作尚未通过，不能归因于插件未安装。
- ego-browser TaskSpace 1 的 p1 官方网页可读，登录有效，受控订单侧栏可见。出站测试仍仅授权订单 `1359049237105048`、客户 `_tihk******doml43`。
- 自制客户端原生界面可读，仍显示旧版本“发送中”和禁用操作；运行路径为 `vbk/release/macos/VBooking 商家客户端.app`。

## 源码与验证基线

- 分支 `feat/prototype-restore-macos`，HEAD `00efc7408ff7d7f766f96d6ad2fefae2a6f05911`。重勘开始时 24 个已跟踪改动、5 个未跟踪文件，暂存区为空；这些是上一轮未提交成果，不得当成干净基线覆盖。
- Node 22.14.0，npm 10.9.2，cargo 1.95.0。Node 低于项目 engines 22.18；当前运行 TS 测试需要 `--experimental-strip-types`。
- `npm run typecheck` 通过。
- `node --experimental-strip-types --test --test-reporter=tap 'ui/**/*.test.ts'`：202 passed / 0 failed / 0 skipped / 0 todo。
- `cargo test --workspace --quiet`：300 passed，0 failed/ignored。
- `cargo test --manifest-path src-tauri/Cargo.toml --quiet`：58 passed，0 failed/ignored。
- `git diff --check` 与空暂存区 `git diff --cached --check` 通过；后者不代表任何功能已审阅可提交。
- `npx tauri build --target aarch64-apple-darwin --config src-tauri/tauri.macos.conf.json` 已实际完成 app/dmg 构建；未替换运行程序，也未作真实收发验收。后续源码变化须重新构建。
- 运行旧二进制 SHA256 `d4f34198c30df202e8eed5fc2549aa77f58dedaf20a83ced234145d51514a5fa`；新构建二进制 `4b4e74b49c75273b31cd82779a65bcb6f7deeed44b382d49bb3e9cb0010e7208`。两者不同。
- 新产物在 `vbk/src-tauri/target/aarch64-apple-darwin/release/bundle/{macos,dmg}/`。

## 已知缺陷与证据边界

- 独立评审最小离线复现：`rpc.ts` 历史加载重建会话未传 UnreadBook，真实 unread=3 被推为0；服务端仍返回3时 changed_gids=[]；UI 因0可能跳过已读回执。此缺陷尚未修复，必须新增失败回归再修复。
- `peripheral.ts` 已实现五组周边API函数，但 RPC/IPC/host/UI 尚未接线；不能计为功能完成。
- 本轮未发送消息、未修改官方安装、未重新注入插件、未修改 TSim_CS、未创建提交。
- 原始接口数据仅在本机临时目录，不提交正文、凭据或带签名的资源URL。

## 未来 TSim_CS 接入的依据

只读核对 `/Users/tashima_meru/Develop/TSim_CS`：KKday 通过 `central-backend/consumer_workspace` 在线轮询、发送并持久化 attempt；respond.io 通过 webhook/API 接入 Customer/Conversation/Message。检查范围内未发现携程在线接入，不能把历史语料导入当实时渠道。

优先参考路径（相对 TSim_CS）：

- `central-backend/consumer_workspace/api/routers/kkday_consumer_workspace.py`
- `central-backend/consumer_workspace/services/kkday_outbound_dispatcher.py`
- `central-backend/consumer_workspace/services/kkday_confirmation_reconciler.py`
- `central-backend/consumer_workspace/models.py`
- `central-backend/api/routers/respondio_workspace.py`
- `central-backend/services/respondio_inbound_service.py`
- `central-backend/services/respondio_message_reconciliation_service.py`
- `agent-frontend/src/modules/AuthenticatedApp.tsx`

示例项目交付应覆盖平台账号与客服身份、上游会话/消息ID和本地ID、入站游标与去重、发送幂等与回执、unknown只读核验、附件和订单关联、权限、生命周期、可观测和恢复契约。清晰分开平台数据层、Tauri宿主及界面；保留必须依赖官方页面/SDK的事实，不虚称无浏览器运行。对全平台其余客服能力列证据矩阵和迁移步骤，本轮不直接实施 TSim_CS 生产接入。

用户新增要求：边实现、边按独立行为提交、边更新文档。每块提交应包含完整实现/契约/测试/直接说明；采用中文 Conventional Commit 标题及正文。仅本地提交，推送和部署另需明确授权。
