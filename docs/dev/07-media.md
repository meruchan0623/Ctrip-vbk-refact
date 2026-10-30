# 07 媒体工具

2026-10-30。本项目自有能力，保留。

- 网页消息附件（图片、文件、视频）按目标网页开放的类型实现，上传成功不等于消息发送成功。
- 截图：多屏遮罩、矩形/椭圆/箭头/文字/画笔/马赛克、撤销重做、确认插入输入框、另存为；全局快捷键。
- 图片/视频查看器；OCR 提取文字（引擎与安装身份需原型确认）；中文错别字检查。

2026-10-30 落盘：仅网页附件上传链路已实现（`vbk/ui/packages/web-adapter/src/upload.ts`：图片 `uploadTokenCreate` + Nephele 授权串与 Content-MD5、文件 `channel=im&public=1`、视频 v3 上传 + proc；上传成功只返回 `MediaRef`，不等于消息发送）。截图、查看器、OCR、纠错在界面上只有入口按钮与宿主命令占位，未实现。

详细设计沿用[归档正文](../archive/desktop-baseline/dev/07-media.md)。
