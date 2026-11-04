# 第十六批：正文草稿与真实浏览器消息列表基线

状态：代码、限定独立复审、候选构建与浏览器证据复核通过；完整目标继续。仅隔离副本。

用户已明确本轮不需要提供受控业务账号，按官方机制、已有逆向证据与本地回归推进，见[本轮验收决定](../decisions/2026-11-04-reference-led-validation.md)。后续新委派主要使用Luna/max；不将本地结果称为真实业务收发验收。

## 正文草稿

1. 缺账号上下文时，原IPC端口直接返回，让DraftBook误判保存成功并删除dirty。现load/save明确失败，保持正文及清空记录待保存；账号恢复后重新取得当前代次再保存。独立15/15覆盖账号移除、重登generation2、A/B切换、空稿不丢与本地编辑优先。
2. 原load畸形回复可静默视为空快照，save缺有效version仍被视为ACK。现在校验必需字段和非负安全整数版本，允许合法附加字段及清空version=0；完整load验证成功后才原子替换该账号的版本缓存，失败不部分推进。CAS明确冲突仍只重读重试一次，畸形回复不触发写重放。
3. 新增并发清空回归：旧版本1遇冲突，合法空快照清除该账号旧版本，第二次以0保存成功；另一账号的已知版本7保持。Luna/max独立19/19通过，原缺上下文回归保留。

真实before分别在vbk/.runtime/round16-draft-context-baseline与round16-draft-reply-baseline。最终前端1505/1505、typecheck、203夹具和7项门禁通过；日志/tmp/vbk-round16-final-ui-tests.log。宿主代码本批未改，沿用上一批402项证据，不称本轮重新执行宿主回归。

现有“重启10/10”是内存对象重建，不是独立进程。公开宿主正文API共享附件层，本轮未扩展该验证边界，因此没有新增原生/独立进程草稿重启通过声明。

## 真实Chromium布局

通过ego-browser在获授权替代空间6/p1操作固定快照，来源为vbk/.runtime/round16-browser-ui，端口4186。旧4185测试server已停止。fixture仅截获mock IPC输入，没有替换主窗渲染器或克隆分页算法；真实main入口及历史按钮每页最多30条，334次读取装载10,000条消息。其代码与证据位于vbk/.runtime/round16-browser-fixture/。

- 底部视口仅挂载12行，中段约20行，实际截图10k-middle.png已查看。
- 中段30条burst到达后，阅读行不变、记录的像素偏移不变。
- 两轮各30条逐帧新消息，可视行ID及取整后的偏移稳定；不外推亚像素不动或stored anchor每次都不变。各60次滚动均完成。
- 1920×762到1440×900的临时缩放保持同一阅读行，取整后的偏移变化0px；存储anchor偏移约变化0.125px，不声称绝对零。
- 合成文本含customer及disposition=null的merchant_self，后者界面显示发送中；这不是官方正常已发送历史的样本。

测量为操作发出至下一requestAnimationFrame的墙钟时间，不是render CPU、实际paint时间或原生性能：

| 样本 | 新消息p95 | 滚动p95 | 同步dispatch p95（新消息/滚动） |
| --- | --- | --- | --- |
| 第1轮 | 167.7ms | 76.3ms | 3.4/5.7ms |
| 第2轮 | 115.9ms | 75.1ms | 3.2/4.5ms |

空闲RAF另测30样本，p50约33.4ms、p95约41.7ms；环境并非60Hz。真实浏览器读回UA为Chrome156，visible，1920×762、DPR2，记录于environment.json。CPU采样显示idle/program/GC、captureMessageAnchor及周边树morph等混合开销，没有据此盲改数据结构。I-28的16ms只是原计划基线指标，本轮不宣称达到；未覆盖WKWebView、WebView2或全部媒体布局。首个长evaluate超过15s工具时限，有可能迟到执行，因此该次结果不计性能证据；后续短批次均complete并逐批落盘。

## 刷新异常

长evaluate超时后，正常reload两次出现document complete但app空、入口未初始化。手动import入口能够启动；经Page.reload ignoreCache后，普通CDP reload及最终wrapper reload均成功。原因尚未定位，不称产品修复，也不把空白现象隐去；全部操作仍在同一ego空间。后续性能结果来自重置后重新合法分页装入的夹具。

当前浏览器快照先于严格草稿reply校验，仅用于未改动的消息窗布局验证。最终源码与候选包以本批构建完成后的记录为准；未安装、签名、发布或发送真实业务消息。

本批构建使用的产品源码相对第十五批归档仅改draft-book.ts及其测试；精确差分为.runtime/round16-draft-final.patch，SHA256 5862d5d02e64cbf68817fca49fb8a175a6f34e22e25834491e6ad42a011b238b，前后摘要为.runtime/round16-source-delta.json。UI发布扫描clean（.runtime/round16-ui-release-scan.json）；原生最终构建session99730 exit0；包体51,314,807字节，包内两个程序均arm64+x86_64；最终app发布扫描clean（.runtime/round16-app-release-scan.json）。产物manifest为.runtime/round16-app-manifest.json，已核全部原vbk源码摘要、两文件差分摘要及没有其他新增/删除vbk源文件。未签名、安装或发布。

Luna/max完成浏览器证据限定复核：原始数据统计与摘要一致，分页真实路径与334次计数成立；结论仅为该合成场景的浏览器逻辑/可视锚点通过，性能仅基线。
