# 第十三批：套餐详情、格式与核心整树检查

状态：本批本地检查通过，完整目标继续。仅隔离副本。

## 文案与界面

套餐详情25词条独立12/12，时间/机器人显示名/CSS标签6词条独立27/27；反向还原与真实before字节一致，原测试断言保留。API字段、scope/epoch、只读查询、键盘与关闭路径未改。基线为vbk/.runtime/round13-{package-detail,format}-i18n-baseline。

root前端1474/1474、typecheck、UI构建/bundle、203门禁夹具及6项现有门禁、发布UI扫描通过。CJK审计406节点/9文件，含247mock、68上游协议字段，不宣称全部迁完。

ego-browser空间5/p1使用固定本批UI目录4185。先打开真实主窗演示会话，默认mock无来源字段，未据此伪称标签已观察；随后在同本地来源使用真实companionPackageCard模块和显式合成fixture，实际DOM属性为“源”、computed ::before.content为“\"源\"”，截图`.runtime/round13-source-label.png`。这是组件CSS渲染验收，不是生产接口或真实账号验收。旧4183/4184测试server已按原session结束，新server6534继续。

## 核心全工作区

`cargo test --workspace --offline`共578项通过（54条suite总结含doc-tests零项），日志`/tmp/vbk-round13-core-tests.log`。之后严格workspace Clippy发现新增DND测试unwrap_used；改成带明确原因的expect，失败仍panic，不弱化断言。随后严格Clippy通过。fmt检查只发现core-notify engine与environment新增DND区格式差异，已用rustfmt整理并全工作区fmt check通过；environment专项10/10再过。真实before在vbk/.runtime/round13-core-lint-baseline。不是把宿主399项当成核心工作区验证。

## 更新器平台原型条件

本轮实际只读`security find-identity -v -p codesigning`返回0个有效身份；codesign/spctl存在，minisign命令未找到。未创建或信任证书、未修改Keychain/TCC/全局信任。使用macos-signing-permissions技能核对边界；原生成功验签路径及双平台原型仍未执行，不以无签名候选代替。完整宿主更新器仍未接线。

第十二批原生候选与源码归档保留；本批UI改动尚未重建原生候选，未安装/发布。
