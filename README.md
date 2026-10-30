# Ctrip-vbk-refact

携程旅游商家桌面客户端（vbooking，当前为 Electron 27）的重构项目，覆盖 Windows 与 macOS，Windows 优先。

当前阶段只做重构规划与原型，不包含真实的后端代码或前端 TS/JS 组件代码。

## 文档

| 文档 | 内容 |
| --- | --- |
| [01 架构选型](docs/01-architecture-selection.md) | 现有客户端拆包结果、Tauri 2 + Rust 与 C# + Swift 对比、目标架构、分阶段计划 |
| [02 现有客户端缺陷](docs/02-current-client-defects.md) | 官方客户端在 Windows / macOS 上的卡顿与安全缺陷，Electron 去留结论，复用范围修正 |
| [03 副窗口](docs/03-multi-window.md) | 官方副窗口清单（IM 倒计时、横幅、截图等）与 Tauri 实现方式 |

## 当前结论

推荐 **Tauri 2 + Rust**，彻底弃用 Electron：远程加载的 vbooking 业务页原样复用，本地打包的 IM 等窗口重写，主进程能力收进一个 Rust 核心；先交付 Windows（WebView2），macOS（WKWebView）第二阶段跟进。

## 目录

```
docs/          设计文档
docs/images/   文档配图
```
