# 第十五批：设置生效语义与窗口标题

状态：本批本地修复、独立复审与候选构建通过，完整目标继续；仅隔离副本。

## 设置范围与实际缺陷

I-12对应任务栏/Toast/托盘；本批设置语义对应I-20“没有只存储、不生效开关”。当前范围决定及docs/dev/05-store保留最小状态，客户消息正文只在有上限的内存缓存中，不按归档SQLite设计新增正文数据库。

调查确认display.gpu、dnd.follow_system、storage.cache_days和storage.cache_mb没有运行时消费者，生产设置页已经禁用，但prefs_set和mock仍接受并返回保存成功。已在宿主写入口与实际local事务入口精确拒绝这些未实现写入，保留旧配置读取与其他已实现设置；mock同步拒绝并独立2/2验证无状态/事件变化。此修复不等于GPU控制、系统专注状态采样或缓存保留天数已实现。

现有固定出站裁剪和无引用附件GC不是cache_days功能：只允许其各自已完成/无引用的候选；不得删除账号namespace、草稿、unknown出站或WebView profile来模拟清缓存。

另发现prefs_set reminder路径先改运行时并排通知effects、后持久化：写盘失败会返回错误，但实际设置已经生效。已改为持久成功后应用本次布尔字段，同时保留写盘期间并发notify_set_*的其他字段，不在磁盘IO期间持有Cores锁。偏好专项16/16、root全宿主402/402及严格Clippy通过；独立复审prefs16/16与mock2/2通过，旧13个偏好测试逐字保留。目录fsync失败可能发生在rename之后并留下完整新文件；保证的是失败当次runtime/mirror/pending不推进，不承诺磁盘回滚。

## 窗口标题

6份HTML静态标题作为脚本启动前fallback保留。六个入口启动时设置词表标题；login/alarm新增独立短title，其他复用既有词条，不复用含动态数量的提醒标题。HTML/CSS检查未发现其他用户可见中文正文/属性遗漏。

独立7/7测试执行AST提取的真实早期初始化路径与真实词表，覆盖后续启动失败前已设置标题；8个生产文件去除新增语句后与before逐字节一致。owner六app667/667、root最终全量1498/1498（含mock新增2项）、typecheck及203夹具/7项门禁通过。基线、精确差分和证明为vbk/.runtime/round15-window-titles*。

## 构建与验收边界

第一轮universal构建73650在中止请求到达前已exit0，两个程序双架构检查通过。但其启动后源码继续变化，只作中间构建，不作为最终冻结产物验收；最终候选已在设置修复及独立复审后重新构建。未安装、签名、发布或操作真实业务数据。

最终冻结候选构建session18057 exit0；app共51,314,807字节，包内主程序与桥接程序均验证arm64+x86_64。产物manifest位于.runtime/round15-app-manifest.json。源代码与快照一致；无Developer ID签名、公证或Windows实机验收。测试日志/tmp/vbk-round15-final-ui-tests.log、/tmp/vbk-round15-host-tests.log、/tmp/vbk-round15-host-clippy.log。

本轮prefs真实before位于仓库根.runtime/round12-prefs-baseline/vbk/src-tauri/src/prefs.rs（目录误沿旧批次名称，实际本轮修改前创建），SHA256 052e5498fb9de317b593c6eedac875f72e1b471a49df367bc8aaf6662742425f。

源码快照已创建并逐成员读回验证：1409文件、62,626,630字节，.runtime/round15-source-snapshot.tar.gz（SHA256 1494f917fd9c1fbcb22e481dc59df304f3c7fab7c41042181b7cbe8f6640eaa9）；manifest及receipt同前缀。快照先于本段最终报告更新，不声称包括后补的验收报告文字。

最终UI与app发布扫描均clean，报告.runtime/round15-{ui,app}-release-scan.json。产物仅为本地未签名候选，不能替代干净机器安装、真实账号、通知权限、签名更新与Windows验收。
