# 宿主发送持久屏障

2026-10-31。实际im_send_text调用outbound_journal::send_once，账本位于app_data/state/outbound，按environment/account命名空间隔离。同local_id跨登录代次仍是同一意图，generation只作审计；gid/text/original/quote_id按固定结构算SHA256用于冲突校验，正文不落盘。不同payload重复local_id拒绝。

调用链先持久write_started并完成文件及父目录fsync，之后才允许单次dispatch。fs2文件锁串行化读/CAS/commit/barrier，不跨await持有。恢复看到write_started或unknown只能读回unknown，不能重新dispatch；已持久confirmed/rejected读回终态。提交前存储失败不调用dispatch，发起后的任何回执或持久化失败保守unknown。同一进程及重新打开FileStore均不能解除屏障。

write_started是宿主准入屏障，不能证明网络包已真正发出：dispatch内若在发起前报错也保守unknown。禁止以此自动重试。账本不包含正文或original；拒绝reason可能回显正文，因此磁盘只保留code及固定通用说明，原reason仅当次返回UI，重启读回通用说明。

主界面“未知发送核验”通过im_unknown_outbound列出当前环境/账号的脱敏metadata；创建代次仅作审计，重登录仍可读取旧记录。手选记录后im_outbound_lookup→im.outbound_lookup仅取该gid最新页的四个身份字段，不修改focus、共享角色/消息缓存、事实或display广播，不能间接触发已读回执。普通历史页带展示副作用，不能复用为此核验接口。唯一精确gid/local_id/本人角色且无损服务端ID才显示找到记录；未找到、多条、错身份或查询失败仍未知。这不是客户已读证据，账本不会被结算/删除，不会重发。历史第1轮unknown未事先入此账本，不能追溯补造发送证据。

验证：真实宿主helper+真实FileStore六项初始全红，修复后13项全绿；覆盖重建/换代次去重、payload各字段冲突、崩溃write_started、终态回放、真实文件系统前后故障、损坏fail-closed、两线程独立实例竞争、metadata无正文、Rejected回显text/original脱敏。回显故障另有红→绿。原始输出/tmp/vbk-goal-20261031/outbound-journal-{red,reason-red,green}.log；独立评审实际13/13通过。并发测试为双线程，跨进程flock机制已源码审查，未做真实双子进程验收。

范围：本轮macOS；Windows目录fsync尚未实测，不支持时会阻止发送，不能声称跨平台持久化已验收。新包真实重启和端到端核验继续待第5轮。记录按账号保留直到明确设计留存清理；当前无自动删账本或清除unknown入口。

核验入口验证：控制器及真实点击8项、实际PageSession→main自动已读反馈链1项、专用RPC生命周期/身份隔离2项，mock只读与精确scope1项。普通历史查询曾真实触发1次SDK已读，独立评审反例红→专用lookup绿，输出/tmp/vbk-unknown-feedback-review-red.log与/tmp/vbk-goal-20261031/unknown-feedback-green.log。宿主main专属ACL真红→绿，响应DTO只保留四个身份字段并拒数字ID。新包重启核验仍待第5轮；无记录不补造第1轮旧unknown。
