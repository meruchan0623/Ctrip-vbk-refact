# TSim 会话与凭据存储边界

用户需要在新客户端正常登录TSim。已有登录HTTP仍为 `/agent/login` multipart `username/password`，成功后核对profile；本块不迁移官方或旧助手秘密，不改变服务端协议。

本轮生产service回归实得两项失败：登出发生于登录HTTP期间，旧登录完成后恢复会话；凭据save失败仍返回已登录。另将save临时移回状态锁外，真实双线程写入/退出交错复现“退出后旧凭据残留”。故障代码已还原，测试保留。

- 登录、退出和清除推进 `session_epoch`；旧HTTP结果不能安装会话。profile/refresh返回凭据及其同一次epoch，套餐链在每次await后复核，避免旧凭据与新缓存代次配对。
- 凭据save/clear和内存身份变更共享顺序；save失败清理可用内存会话并上报，logout clear失败也返回错误，不假报持久退出成功。密码仍只用于正常登录请求，不进入凭据库。
- `UiTsimStatus` 新增非秘密 `session_epoch:number`，同名重登仍可区分。宿主仅向本地main、setting及套餐详情窗口发布 `assistant://tsim-status`，内容只有登录状态、用户名、epoch，不含token/session_ref。
- 401/423清除与403权限不足仍区分；翻译与套餐读取保持当前身份校验。此处不是客户消息发送路径。

独立复审补充发现已排队登录可在退出后复活、等待refresh锁后旧请求改用新身份及profile尚未完成提前公开成功，均用真实gate/poll交错先红后绿。登录提交票据在等待锁前捕获，logout/clear撤销旧排队意图；refresh锁前后epoch必须一致，公开ready与请求所用身份配对；只有完成登录profile路径且凭据持久成功后公开已登录，首次profile前refresh不能提前置ready。

owner最终完整宿主140/140通过、无ignored；IPC与设置原fixture契约5/5通过。Sol/xhigh最终独立复审无未修P1/P2，直接运行已编译宿主31项service专项通过。日志保留于本机临时目录 `vbk-windows-20261031/r7-tsim-identity-red.log`、`r7-tsim-vault-order-red.log`、`r7-tsim-queued-provisional-red.log`、`r7-tsim-refresh-identity-red.log`、`r7-tsim-identity-final2-host.log`。主代理暂存快照验证进行中，真实登录尚未验收。

主代理独立暂存快照以 `b31d9f4` 为基线，仅含本行为7个代码文件和本文（client.ts仅状态事件/epoch两处hunk）；全UI557/557、typecheck、bundle及完整Windows宿主140/140全部退出0，0失败/skip/ignored。未纳入订单或详情WIP，真实登录仍待最终新包。
