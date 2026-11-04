# 第十四批：运行时文案、适配器文案与中文门禁

状态：本批本地验证通过，完整目标继续。所有修改仅在隔离副本。

## 文案和错误边界

主运行时新增22词条；附件11个内部异常站点改为10个固定ASCII Error.message，不新增code属性，不改变错误分类。三个生产UI出口继续显示固定通用提示；失败保留原草稿与附件，不回显内部路径、不自动重放。独立审查对真实before还原后确认产品AST一致，原测试完整保留；75/75专项与typecheck通过。

适配器新增129个本地类型化词条、148处引用，保留原中文和英文，不引入UI-kit依赖。三个生产文件还原后与真实before逐字节一致。SearchError、错误code/detail/retryability、音频类型4、只读搜索及unknown不重发边界保持。独立90/90通过。审查发现一个旧SDK零发送断言被误删，已原样恢复，独立搜索专项再次13/13通过。

基线和精确变更证明保存在vbk/.runtime/round14-{main-runtime,adapter}-i18n*。

## 中文字面量门禁

新增精确上游协议字段分类：package-preview的三个顶层const Set及companion-card中经绑定解析和固定helper AST校验的字段读取。不是按整个产品文件豁免；相同文本用于其他UI调用仍报告。另仅排除发布包已剔除的IPC mock.ts，邻近生产文件继续检查。原catalog/test白名单保持。

这些是对I-29原catalog/test白名单的显式补充，不代表原始中文文本为零。检查范围是TS/JS字符串、模板和JSX；不覆盖HTML、独立CSS、正则和动态服务器内容，也没有实现第二语言切换。首次独立审查发现Set被复用为UI输出可绕过例外判定；已补冻结safeFields/packageInfo校验函数AST及Set引用约束，禁止直接导出或额外引用，records别名也限制为同一外层函数中的const。新增反例和独立复审通过，已接入第7项强制门禁，并在I-29计划写明范围修订。最终门禁20/20测试、203/203夹具、7项生产门禁零违规。

## 本地验证

首次全量1487项中1486通过，发布包扫描测试因与独立bundle同时写同一ui/bundle目录而ENOENT。此失败保留在/tmp/vbk-round14-ui-tests.log；不能记为全绿。已将release测试改为调用方自建的空临时输出目录，生产默认目录不变；定制目录拒绝非空与符号链接且不由bundle删除。专项9/9，全量重新运行1488/1488通过（/tmp/vbk-round14-ui-tests-rerun.log）。独立复审确认默认输出删除范围与原断言保持；Windows测试链接类型使用junction以避免普通目录symlink权限要求，尚未在Windows实跑。仍共享ui/dist编译输入，不宣称完整构建并发安全。typecheck、UI构建与bundle已通过；当时发布UI扫描clean（.runtime/round14-ui-release-scan.json）。

本批没有真实账号发送、外部探测、安装或发布；最新原生候选仍为第十二批，不含第十三、十四批UI改动。真实平台、正式签名更新、受控业务样本及其余计划缺口继续保留。
