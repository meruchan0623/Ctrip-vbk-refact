# 页面 SDK 生命周期边界

2026-10-31。`createPageSdk.dispose()` 后，`sendMessage` 与 `putAdviceOfReadByMsgId` 在调用官方 SDK/HTTP 前立即拒绝，错误明确为 disposed / nothing sent。不能因为仍持有旧 facade 或房间 JID 就继续出站。

`sdk-lifecycle.test.ts` 直接构造真实 glue，dispose 后尝试发送与已读，要求两种官方写入计数均为零。修复前未抛异常且发生调用；修复后通过。原始红/绿输出为本机 `/tmp/vbk-sdk-boundary-{red,green}.tap`。

这是最后一层失效保护。页面 session 等待历史/候选请求时仍须捕获运行代次，停止或重新开始后在真实提交前拒绝旧请求；该上层接线按独立变更验收。本页不声称已解决所有账号切换或全部生命周期行为。

## 单聊身份的组合层接缝（2026-10-31）

createAdapter的角色代理必须同时代理roleOf与明确的selfUid；只转发roleOf会让单聊地址解析无法确认哪一端是本人，事实被保守丢弃。selfUid使用动态getter，使setRoles后的身份同步变化，不依据角色覆盖表猜本人。真实createAdapter→SDK回调→AdapterBridge.invoke回归：旧代理3通过1失败（消息gid为undefined），补齐后4/4；覆盖初始与替换身份入站及替换后的本人出站；独立副本把动态身份改为静态旧值，新增出站断言实际失败（self-b不等于customer），恢复getter后通过，既有群聊及stop/restart断言保留。此接缝修复不等于第2轮原生W缺失的根因已证实。
