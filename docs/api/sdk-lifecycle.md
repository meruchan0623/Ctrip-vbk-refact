# 页面 SDK 生命周期边界

2026-10-31。`createPageSdk.dispose()` 后，`sendMessage` 与 `putAdviceOfReadByMsgId` 在调用官方 SDK/HTTP 前立即拒绝，错误明确为 disposed / nothing sent。不能因为仍持有旧 facade 或房间 JID 就继续出站。

`sdk-lifecycle.test.ts` 直接构造真实 glue，dispose 后尝试发送与已读，要求两种官方写入计数均为零。修复前未抛异常且发生调用；修复后通过。原始红/绿输出为本机 `/tmp/vbk-sdk-boundary-{red,green}.tap`。

这是最后一层失效保护。页面 session 等待历史/候选请求时仍须捕获运行代次，停止或重新开始后在真实提交前拒绝旧请求；该上层接线按独立变更验收。本页不声称已解决所有账号切换或全部生命周期行为。
