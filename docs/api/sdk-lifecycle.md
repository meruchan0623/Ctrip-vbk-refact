# 页面 SDK 生命周期边界

2026-10-31。`createPageSdk.dispose()` 后，`sendMessage` 与 `putAdviceOfReadByMsgId` 在调用官方 SDK/HTTP 前立即拒绝，错误明确为 disposed / nothing sent。不能因为仍持有旧 facade 或房间 JID 就继续出站。

`sdk-lifecycle.test.ts` 直接构造真实 glue，dispose 后尝试发送与已读，要求两种官方写入计数均为零。修复前未抛异常且发生调用；修复后通过。原始红/绿输出为本机 `/tmp/vbk-sdk-boundary-{red,green}.tap`。

这是最后一层失效保护。页面 session 等待历史/候选请求时仍须捕获运行代次，停止或重新开始后在真实提交前拒绝旧请求；该上层接线按独立变更验收。本页不声称已解决所有账号切换或全部生命周期行为。

## 单聊身份的组合层接缝（2026-10-31）

createAdapter的角色代理必须同时代理roleOf与明确的selfUid；只转发roleOf会让单聊地址解析无法确认哪一端是本人，事实被保守丢弃。selfUid使用动态getter，使setRoles后的身份同步变化，不依据角色覆盖表猜本人。真实createAdapter→SDK回调→AdapterBridge.invoke回归：旧代理3通过1失败（消息gid为undefined），补齐后4/4；覆盖初始与替换身份入站及替换后的本人出站；独立副本把动态身份改为静态旧值，新增出站断言实际失败（self-b不等于customer），恢复getter后通过，既有群聊及stop/restart断言保留。此接缝修复不等于第2轮原生W缺失的根因已证实。

## SDK绑定健康与修复（2026-10-31）

全局xmppClient被删除、替换为非Emitter或访问抛错时，旧绑定不再算attached/connected并会解除；正常新client替换继续换绑。只在官方已核实的listeners(event)接口证明本glue自有hook缺失、且全部hook可移除时重绑，不碰官方监听者。接口缺失/抛错返回unsupported诊断，不假装已验证，也不盲目重复监听或把兼容SDK全判离线。

bindingDiagnostics只读输出global_state/listener_health/attached/can_rebind/generation/attach_count/repair_count等固定枚举布尔计数，不包含UID、正文、URL、令牌或原始异常。依据当前官方SDK source0.js EventEmitter.listeners @151349；当前窗口client是否发生此缺口需新包取证，不声称第2轮W根因。

真实createPageSdk故障回归5项全红，修复health7及既有SDK矩阵共74通过；独立评审额外在待ACK发送期间修hook，官方写1/最终ACK1，自有stanza/status各1；旧排队事件/dispose后回调不外发。原始证据/tmp/vbk-goal-20261031/sdk-binding-health-{red,green}.tap。实际第3轮SDK/页面仍为运行依赖，不是无浏览器传输实现。
