# Ctrip-vbk-refact

携程旅游商家桌面客户端（vbooking，当前为 Electron 27）的重构项目，覆盖 Windows 与 macOS，Windows 优先。

当前阶段只做重构规划与原型，不包含真实的后端代码或前端 TS/JS 组件代码。

## 文档

| 文档 | 内容 |
| --- | --- |
| [01 架构选型](docs/01-architecture-selection.md) | 现有客户端拆包结果、Tauri 2 + Rust 与 C# + Swift 对比、目标架构、分阶段计划 |

## 当前结论

推荐 **Tauri 2 + Rust**：复用现有 Web 业务页面，Electron 专属部分（主进程、启动器、IM 伴随进程）收进一个 Rust 核心；先交付 Windows（WebView2），macOS（WKWebView）第二阶段跟进。

## 目录

```
docs/          设计文档
docs/images/   文档配图
```
