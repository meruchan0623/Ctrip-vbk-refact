# VBooking 消息面板对齐（2026-10-31）

## 2026-11-02：改进计划首轮落盘（A/B 类）与对抗性审查
- 起点 main@6f7ae82。按改进计划 8 个模块并行落盘可在云环境完成的 A/B 类部分，随后 6 路对抗性审查发现即修：P0 1/1、P1 15/18、P2 14/26 已修并附红→绿回归。合并后 cargo test 516、clippy -D warnings 0 错、fmt 干净、npm test 932、门禁夹具 178/178 且源码树 0 违规、release-scan 对实跑 bundle 为 clean。
- 新增 std-only crate core-transport / core-diag / core-update；DOM sink 门禁已进入「允许清单空、严格零命中」；四条 I-30a–d 宿主命令五方注册；发布包不再含 mock。
- 同日第二轮修复 3 个跨模块 P1：发送屏障接入 persist_failed（新错误码 store.persist_failed、快照字段、UI 告警条）、登录成功后入队 Unlock 解除 logout 锁、草稿宿主命令 im_draft_load/save 五方注册；合并后 cargo test 528、npm test 943。
- 第三轮打通 feature://fact：适配器经 adapter_push_fact 推 `{kind:"feature"}` 事实，宿主纯函数校验（gid/from ≤64、message_id 1–32 位数字、until_ms 夹紧 30 s）与每秒 4 条限速后 to_main 转发，不进核心、不持久化，主窗 onFact 校验账号 scope；cargo test 534、npm test 953。
- 宿主 src-tauri 在本环境不可编译，全部宿主改动只经逐行自查与 rustfmt，不计为落盘；C 类验收与 X 决策项一律未做。细目与未修 P1、待拍板 8 项见 [docs/reviews/2026-11-02-implementation-adversarial-review.md](docs/reviews/2026-11-02-implementation-adversarial-review.md)。


## 当前接续：双账号自然接收对比（用户新增授权）
- 16:25用户已确认可切包；旧进程已自行退出，核实无vbk-host后启动7b5d75a/PID69660，路径/hash匹配。双账号恢复、新分栏显示、校时提示消失。Nay客人0/921与官方后台AX20/1959仍有差异，未做任何忙客户会话或出站操作；此前等待草稿已解除。
- 7b5d75a统一包已构建并复制到`vbk/release/windows-observation-7b5d75a/`：最终索引711UI、两个原样反例2/2、178host/312core及bundle通过；独立复审关闭新增两P2。707文件dirty空，源码/产物hash与验证适用范围见[本包记录](docs/research/2026-10-31-busy-account-package.md)。尚等当前草稿确认，未停止用户正在用的旧进程。
- 删除同步240dac8已本地提交，独立索引681UI/177host/typecheck/bundle全绿；可见已读合并接缝708UI和178host通过，但额外独立反例抓到首次epoch旧历史污染与同scope未知回执A→B→A重试，修复未完成前不提交或打包这块。
- 15:15:30已启动可信校时包9731e00/PID71540，准确路径及hash见双账号记录；15:16、15:19、15:25、15:26只读UI均无锚点失效提示，未据此宣称逐次校时或长期稳定性通过。
- 列表初始化fba8a4b、首列表预览7b7cbb6已提交；业务分类d3d6656已独立审与索引677UI/177host/typecheck/bundle通过，尚未进入运行包。删除失效6文件通过独立审，索引门禁进行中；可见已读的服务身份闭环仍在修复。
- 15:26出现新状态：代理仅切Nay账号标签，随后被动截图已显示客户会话与空输入框；用户明确确认正在操作新客户端，因此不记自动恢复异常。代理没有点击客户行或发送按钮，此后避免干扰用户操作，不把用户正常使用期描述为一直空聊天区。
- 用户已在新客户端和官方桌面登录持续进消息的 Nay，并要求与闲账号 Meru 持续对比、修复和打包；忙账号禁止任何出站。观察保持忙账号未选客户会话，不发送、上传、转交、结束或触发已读。
- 用户已处理旧草稿并明确同意切包；60c9479 于14:36:50启动PID61864，原草稿阻塞解除。两账号当前均在此进程；TSim导入会话经重启恢复，Meru受控订单再次自动返回1套餐，无再次登录。
- 14:42–14:45未调用诊断、刷新或打开忙会话，Nay列表时间自然推进14:42→14:45，处理中40→42，已完成863，未读与提醒有变化。该观察证明自然更新出现，尚不能量化丢漏、延迟或三端一致性。
- Meru新客户端11处理中/9完成，官方桌面11/24，差异保留；正在区分服务端列表与官方历史缓存。忙账号官方同刻对比等待用户将官方窗口切至Nay列表，以避免代理切换恢复旧会话并自动已读。
- 14:46:28单次受控分页已实际保持原18:33:52撤回行约y166。完整3266数值事件、drop0，restore持续跟随原行0→8，偏移57.4–57.8；14:47停止并关闭诊断。连续第二页复验进行中。
- 摘要补齐864c54f已本地提交并完成独立UI608/核心312/宿主167/typecheck/bundle及Windows构建，失败/skip/ignored均0；统一摘要包已复制，尚待切换实机。
- 864c54f已14:49:46启动PID57416，双账号恢复，14:50:51自动摘要实际显示名称/using/供应商/APN；详情14:51:28打开，刷新后读取时间14:51:51，无错误。第二次分页也实际保持原阅读区域（视觉约2–4px），原分页故障在两次样本通过。
- 约14:55官方Edge专用页重新只读核对Meru为11/9，与新客户端一致，桌面仍11/24。另已离线真红定位列表初始化与早到消息的两处竞态，分别独立修复，不把它们直接归因为现场15条差异。
- 发现服务器时钟锚点未在生产接线，不能由“待核对”推断断流；固定只读服务端校时闭环独立实现中。另观察默认UI WebView内存较高，取证面板影响与持续增长尚未区分，不预判泄漏。

