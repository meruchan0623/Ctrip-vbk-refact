# 发送回执完整性

2026-10-31。`send.ts::submitIntent` 仅匹配当前 `localid` 的回执；一次意图只调用一次 SDK，不叠加 HTTP 兜底。

`confirmed` 要求明确的整数成功码 0，且 `tid` 是非空字符串或可无损转换的非负安全整数。字符串长 ID 原样保留，不经过 Number。缺失/空白 tid、不安全数字 ID、缺失或畸形错误码均为 `unknown`；只有明确的非零安全整数错误码可分类 `rejected`。本地 fallback 时间不证明服务端时间，缺失时间的核验仍需权威读回。

`unknown` 只允许只读核验原意图，不能盲重发。此改动不实现持久 unknown reconciler，也不代表客户已读。官方 SDK 自身的兜底行为见 [transports](transports.md)。

`send.test.ts` 新增负向回归：修复前 `{error:0}` 被误判为空 ID 的 confirmed（6 通过/1 失败），修复后缺字段、畸形码、不安全数值均保持 unknown，长字符串 ID 无损通过，断言 SDK 一次、HTTP 零次。原始输出在本机 `/tmp/vbk-send-ack-red.tap` 与 `/tmp/vbk-send-ack-green.tap`，不入 Git。

提交验证更正：`3a9dcda` 的提交正文误写独立全量 TS191 通过；该次实际为190通过/1失败，bundle因 `&&` 未执行。失败来自旧 `send.review.test.ts` 对畸形码强制 rejected 的契约。后续提交保留全部8个输入和明确错误码的逐字段断言，将缺证据分支要求改为 unknown，并增加每意图一次SDK、零HTTP重试、fact一致与监听器/计时器清理断言；没有删除或跳过测试。历史不重写，重新验证输出另行记录。

SDK Promise 回执桥同样必须在数字转字符串前验证 ID：`sdkGlue.ts::idStr` 只接受非空字符串或非负安全整数。`sdk-boundary.test.ts` 通过真实 createPageSdk→submitIntent 链路证明不安全数值不会被桥接成 confirmed；长字符串保持精度。修复前负向测试失败，修复后通过。
