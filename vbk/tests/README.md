# 跨模块验收（QA）

此目录归 QA 角色：跨 crate 的场景测试（`scenarios/`）与证据格式（`fixtures/`）。各模块的单元测试留在各自 crate / package 内；这里只放把 core-im → core-notify → 宿主快照串起来的端到端反例（强提醒 §7 验收表）。

证据文件只保存脱敏结构：无 Cookie、票据、客户标识或消息正文。
