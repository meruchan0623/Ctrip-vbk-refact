# 契约证据检查记录

2026-10-30。检查范围是本轮采集器、脱敏证据和生成文档，不是全接口、独立宿主或产品验收。

## 独立审查与修复

独立只读审查发现并复核修复了三项实际问题：

1. 消息 ID 作为动态 JSON 对象键时绕过了值脱敏，且会进入 schema 与占位符路径。现使用随机盐 HMAC 引用，旧证据的键、路径、properties、observedKeys 和 JSON 字符串同步处理。
2. 独立 headExtension 副本遗留 vid/pvid/sid。现与请求体统一使用严格协议常量白名单，非白名单字符串和数字均转成保留原始类型的占位符。
3. 只按请求体去重会吞掉 Cookie 省略的失败分支。现将 Header、ExtraInfo、HTTP/Ack/业务错误也纳入分支键，保留失败样本；requestElementsCaptured 按全部样本 any 判断，不因最后一条不完整请求覆盖有效观测。

独立复审当时扫描了 60 份 JSON、核对 1,660 组模板/schema，以上三项通过；该快照不是后续新增证据的独立验收。之后新增材料继续使用修复后的采集器，并以当前证据执行下面的自动检查。

## 最终本地检查

命令与实际终端输出保留在当前聊天；结构化结果见 [review-checks.json](review-checks.json)。

```bash
python3 tools/contracts/sanitize_evidence.py
python3 tools/contracts/audit_evidence.py
python3 tools/contracts/build_catalog.py
node --check tools/contracts/capture-support.mjs
python3 -m py_compile tools/contracts/build_catalog.py tools/contracts/sanitize_evidence.py tools/contracts/audit_evidence.py
```

最终检查覆盖动态键、标识 scalar、Cookie/Authorization/风控头、非协议扩展、嵌套对象、数组各结构分支及 JSON 字符串内部结构。不可取得的 schema 节点明确统计并跳过，不把 OPTIONS、缺失响应或旧的不完整采集当作成功。

文档链接另作本地存在性核对。所有接口 implementationReady 仍为 false；检查通过不改变用户要求的 G0，也不掩盖 [readiness.md](readiness.md) 中的未验证内容。
