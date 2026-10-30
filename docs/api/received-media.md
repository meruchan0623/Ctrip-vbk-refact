# 收到的图片、视频与文件

2026-10-31。沿用官方HTTP/SDK原始消息对象的已采证结构：图片url/thumbUrl，视频video.url及cover/thumbUrl，文件file.url/filename。mapper输出独立media_url/media_thumbnail/media_filename，IPC与宿主DisplayCache保留字段，UI不把文件名当URL。服务端消息ID全程字符串。

图片显示缩略图并可打开原图；视频使用原生controls及poster；文件按钮由宿主受限HTTPS外链命令打开。safeMediaUrl拒绝非HTTPS与凭据URL，HTML/Tauri两层CSP保留，宿主外链仅允许ctrip.com、c-ctrip.com、tripcdn.com、trip.com、tsim.tech及其子域，拒绝非默认端口/凭据/伪后缀。图片加载失败保留明确占位；视频错误由原生controls呈现，文件由外部浏览器处理。

整页重绘仅复用环境、账号、认证代次、会话、server/local命名空间ID与src完全相同的视频节点；缺身份或换账号不复用。防止等待计时器重绘不断重启播放。

独立回归：真实HTTP/SDK mapper→实际messageRow六项；临时去掉mediaFields投影六项全红，恢复六项绿。实际render/subscribeBatched跨scope复用两项及现有CSP四项通过。真实Rust DisplayCache→序列化字段保留测试另以漏media_url反向证明。原始日志在/tmp/vbk-media-contract-*.log及/tmp/vbk-goal-20261031/media-host-{red,green}.log。

第4轮原生既有0.8秒视频已见Pause/进度0.31，证明短片可播放；未证明长视频连续播放或媒体出站。附件上传/发送仍未完整接线，按钮明确阻断，不能把收到媒体的显示能力冒充双向媒体完成。签名URL仅内存/本机临时证据，不进Git。