## 用户新增一轮：设置、TSim登录、订单自动速览与详情
- 2026-10-31用户明确要求继续本轮修复上述功能，作为原6轮结束后的新增授权；原记录保留，不把此前未完成项改称通过。
- 起点干净0bef92ec1c42df3bad89ae32e829e10c17ccde9f，分支feat/prototype-restore-macos；当时运行第6轮PID58224，之后的预览替换记录见本节末。
- Edge原专用页已实际登录并显示Meru及11处理中/9完成；此前网页登录阻塞已解除，未发送客户消息。
- 原生设置点击后创建标题“设置”的窗口，但AX无Web内容、可见区空白；正在核对同步建WebView的Windows死锁路径，不以窗口存在视为可用。
- 主代理负责实机/接缝/证据；数据owner负责宿主/IPC/TSim契约，UI owner负责设置UI及后续速览交互，独立review继续只读。TSim及官方/助手源码安装仍只读；最初禁止复制登录态，后续仅TSim浏览器会话复用获用户明确授权（见下文）。
- 按用户所述“订单号自动缩略查询”接续已安装助手的订单自动套餐速览及对应TSim详情；目标为真实登录和查询路径可用，不扩展生产写入、消息发送或部署。
- 设置UI已完成实际状态确认、失败重试、密码立即清除及晚响应隔离；独立评审无P1/P2，独立暂存快照11项/typecheck/bundle通过。宿主窗口异步构造另块审过，真实新包仍待验证。
- 设置UI行为提交74221be；协作对话历史异步媒体锚点块独立复审通过，真实helper的增长/queued scroll/缩小clamp反例均红→绿，主代理独立暂存36项/typecheck/bundle通过。原生分页结果仍待新包，不沿用离线结论。
- 历史行为已提交cf03b48；窗口async/spawn_blocking与单例串行构造独立暂存快照宿主128/128通过，0失败/ignored。TSim并发登录/退出及凭据持久化竞态已复现红，独立修复中；尚未请用户在新包输入TSim凭据。
- 窗口24f6271、输入法组合b31d9f4已提交；IME独立暂存全UI556/typecheck/bundle通过。旧PID58224实证未缓存会话全空且只读诊断等待超过1分钟，前端及已有缓存仍可交互；正以干净b31d9f4构建中间预览验证恢复，不混入TSim/套餐WIP，不称整轮完成。
- b31d9f4中间预览已13:03:34启动PID5380（exe 3bf47831…c1f2111a），设置完整表单/只读诊断/新进程受控会话首屏历史实际恢复；分页仍从18:33撤回行跳到18:21订单卡，未关闭，转实际锚点匹配诊断。TSim尚未登录。详见[预览记录](docs/research/2026-10-31-extra-round-preview.md)。
- TSim身份生命周期c41db39已提交，真实HTTP/锁/vault交错红绿与独立审通过，独立暂存TS557/host140/typecheck/bundle绿。首屏历史失败/超时/重试与畸形响应门禁已独立暂存TS567/typecheck/bundle绿，尚未在运行预览中。
- 首屏重试4b65808及默认关闭的数值滚动诊断ece045a已提交；后者独立暂存54项/typecheck/bundle通过。干净ece045a源码660文件、manifest c58d4d77…af57a0f，Windows构建退出0。
- 第二预览13:24:55启动PID56552，路径vbk/release/windows-auth-diagnostics-ece045a/vbk-host.exe，exe 1a3bcdb2…623bb78；旧PID5380已核对路径停止，未执行安装器。新设置和TSim表单实际可用，已请用户正常登录，未复制其他程序凭据。等待登录期间不抢窗口焦点。
- 订单多套餐及详情UI当前专项23、全UI597、核心308/typecheck/bundle通过；独立复审发现缺身份恢复的revision复用、失效详情窗重开、上游错误内容跨IPC三项P2，数据owner修复中，不能计整块完成。真实订单查询及分页数值诊断仍待实机。
- 安全错误边界d55d959独立暂存host142通过；订单闭环02397f9独立暂存TS598/core308/host148/typecheck/bundle通过，2 UI+3 host P2已关闭。当前预览仍为ece045a，代码门禁不计真实详情验收。
- 用户随后明确要求尝试复用Edge/Chrome的TSim现有登录态，覆盖此前禁止复制登录态的限制。Edge实际TSim工作台已登录；从一次只读刷新捕获认证头，只在CUA内存保留，不输出凭据/不落盘。新settings专属导入入口实现中，先服务端profile/session-status核对，再系统凭据库保存；shared来源须持久并本地解除，不连带注销浏览器。
- 13:36 ece045a受控分页再次跳位，记录3769条数值事件但512容量覆盖转折（drop3257），仅剩不变布局循环，不能据此认定根因。容量增量824b94d扩大到8192，独立暂存3测试和复审通过；等待下一新包取得无丢弃的转折。

