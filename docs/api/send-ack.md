# 发送回执完整性

2026-10-31。`send.ts::submitIntent` 仅匹配当前 `localid` 的回执；一次意图只调用一次 SDK，不叠加 HTTP 兜底。

`confirmed` 要求明确的整数成功码 0，且 `tid` 是非空字符串或可无损转换的非负安全整数。字符串长 ID 原样保留，不经过 Number。缺失/空白 tid、不安全数字 ID、缺失或畸形错误码均为 `unknown`；只有明确的非零安全整数错误码可分类 `rejected`。本地 fallback 时间不证明服务端时间，缺失时间的核验仍需权威读回。

`unknown` 只允许只读核验原意图，不能盲重发。此改动不实现持久 unknown reconciler，也不代表客户已读。官方 SDK 自身的兜底行为见 [transports](transports.md)。

`send.test.ts` 新增负向回归：修复前 `{error:0}` 被误判为空 ID 的 confirmed（6 通过/1 失败），修复后缺字段、畸形码、不安全数值均保持 unknown，长字符串 ID 无损通过，断言 SDK 一次、HTTP 零次。原始输出在本机 `/tmp/vbk-send-ack-red.tap` 与 `/tmp/vbk-send-ack-green.tap`，不入 Git。
