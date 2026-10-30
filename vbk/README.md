# vbk — VBooking 网页 IM 桌面客户端工程

按 [开发总纲](../docs/dev/00-architecture.md)、[总和开发计划](../docs/plan/00-master-development-plan.md) 与 [独立强提醒设计](../docs/dev/03-strong-alert.md) 落盘的工程。范围只含网页 IM（消息、通知、订单“详情 → IM 联系”）和本项目自有能力（多账号、托盘、独立 alarm 窗、商家助手、截图/OCR、更新与诊断）。

## 结构

```
vbk/
├─ Cargo.toml                 Rust workspace（std-only 核心 crate）
├─ crates/
│  ├─ contracts/              身份、事件信封、错误、IM 事实、alarm DTO、最小 JSON（单写者：集成 owner）
│  ├─ core-account/           身份 actor、登录 attempt、session_generation 与迟到回调拒绝
│  ├─ core-store/             按身份隔离的最小持久状态（提醒 round、发送意图、同步水位）
│  ├─ core-net/               端点策略登记、SOA 响应分类、ClockService、对账信号
│  ├─ core-im/                跨来源去重、同步水位、SendIntent/outbox、等待轮次
│  ├─ core-notify/            L0–L4 升级、稍后提醒、勿扰、alarm 快照
│  └─ core-assistant/         TSim 身份/出站翻译/套餐速览客户端（请求构造与响应解析）
├─ src-tauri/                 Tauri 2 宿主（独立包；需 Windows + WebView2 + crate 注册表）
└─ ui/
   ├─ packages/ipc/           contracts.ts（Rust 镜像）、命令/事件名、invoke/listen 薄封装
   ├─ packages/web-adapter/   网页 Web IM SDK/HTTP 契约适配：有界事实事件、轮询、补偿、上传签名
   ├─ packages/ui-kit/        无依赖 DOM 渲染与状态工具
   └─ apps/{main,alarm,setting}/  各窗口入口
```

## 本地检查

本仓库的云检查环境没有 crate 注册表、npm 注册表与 WebView2，因此：

- Rust 核心 crate 只用 `std`；`cargo test` 在 `vbk/` 下直接可跑。
- TypeScript 不引第三方依赖；`tsc`（全局 6.x）做类型检查，`node --test` 直接运行 `.ts` 测试（Node ≥ 22.18 的类型擦除）。
- `src-tauri/` 被排除在 workspace 之外，在 Windows 目标机上用 `cargo tauri build` 构建。

```bash
cd vbk && cargo test
```

```bash
cd vbk && npm run typecheck && npm test
```

## 不变量（所有模块共同遵守）

1. 身份不随界面漂移：`AccountContext{account_id,environment,session_generation}`；旧代次回调一律拒绝。
2. 外发不是普通重试：`confirmed/rejected/unknown` 分开；`unknown` 持久保留并对账，不盲目重发。
3. 可见最新不等于完整：页断点与完整水位分离；只有证实终止条件才推进完整水位。
4. 提醒消费事实：已读、打开会话、点击发送、发送中、结果未知都不能结束等待轮次；只有服务端确认的有效商家回复、会话结束或转出才清除。
5. 持久化先于成功事件；先订阅缓冲再取快照重放；跳号/换 epoch 必须重新握手。
6. 远程页面无通用本机权限；日志与提醒数据不含凭据与客户正文。