- HTTP安全初始化d6405fa已独立暂存host150通过并复审；会话导入2c79eb1已独立暂存UI605/core311/host160/typecheck/bundle通过，0失败/skip/ignored，setting专属ACL、双服务端验证、共享会话本地退出及独立凭据槽均审清。真实新包尚在构建。
- 约13:54确认此前PID56552已退出，root未执行退出、原因未定。工作树新增两文件密码自动填充差异无法归属现有owners，保留原样并精确排除出2c79eb1及本次构建，不借它们的全量607结果充作暂存605证据。

- 统一包2c79eb1于14:03:18启动PID19624，exe 2be2c28d…75c14fa、安装包7dca86a2…0c828f；682文件独立快照、manifest f1f5013f…4076f。设置完整打开，自动订单返回1套餐，绑定详情已实际读取名称/供应商/APN/实时字段。
- Edge旧会话已失效；浏览器已填好凭据，经正常登录按钮恢复，未读取复制密码。新会话导入成功；本机退出后Edge重载仍登录，重导入成功，内存令牌已清除。摘要只有ICCID的实机缺口另块补齐，未知流量仍保留未知。
- 14:04分页取得完整2126条、drop0诊断：第一次115px补偿有效，后续增量被新row0接管，且无用户scroll打断。历史偏好与原生锚定竞争修复60c9479独立UI608/typecheck/bundle与复审通过，新包构建中，不提前宣称现场通过。

## 历史断点：第6轮满轮停止，整体验收未通过
- 按目标的原6轮上限停止新增修复，未重置轮数；第5、6轮Windows消息发送/附件上传均0，官方网页登录未有效，不进行盲发或旧unknown重发。
- 第6轮源码7bd269077eea568c4d66070b2c432634aa4b35b6，dirty=[]；643文件manifest c06ab51d62db69079912eb60eb026e3f2713a205c2d7809e8d1703419e204bcc。typecheck、TS536/核心304/Windows宿主126（0失败/skip/ignored）、bundle、Tauri NSIS、diff全部通过。
- 新程序12:17:56实际启动PID58224，路径vbk/release/windows-round6-7bd2690/vbk-host.exe，SHA256 72111798daed2db6a31efb9c7a2d0ccbc770e046a611ca759634c1851932318b；安装包2bd8bcbd800bca102a4d7982a0bde665ae7acec52d75591b5f0e049c88ca72bd。独立评审重核源码/产物/进程一致，未执行安装器。
- 新包自动恢复账号，受控订单/客户已再次核对；本地PNG/TXT选择、附件独立提示及移除通过，TXT作为视频被拒绝。未证明真实上传/SDK/自然双向。
- 12:18分页原撤回行仍跳到更早订单卡，现场失败未解决；列表11/9与官方此前同刻11/24差异未关闭。无ID指纹修复只是条件性缺口，不能当现场根因已确认。
- Edge专用页最终仍在登录；媒体真实读回、客户已读、引用撤回、真实unknown恢复、重连/切账号、三端矩阵和Windows截图/大视频分片等保持未完成。TSim只读，无push/合并/部署。
- 完整命令输出摘要、红绿、提交、hash、实机与边界见[第6轮记录](docs/research/2026-10-31-round6-windows-runtime.md)；问题入口见[BLOCKED](BLOCKED.md)。下文为过程记录。

## Windows 开工回执（2026-10-31，Asia/Shanghai）
- 已读取目标、交接、阻塞、TSim说明、重勘、round4及能力矩阵；任务范围仍为完整示例与迁移准备。
- 初始目录为干净main/f61a0bf，已安全切换feat/prototype-restore-macos；本地/远端均66b876907f0fa7bf75f00fcdfb3aa863aef80f99，暂无遗留dirty。
- 完整轮数沿用4/6；当前为第5轮准备，未以迁移检查计新一轮通过。
- Node24.13.0/npm11.6.2、Rust/cargo1.95.0、x86_64-pc-windows-msvc、VS2022 BuildTools、WebView2 156.0.4314.58已发现，编译及持久化待实跑。
- Windows官方客户端窗口已发现；安装/助手/三端登录/受控身份尚待本机重核，历史Mac状态不继承。
- 独立Sol/xhigh只读复审最终历史合并/锚点与草稿归属；主代理负责环境、接缝、证据、打包及本地提交。
- 本轮允许既有真实浏览器工具替代ego；仅专用任务页面，客户端与官方网页双核前不出站。
- TSim与官方/助手源码安装均只读；持久化失败保留发送屏障；不push、合并、部署或迁移秘密。

