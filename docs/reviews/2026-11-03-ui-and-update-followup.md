# 第十二批：界面文案与更新器不确定结果清理

状态：进行中，完整目标未完成。只写隔离副本，不发布或安装。

## 定时勿扰复验

第十一批两处回拨暂停丢失已独立复验通过。root最新宿主399/399及严格Clippy通过；真实OS时区/原生通知仍未验收。

## 文案迁移

TSim操作浮层与未知发送核验18词条已独立19/19，反向还原与before逐字相同，授权/iframe来源/租约/销毁及unknown只读流程保持。快捷回复与推荐43词条独立17/17；实际UTF8反向核对与真实before一致，原两个测试字节不变。所有基线位于vbk/.runtime/round12-*-i18n-baseline；中央词表由root串行接入。

## 更新器核心清理

只读核查确认宿主更新器与真实feed尚未接线；core的InstallerHandedOff只代表启动调用成功，不表示安装完成。launch_installer返回错误也不能证明安装器未运行，旧run统一删除下载文件不安全。root改为仅下载/归档验签/平台验签失败清理；启动结果不确定时保留文件，保持terminal、拒绝后续事件、不冒充handoff、不自动重试。core-update43/43通过，独立复审也实际43/43通过；crate/trait文档已同步说明启动不确定性。before为vbk/.runtime/round12-update-cleanup-baseline/flow.rs。

该修复不完成I19。计划仍要求先做两平台本地fixture原型，证明归档minisign→隔离解包→对实际候选平台验签→启动/替换的顺序与失败无替换；Windows环境、生产身份/证书、固定HTTPS feed、签名key-status及持久防回滚状态尚未具备完整验收。不得把Rust fake流程测试称为原生更新通过。

## 整树与产物状态

root前端1466/1466、typecheck、UI build/bundle、203门禁夹具及6项现有门禁通过，发布UI扫描clean；宿主399/399及严格Clippy通过（随后core-update变更另测43/43与独立复审）。最终通用构建92578进行中，未安装/发布。CJK审计439节点/14文件，仍含247mock及上游协议数据；未宣称I29全完成。

## 下一文案验收范围（不以豁免代替迁移）

439个剩余节点中247为发布剔除的mock。package-preview的DETAIL/LIVE/CDR三组Set共38命中，companion-card的field/cdrField/get参数共30命中，均为上游字段键；后续门禁只能精确限定AST上下文与已核实字面值，不能豁免整个文件。companion-card-style的命中实际为CSS `content: "源"`，是可见标签而非字体名，应真正本地化。中文状态正则未在当前字面量scanner覆盖范围，不能由零字符串命中宣称完整本地化。其余package-detail、显示/格式化、adapter错误、附件内部错误仍待处理。

## 最终本地候选与归档（2026-11-04）

通用构建92578成功，主程序和bridge均为x86_64+arm64，包51,352,759字节，identifier为tech.tsim.vbk.client，发布扫描clean。主程序SHA256 `6fb4a3beecb93fa8a80a16a2bde77b32b5bfd1288cc9a7072108f521a5dbeffe`；bridge为`512cc3ed86a899312628f822347cfc41c99161d44349fe19172012d1791ced7e`。详情`.runtime/round12-app-manifest.json`、`round12-app-release-scan.json`。显式不签名，未安装、发布或替换用户运行应用。第十一批中断的旧构建不再作为候选。

当前源码以`.runtime/round12-source-manifest.json`和实际`round12-source-snapshot.tar.gz`归档，逐成员哈希读回验证结果存`round12-source-archive-receipt.json`；不含运行时、依赖和编译产物。本批代码/本地测试收口，完整目标仍未完成。
