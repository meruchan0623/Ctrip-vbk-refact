# 第九批：语音消息与搜索/恢复文案

状态：本批代码与整树检查通过，通用 macOS 包构建进行中；完整目标未完成。继续只写隔离副本。

## 语音消息

Web SDK 的 AudioMessage=4 和 btype=4/audio 对象已静态核实，证据见 sdk-facade.md。修复前类型 4 被当作 control 并在显示映射中丢弃，播放器未接主窗。本批已接通 business fact、audio DTO/宿主缓存、消息行和单一播放器。只接受严格 SDK 模型、现有 HTTPS 域名约束、无未知 secret 的可识别明文格式；其余仍保留消息行并明确无法播放。

不使用 wire duration/size 猜测单位，只读取媒体元素的有效时长；仅显式点击才创建加载，不解密、补鉴权、读取 Cookie、转码、自动重试或新增持久化音频 URL。切账号/环境/代次/会话、移除消息与卸载时须停止；迟到 play 回调不能污染新状态。代码与本地回归不替代网页入站样本、macOS/Windows 实际播放验收。

## 搜索与恢复文案

server-search.ts 与 _shared/recovery.ts 已迁移 76 词条，两模块 CJK=0。独立 24/24；还原 81 处 t 调用后，两文件控制与数据 AST 与真实基线一致。查询、分页、时间格式、上下文、恢复终态、确认 ABA 和诊断错误边界保持；原专项测试未修改。基线与精确补丁在 vbk/.runtime/round9-search-recovery-i18n*。整树前端 1442/1442、宿主 385/385、typecheck、严格 Clippy、UI 构建与发布扫描通过。门禁夹具 203/203，6 项现有门禁零违规；CJK 审计仍为独立报告，不代表全树文案已迁完。

## 尚未具备的验收

用户已授权再次替换消失的空间 3；ego-browser 空间 5/p1 已建立，设置页截图可正常显示，主窗演示账号与会话列表加载正常。该页面明确标记未连接宿主，不作为真实账号或原生验收。第八批原生回调平台矩阵、可信入站文档能力、正式签名和安装/升级等仍未完成，不能由本批局部测试推导完整通过。

## 独立复审与测试边界

音频与 client cleanup 的独立普通正确性复审通过：9 文件 82/82、分类矩阵 6/6、宿主 display 32/32。client cleanup 统一收敛同步异常、异步拒绝与延迟订阅清理，保持幂等。根代理整树 typecheck 发现测试中 deepEqual(events, []) 导致 never[] 收窄；改为 length===0 后类型检查通过，独立单文件 6/6，点击前零操作及资源释放断言完整保留。未执行真实音频请求。

第八批底层代理被自动安全检查以“可能涉及网络安全风险”停止；根代理接手常规本地代码核对及现有项目测试。独立 reviewer 后续仅普通只读正确性复核，原外部探测脚本未重跑。vendor 严格 Clippy、56 Rust + 28 JS 与 boot 14/14 通过，不宣称真实 WebContent 故障矩阵通过。

## ego-browser 本地演示验收（空间5/p1）

设置与主窗截图：`.runtime/round9-settings.png`、`round9-main.png`。主窗会话消息、输入区、订单侧栏已可见。第一次基于瞬态ref点击超时；后续语义点击与等待后会话打开，不能把工具动作返回当作渲染完成。标注场景首次导航出现空白，原空间reload后恢复；所采Runtime异常列表为空，未证明所有启动条件均无故障。

`?scenario=annotation` 使用明确合成128×96图片，六工具可见。马赛克拖动改变8280个像素通道值，撤销后与原图差异0，重做恢复8280。确认后显示“演示标注.png”附件草稿，不自动发送；本次未点击发送、未执行原生截屏或保存。截图`.runtime/round9-annotation.png`。默认场景截图/选择附件原stub不完整，正在改为明确unsupported，不能把畸形返回当作成功演示。

通用构建首次已完成arm64与Intel主程序编译/合并，但bundle缺`vbk-browser-bridge`通用二进制而失败，正在补可重复构建入口。当前不宣称已有可用通用安装包。

## 本轮收尾修复

默认演示截图与本地附件选择现返回明确HOST_UNSUPPORTED，不再返回无法通过归属校验的两字段假附件；专用annotation合成注册保持。专项12/12，随后整树前端1446/1446、typecheck及门禁通过，构建工具专项7/7另计。此处1446优先于前述1442。

`npm run build:macos:universal` 新入口已独立普通复审通过（7/7）：脚本相对根路径、固定target目录、两架构bridge显式构建与lipo、打包前后主程序/bridge双架构检查；失败退出，只清理本目标生成app，显式不签名、不安装、不发布。真实构建进行中。

默认媒体演示的独立复核4/4通过，实际生产bundle排除mock数据与新增演示说明。开发页在后续导航又出现超过30秒空白，未观察到Runtime异常；显式本地模块import成功后恢复，但原因未定位，保留为开发浏览器启动待查问题，不据此证明原生启动通过。

## 最终本地候选（2026-11-03）

通用入口实际执行通过，包内两个可执行文件均核实x86_64/arm64；包51,315,943字节，identifier `tech.tsim.vbk.client`。路径 `vbk/src-tauri/target/universal-apple-darwin/release/bundle/macos/VBooking 商家客户端.app`。主程序SHA256 `fa90a57cd5aacee71adbfb1d91807f1bec5fbfd7d08932b225f6507dc4764866`；bridge SHA256 `512cc3ed86a899312628f822347cfc41c99161d44349fe19172012d1791ced7e`。`.runtime/round9-app-manifest.json`、`round9-app-release-scan.json`记录本次产物，扫描通过。显式--no-sign，未正式签名、公证、安装、发布或替换运行应用，不代表Intel实机或干净安装验收。

默认场景最终通过ego-browser读到“失败：演示模式不提供系统截图；请在客户端中使用。”；主窗短提示链已实际验证。上述空白开发页现象仍保留定位，不用恢复后的成功掩盖。完整目标继续。

本批冻结源码以`.runtime/round9-source-manifest.json`和实际`.runtime/round9-source-snapshot.tar.gz`保存，包含当前隔离副本的保留改动；不包含依赖、构建输出、运行时目录或用户profile。归档清单和每个成员哈希在生成后读回验证；具体校验见`.runtime/round9-source-archive-receipt.json`。