## Windows 第5轮已构建登录，网页与分页验收未通过
- 基线TS483/核心Rust301通过，0失败/跳过；初次typecheck因缺tsc失败。98311bf锁定开发依赖，独立暂存npm ci/typecheck/bundle/Tauri CLI通过。
- 1a32e8d译文请求实例隔离：独立暂存16项/typecheck/bundle及独立24交错复审；新增回归13绿3红→16绿，旧12项完整保留。
- e21a6e9历史像素锚点：允许无冲突身份补全但双向唯一匹配，完整scope隔离；独立暂存历史21+草稿16项/typecheck/bundle通过。真实渲染故障注入top120≠420及反向唯一性反例均红→绿；独立复审无未修P1/P2。
- a3fbb22 Windows严格持久化：修复OS5句柄权限，统一目录/状态文件同步并同步祖先；失败仍关闭发送。独立暂存核心304/Windows宿主115全部通过，0失败/ignored；真实共享句柄及双进程unknown不重发红→绿，独立复审通过。
- 第5轮冻结a3fbb22f1586b62beb411432c10c7640a540027d，独立源码快照dirty=[]；635文件manifest SHA256 07596ea75643c053b6937551961fd5ddb5f158c829fdf135cf62f858eb675c17。完整检查及Windows安装包已在该快照完成，不混入后续媒体改动。
- 官方Windows1.2.12已登录，原生受控订单/客户/iframe身份已读回；助手0.5.41翻译栏与有效套餐速览可见。Edge专用网页登录失效，桌面授权唤起失败，已请求用户正常登录；新包/网页双核与出站尚未进行。
- 第6轮媒体链路独立实施中：绑定完整目标及附件快照，分阶段持久化，unknown不重传/重发；不计入第5轮包，尚未完成/验收。
- 第5轮493TS/304core/115host及typecheck/bundle/Tauri NSIS/diff通过；全新host首次缺bundle退出101已保留并修正前置。11:37:57新包PID14828在release/windows-round5-a3fbb22运行，exe hash6150ef53…12c2654，安装包d818f35d…fd456ff；欢迎页和官方登录窗实际可见，用户登录待完成。详见[第5轮Windows记录](docs/research/2026-10-31-round5-windows-runtime.md)。未执行NSIS安装或任何消息发送。
- 11:55用户回复登录后，新包实证Meru已登录、账号/列表/本人及同事头像显示；受控客户与订单双核成功。Edge原专用页重新进工作台仍跳登录，已告知准确状态。客户端本轮没有出站；不把原生登录替代网页身份核对。
- 11:58新包受控历史实测分页后原18:33撤回行锚点未保持，改显示18:21订单卡；源码根因调查中，暂记未通过。同时官方同一时点11处理中/24完成，新包11/9，列表完整性/计数差异待定位；订单旧页后Trip-App来源/产品/日期/金额已实际显示。

## 第6轮冻结与修复过程（已结束，结论见顶部）
- 源码7bd269077eea568c4d66070b2c432634aa4b35b6，独立round6-source快照dirty=[]；643文件manifest SHA256 c06ab51d62db69079912eb60eb026e3f2713a205c2d7809e8d1703419e204bcc。此快照已完成完整Windows检查与NSIS构建；运行已替换为第6轮PID58224，原第5轮PID14828退出，本轮上限仍6，不重置。
- UI/IPC/宿主/adapter已接通候选链路，图片/一般文件/MP4采用独立媒体命令、冻结bytes与完整目标、严格upload_started→uploaded→write_started屏障；文字/引用保留，上传阶段不生成伪SDK消息行，unknown不重传/重发。
- UI已复现并修复upload rejected/unknown且write_started=false被误认为send unknown的问题，三项真实返回组合红→绿；原附件丢失时replay_only只回放旧metadata，不能确认新附件；选择取消及终态释放资源，unknown账本不清除。
- macOS截图变量遮蔽、连续取消附件17次导致target cap耗尽均已修复，媒体范围独立复审无剩余P1/P2。28个必要实现/契约/测试/文档已提交9771a80f0197d58c3df0ef3f82643a605fb45e2f，最终patch SHA256 950b8c7ddd636806de9f59e78146af9a0667b69f9f363072d83b9d25eb768307；独立checkout-index快照TS531/宿主126/typecheck/bundle通过，0失败/skip/ignored，尚未构建第6轮。
- 第5轮历史锚点只读fixture复现一个条件性缺口：无server/local ID系统行无可用锚点时，分页保持scrollTop而非原可见行。独立修复已提交fcd7b031df7e27dc437284bfd4b04b14fe2b786e，暂存快照专项26/全UI536/typecheck/bundle绿；独立专项26及额外11组合通过；实际行的ID尚未从运行页面取得，不能据fixture断言实机根因。官方完成数可能含本地历史缓存，但本轮HTTP haveRest未采到，不能认定15条均来自缓存或伪造补齐。

## 已停止：Windows交接（2026-10-31）

用户要求停止运行并把全部成果分块提交、推送，后续在Windows继续。构建/实机/功能修复已停止；完整轮数仍为4/6，第5轮未开始，整体验收未通过。当前第4轮PID90073已退出，ego TaskSpace1已不存在，不沿用旧运行/登录结论。请先读[Windows接续说明](docs/integration/windows-handoff.md)，再按最新源码复验；最后历史身份/锚点增量尚未完成最终独立复审。原本机/tmp原始证据不随Git迁移，不含凭据或客户原文的回归与文档已保存。


## 最新断点：第4轮新包已运行，独立评审发现安全缺口（完整轮数4/6，未通过）
- 源码cb170df+保留dirty；307文件manifest SHA256 `6e85ba537eb6f3d8f01f3a5372caa7be6b842b11f278df7e5e11569783e142fd`。修复代理后续改动不属于此构建。
- 第4轮typecheck、TS399/核心301/宿主101（0失败/跳过）、bundle、tauri及diff通过；原始输出/tmp/vbk-goal-20261031/round4-*。
- 新包PID90073，实际路径src-tauri/target/aarch64-apple-darwin/release/bundle/macos/VBooking 商家客户端.app；binary SHA256 `cbce354dd154199a52810a9ff34f159ead7b26f94d2bbe992fa14c1b5d73f32f`，DMG `de3e8bddb54ef0ad6970500b90c464bac798b0875396763cd77ba57bf64b1018`；已对应进程路径/hash，旧PID80117已退出。
- 第3、4轮启动均自动恢复Meru及12个会话，无新钥匙串提示；只证明这两次观察。真实账号/列表/标题/消息/侧卡头像现已显示；成员3人头像亦已实机显示，机器人名称仍raw本地化key；视频已实际点击播放，原生Pause与进度0.31可见；此仅既有短片只读播放。
- 第4轮真实订单/客户及iframe gid已重新双核；05:25:05仅一次C在原生confirmed，官方同ID读回已完成；05:30:21官方W一次，05:31:07诊断刷新后原生同ID可见，不能计自然实时通过。诊断面板可读/复制固定schema，初始计数已留临时证据。
- 独立评审新增P1发送await身份切换竞态，以及P2撤回引用泄文、local_id历史去重、实时订单摘要及跨订单侧栏错配；已记录BLOCKED，优先修P1与引用，暂停客户端出站，不据构建成功称完成。

- 第4轮后分块：`a0b4416`发送身份重核（独立6tests/typecheck/bundle）；`d1d071d`隐藏账号页调度（独立host101/bundle）；`02d4125`撤回引用完整链（独立11tests/host102/typecheck/bundle，mapper与host漏字段反向红、role冲突红→绿）。各块独立评审通过，PID90073仍旧包；持续补偿34470c1已独立5tests/typecheck/bundle及评审通过；历史与订单块接续中。

## 第3轮及第4轮构建前记录（历史）
- 冻结源码 `5db15cc7f4cc5fb48e3a2525dafc418f607cc954` + 保留dirty；302文件manifest SHA256 `6cd2ac56dfd89b7e3a393e7270cf62ad1c9314ffc1f1e7233eff93a275181072`。
- 第3轮完整门禁通过：TS387 / 核心301 / 宿主95，0失败/跳过；typecheck、bundle、diff及Tauri app/dmg通过。原始日志位于 /tmp/vbk-goal-20261031/round3-*。
- 新包实际PID80117，路径 target/aarch64-apple-darwin/release/bundle/macos；binary `0e5a391588e81d60aeb9a425513df5b2aa8731c92f8b5c7c16be010f265f56c8`，DMG `1e43f751e3cefaa4809b479a79157c827f882a01c8b58d9ac631b7d64e6bf59a`。源码/产物/运行路径已对应。
- 本次启动自动恢复Meru及12个会话，未再需要用户处理钥匙串提示；仅证明本次启动，不保证永不弹窗。
- 受控客户/订单在网页和原生重新双核，真实iframe gid与原记录一致。04:56:10原生C仅发一次，confirmed、官方可见，双方服务端ID逐字一致；官方仍显示未读，无客户已读证据。
- 05:02:03官方W仅发一次，49秒后原生仍无；05:05加载旧页后可见，服务端ID逐字一致，实时第三次失败。已改用脱敏链路诊断路线，不再推测根因。
- 头像实机未通过：接口姓名已到达，但账号、列表、标题、消息和侧卡图片均落回文字占位。历史视频仍Invalid；同资源官方页面实测readyState4/error=null可播放。已用ego复现HTML meta CSP阻止dimg04，正在修正；不能称头像完成。
- 本人及商户同事Sara消息右侧原生均已见，客户订单卡仍在左侧；三端全面对齐尚未实机核验。官方桌面CUA超时、助手认证失败等仍见BLOCKED。
- 本轮前逐块提交：d3aaaa5列表/标题、d152f66本人资料、eb67560周边安全链、5db15cc客户侧卡/提醒。均经独立暂存验证和独立评审；周边真实动作与unknown只读UI仍未验。

- 接收诊断提交 `cb170df`，独立TS391/宿主100/typecheck/bundle及最终评审通过；focus副作用P2真实红→绿已修。第4轮冻结cb170df+dirty共307文件，manifest SHA256 `6e85ba537eb6f3d8f01f3a5372caa7be6b842b11f278df7e5e11569783e142fd`；运行仍PID80117第3轮，尚未第4轮验收。
- 第3轮运行证据独立审阅并提交 `cd46021`；两层资源策略修复已完成独立4tests/typecheck/bundle及ego实际头像红→绿并提交 `3b0735a`，第4轮原生仍待验。接收脱敏计数诊断正按真实链路接线。

## 第3轮前分块验证归档
- `d3aaaa5` 列表/标题头像：独立暂存TS326、host74、typecheck/bundle，独立6项复核；初次325/1因提取的真实main测试环境缺notWired，补齐外部环境后全绿，不削弱断言。
- `d152f66` 账号本人头像：独立TS329、host76、typecheck/bundle；独立12项及login4项复核。boot精确预期补self_profile；字段仅内存且UID二次核对。
- `eb67560` 周边安全链：独立TS377、host94、typecheck/bundle，持久journal13项及独立评审；旧结束session确认、零请求前置失败永久锁、变更目标绕过unknown均有故障回归。保留376/1因精确摘取漏安全整数hunk的失败和修正。
- `5db15cc` 客户侧卡/提醒头像：独立16项、typecheck/bundle及5项评审；旧代次借新客户头像P2真实红→绿。以上源码验收不替代第3轮原生发现的资源策略阻挡。
- `cd46021` 第3轮运行证据、`3b0735a` 双层资源策略、`f550bec` 持久准入迁移边界已本地提交。新的接收诊断独立TS391通过，评审focus副作用P2已红→绿修复并提交cb170df。

## 任务0与前两轮过程记录（历史）
- 已读三份断点文档并完成 7 行开工回执；保留 24 个跟踪改动及 6 个未跟踪文件，HEAD 00efc740。
- 基线复核：TS 202、核心 Rust 300、宿主 58，失败/跳过均 0；typecheck、diff 检查通过。TS 原始输出 /tmp/vbk-goal-baseline-ts.tap。
- ego-browser 复用 TaskSpace 1/p1，网页登录有效，标题客户与侧栏订单双核成功；本轮已由真实iframe解析gid（见下），尚未出站。
- 旧客户端 PID 7441，仍为 release/macos；新旧 hash 与重勘记录一致。官方 1.2.12、安装器 0.7.5、助手 0.3.2。
- 官方原生连接本轮失败为 NSOSStatusErrorDomain -1712 errAETimeout；助手日志末态 attached=true / auth=failed / phase=failed / verified-editor。
- 统一展示出口未读防护已提交 `c806ad7674f803c7b4c7751705ef63f49219ed39`，真实回归红 `0 !== 3`→绿1项；完整工作树TS203通过。独立暂存快照TS190（HEAD189+新增1，未包含继承成果）、typecheck、bundle:ui通过。
- 独立评审指出的宿主ACK强清零已在ab0b751修复；原生端到端未读验收未完成。
- 三端复核：自制旧包登录/消息面板原生可读，助手原生仍 timeoutReached。官方订单/客户双核后由实际侧栏 iframe 解析gid，原值仅存 /tmp/vbk-goal-20261031/controlled-frame.json。
- 迁移文档独立只写 docs/integration/tsim-cs.md 与 tools/contracts/tsim-integration-example.json。
- 回执完整性提交 `3a9dcda3bf583c92ed571cf82f5ea1472c968122`：专项红6绿1→绿7通过；独立全测实际190通过/1失败，误未拦提交且正文误报，已由 `263ad0b` 后续提交迁移旧畸形码契约并加不重发判据；重新导出暂存快照typecheck、TS191/0失败/0skip、bundle:ui通过，不重写历史。
- SDK Promise桥无损ID校验已提交 `2b4ee14`，联合测试红→绿，独立暂存快照TS192/typecheck/bundle通过。SDK disposed写保护已提交 `e3f5aef`，独立快照typecheck/2tests/bundle通过；历史preview防回滚已离线红→绿且独立复核，待独立提交；session代次栅栏已接入，真实session stop/start旧请求离线零发送已被独立复核，待行为提交。
- 宿主不再ACK强清零，独立行为提交 `ab0b751`；独立快照bundle+宿主58通过，当前新增cache回归通过。TSim迁移材料/合成契约提交 `c91e72d`。
- 周边新数据/宿主已接通，UI实现与独立复核中；额外修复畸形host回执unknown、metadata补全导致journal重放（先2次!=1次失败，再绿30/30），尚未整体提交/实机。
- 16位订单校验与高亮已提交 `dde2d0b`；暂存快照typecheck/18tests/bundle通过，临时旧实现反证红→绿。
- 任务0已完成复核，准确保留原生/认证阻塞；完整轮数1/6（实机受阻，不能称通过），第1轮已完成typecheck、TS242/核心300/宿主63（0fail/skip）、bundle和diff检查；tauri app/dmg构建完成，新包已从target/bundle启动PID33871，二进制hash6c5da79b…3a811b、DMG hash79ef5d28…047ef9；钥匙串经用户处理后账号已恢复，第1轮实机未通过，已记录断点。冻结源码HEAD dde2d0b + dirty manifest SHA256 0014cb6de1ff67f255f45e156810b37a990a7a620a67a8cfa79adc38a3e6f60d，清单/tmp/vbk-goal-20261031/round1-source-manifest.json。

- 02:52受控双核及真实gid复核完成；新包发送一次合成测试标记C后transport断开，超时转unknown，网页刷新仍不可见。未重发。官方发W后原生加载旧页可见同正文/发送者/时间，服务端ID尚未跨端核对；旧页补全订单来源，滚动停留历史位置。网络反复断开与误导排队文案进入下一轮修复。

- 官方当前SDK源码经ego只读核实发送字段/回调及已读回调与桥接错配；第2轮准备先补真实边界红绿修复。成员官方过滤/机器人本地化规则亦已取得源码证据，待接续。

- 第1轮实机证据已提交 `3760382`，独立评审确认真实SDK发送/已读回调错配为P1；不能归结为纯网络。离线误导排队提示独立提交 `24b10f2`，暂存快照typecheck/bundle通过；第2轮SDK契约及附件错误出站保护在红绿修复中。

- 附件伪文本出站保护已提交 `439d9de`：红7失败→绿8；独立暂存快照typecheck/8tests/bundle通过，独立执行真实main三个发送入口12组均零IPC且保留草稿引用附件。媒体仍未实现。

- 房间路由独立提交 `25816ac`：旧实现反向回归把self当房间失败，新暂存typecheck/2tests/bundle及独立评审通过。SDK独立评审新发现raw -2先rejected会与内部HTTP兜底冲突，正在保留红证据修复；未将该未通过块提交。

- 账号/代次与草稿迟到结果隔离提交 `8cb02a8`，独立暂存13tests/typecheck/bundle及真实入口复核通过；初始账号刷新不自动开首会话提交 `84016ec`，真实函数红→绿2项；只读服务端消息ID入口提交 `990dcb4`，独立typecheck/bundle通过，供下一轮原生ID读回。
- SDK连续评审发现3类生命周期边界后已换通道矩阵路线：48格初次60pass/5fail（连既有共65），捕到排队旧事件及畸形HTTP兼容响应；正在统一结算和绑定屏障修复，无线上重发。

- SDK 回调契约与生命周期屏障已提交 `18c0ed3`：独立暂存副本 TS284/284、typecheck/bundle通过；专项67/67，独立评审无剩余可证P1/P2。工作树全套TS323通过，第2轮即将冻结构建；媒体/实机仍未完成。

- 第2轮门禁通过：typecheck、TS323/核心300/宿主63（0失败/跳过）、bundle、diff及Tauri app/dmg。冻结HEAD `18c0ed3a07df4ea6e249b81b19045b8b1ff27138` + dirty，273文件manifest SHA256 `2926be1e038d249ab43c45e2f51065f9626660266feeb9ffe0a27b1ec7164619`。实际新包PID48183，binary SHA256 `1e5281fc5d73be72de8e9c9f30e3abed2378fa3493264f021aa4ac0806e79528`，DMG `df2941402323ed71d039b63acb81d055e42d89d3f5305c20606343d9725b0b6a`；启动后账号恢复待核验。

- 第2轮用户解除钥匙串后，原生C03:31:44 confirmed且官方可见，同服务端ID已逐字核对；官方W03:35:27在原生40秒仍无自动到达，历史加载后同ID可见。整轮仍未通过，实时/视频/成员等继续阻塞；未知发送重启账本P1与核验入口P2新增，正在修复。
- 离线真实adapter合成契约入口已提交 `c316b94`，六场景通过；独立暂存副本注入void误确认故障后退出1，恢复后退出0，临时红绿证据已保留。第二轮产物起始证据提交 `8f63476`。

- 同步消息帧/单聊身份路由提交 `58f46fd`：官方SDK源码核实sys_muc/sys_mam映射，真实入口新回归5/5，独立暂存全TS289/typecheck/bundle通过，保留裸群地址未知发送者与旧测试迁移证据。此修复未证明第2轮W实时缺失根因。
- 钥匙串标记元数据探测提交 `e49ca90`：实际Registry不可用回归红→绿、空结果分类0/1失败→绿，独立暂存核心301/宿主59/bundle通过及独立安全评审。访问失败保留引用/profile；第3轮新包启动效果待核验，当前运行包仍是第2轮。

- 用户新增商户消息靠右要求已提交 `fa45301`：独立暂存typecheck/7tests/bundle通过，真实messageRow五类消息双商户角色与system经独立评审，同事消息无本人重试权限；第3轮原生视觉待验。

- 单聊组合层动态selfUid接缝提交 `65117a8`：真实入口红→绿及静态旧身份突变反证，独立9tests/typecheck/bundle与评审通过。
- 宿主持久发送屏障提交 `79e5e50`：初始6项红、拒绝理由回显另红→绿；独立暂存宿主72/专项13及bundle通过，评审无该块未修P1/P2；unknown UI与新包重启仍待验。
- 用户新增每个人接口头像：已ego重读成员接口HTTP200/AckSuccess并与DOM比对，正补本人UID校验/资料优先级及UI回执不擦除/加载失败占位；未称整体完成。

- 接口人员资料foundation提交 `2b73b74`：独立12tests/typecheck/bundle与只读评审通过；当前正在补齐消息DTO/UI头像显示及同sender合并防串人。

- 消息接口头像与专用profile增量提交 `d41e5fd`：独立TS313/host74/typecheck/bundle通过；评审捕获迟到头像覆盖confirmed的P2已修复，资料patch不重放正文/回执。列表/成员等另块进行，第3轮未构建。

## 上轮状态（历史）：用户要求重勘并重写 leader 目标
- 已停止上一轮新代码实施；当前进行任务书交付，保留未提交改动。
- 以 `docs/research/2026-10-31-environment-resurvey.md` 为最新环境/测试基线：插件已恢复为0.7.5且挂载，旧缺载荷结论失效；TSim认证及原生视觉仍待核验。
- 最新测试：TypeScript 202、核心 Rust 300、宿主58 全通过；新包生成但当前运行的仍是旧包。
- 独立评审已确认历史加载未读数伪清零问题，未修复；周边API仅函数落盘，未接线。
- 后续目标增加持续按行为本地提交、同步文档，并把本仓库建设为未来 TSim_CS 携程客服平台接入示例；TSim_CS 当前只读参考。

以下保留上一轮过程记录，冲突时以上述最新环境重勘为准。

## 目标与授权
- 直接完成实现、测试、打包与视觉/程序评审；不只交付任务书。
- 官方网页、旅游商家桌面版及原有自制插件是对照；消息/身份准确性优先于视觉。
- 唯一出站测试范围：订单 `1359049237105048`，客户 `_tihk******doml43`。其它会话只读。
- 默认保留本产品多账号/强提醒结构，以真实字段对齐消息、列表、侧栏；不编造未读、成员数或订单信息。

## 分工
- 主代理：ego-browser TaskSpace 1 / p1 官方取证、集成、安全边界、打包、实机测试及独立复核。
- data_contracts：web-adapter、IPC、Rust display/adapter/DTO，以及新命令注册精确增量。
- ui_alignment：main UI、ui-kit；与数据 owner 协调合约。
- desktop_plugin_evidence：官方安装/插件只读诊断与研究记录。
- 不回退他人修改；共享接缝先协调；仅主代理创建子代理。

## 已实测基线
- git 工作区开始时干净。
- Node 22.14.0，低于 package engines 22.18；原 npm test 因 .ts 加载失败。兼容执行 `node --experimental-strip-types --test 'ui/**/*.test.ts'` 为189通过。
- `npm run typecheck` 通过；`cargo test --workspace` 完整通过。
- 当前客户端 release/macos 中 app 已登录并可通过原生 UI 读取。
- 官方网页 ego-browser 登录可用；受控 gid 已由实际订单侧栏及网络确认（原始含业务数据的证据仅存 /tmp/vbk-parity-20261031）。

## 已确认差异 / 进行中
- 会话错误使用产品 groupTitle；消息发送者无姓名/头像。
- 历史缓存误当完整历史；缺分页；旧消息显示发送中；撤回原文未隐藏；内部 session_status 可见。
- fromJid 的 room 地址未用于发送目标与补偿 gid，导致发送前失败。
- 16位订单校验/高亮失败；图片仅显示URL；侧栏字段不完整；草稿与历史滚动行为待修。
- 官方桌面版 CUA 连接超时；安装签名有效，进程运行；插件0.6.0回执残留但当前官方包不含启动器/助手，不能宣称插件在线运行。

## 验收纪律
- 不删除/跳过测试、不降低断言、不把 mock 演示当真实收发验收。
- 浏览器验收只能用 ego-browser；已有 Playwright smoke 不执行，另做 ego 实测。
- 每轮按数据→UI→打包→实机读回推进；同一失败三次改路线并记录。
- 不将凭据、签名URL、客户正文提交到仓库；测试使用脱敏最小样本。
- 完成时明确已证实、未证实和实际产物路径；继续任务先读本文件。

- 第4轮后P1发送身份竞态修复已独立提交a0b4416，真实微任务及投影异常红→绿，独立暂存typecheck/6tests/bundle及Sol独立评审通过；旧PID90073尚不含修复。后台调度修复/引用安全与订单链在接续，下一次完整轮数为5。

- 第4轮运行证据已独立核对并提交cf0909c；订单完整块暂存快照首次提取发生重复import/helper和mapper变量缺失导致typecheck失败，精确修正后typecheck/18tests/bundle通过，未修改工作树既有实现或削弱测试。订单宿主及独立评审进行中。

- 第4轮补充只读实机：05:45加载更早消息后停留历史区，未跳底；05:46 Sara商户同事的独立接口头像与右侧消息已见，客户订单卡左侧。截图/AX为/tmp/vbk-goal-20261031/round4-{history-after,sara-history}.*；未证明精确滚动锚点稳定。

- 订单完整行为已提交c670397：独立暂存typecheck/bundle/29项与host102通过，Sol评审两项身份P2已修。原6项保留，5项新身份边界红→绿；当前PID90073仍未含修复，第5轮待验。

- 成员精确机器人昵称显示e22e3ea已提交，独立typecheck/5项真实面板头像/bundle与评审通过。仅完整键映射，UID与接口昵称原值保留；第5轮原生待验。

- 媒体显示完整链463baa3已提交，独立12TS/host103/typecheck/bundle与评审通过；mapper漏字段6红、宿主漏URL真红→绿，保留出站媒体未实现。未知核验普通history查询间接标已读P2已转专用无广播lookup，真实组合1receipt红→0receipt绿，尚待完整块提交。

- 历史完整19路径已独立typecheck/TS444全绿，但评审额外碰撞与广播先到锚点反例失败，未提交。完整index冻结tree21b12e3b343615d75fc2f043020450a8431322a1与/tmp/vbk-history-frozen-20261031.patch，继续修复；暂存切为独立unknown完整块，其typecheck/TS446/host105/bundle全绿，最终评审进行中。
