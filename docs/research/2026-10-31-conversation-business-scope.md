# 会话业务类型展示字段与状态1（2026-10-31）

基线9731e003afc332c1ebb66034e17ef198826bc67c。本块补齐适配器→host cache→UiConversation的业务类型字段，供独立UI业务分栏使用，不变更持久ConversationFact结构，不添加网络/发送/已读操作。

## 官方静态证据

本次只读重新计算 C:\Users\tashi\AppData\Roaming\vbk-electron\dist\js\index-CpM_cEEe.js 的SHA256，得到791902faae01b3aa66dc57f1523cf34717f0e81b78f13b0cbd2865969cc837f6。该文件当前明确autoActive=1、manualActive=2、finish=4；ACTIVE.values包含前两者，FINISH.values包含4。业务函数按conversationType与serviceType划分：BC为B2C/C2B/B2MC，BOP为B2O/O2B/B2B，O2B且serviceType=2573例外只归BC。对应UTF-16偏移及计数规则参见[官方列表口径](2026-10-31-conversation-list-counts.md)。本块没有读取官方缓存、登录凭据、客户数据或在线接口，不用静态规则推断任一现场差额必然来自何处。

## 展示协议

UiConversation新增可选conversation_type:string|null，兼容旧DTO缺失该字段。新的toDisplayConversation生产者始终输出该键：有效值为非空、非纯空白字符串，UTF-16长度不超过64，不含C0/C1控制字符（U+0000..001F、U+007F..009F）；无效或缺失为null。未知合法短字符串原样透传，不trim、不做大小写归一、不推断为已知类别；例如“ B2C ”仍是未知，Unicode短字符串也可保留。service_type沿既有字段透传。

Host DisplayConversationDto在持久fact之外持有Option<String>。旧wire缺失可读为None，新host序列化明确输出null；已有值经真实DisplayCache和UiConversationDto投影保留。Host在整个batch写cache前验证新字段：UTF-16计数与JS一致，32个emoji占64单位可接受，33个拒绝；非空白、无控制字符；错误型在Serde入口拒绝。非法直接bridge payload被拒绝，不静默改成已知类型，失败不替换已缓存合法行。有效未知值不丢失，分类由UI的精确表执行，缺失/null/未知保持可查看的未知业务。

数值status=1现在明确映射active，与2一致；4为finished。字符串“1”、其它未知数值/错误类型仍为unknown，不借后备解释为已核官方状态。不改变ConversationFact持久schema，也不修改inGroup、isOwner或未知状态的发送准入。

## 真实红绿与验收范围

%TEMP%/vbk-windows-20261031中的证据：

- r7-business-producer-red.log：9731e00实际toDisplayConversation丢conversation_type，初始20失败/1通过，退出1。
- r7-business-status1-red.log：实际mapConversationStatus(1)为unknown，与期望active不符，退出1。
- r7-business-host-red.log：未增host字段/验证时，真实Serde→DisplayCache→UiConversation投影、旧字段兼容、类型/长度拒绝5项全失败，退出101。
- r7-business-host-green.log：新增字段和边界后，5项通过；最终full host177/177、0失败/ignored、退出0，见r7-business-all-host-final.log（末CARGO_EXIT=0）。
- r7-business-joint-all-ts-final.log：与UIowner冻结8文件patch联合验证654项通过、0失败/skip/cancelled；其中数据专项25项，涵盖已知/未知/空/控制字/UTF-16边界及status1。
- r7-business-joint-typecheck-final.log、r7-business-joint-bundle-final.log：联合类型检查和实际bundle均退出0。

TS命令为node --experimental-strip-types --test ui/packages/web-adapter/src/conversation-business.test.ts、npm test、npm run typecheck、npm run bundle:ui；host命令为cargo test --manifest-path src-tauri/Cargo.toml business_display --lib及cargo test --manifest-path src-tauri/Cargo.toml --lib。所有自动化在独立9731e00快照执行，测试只用合成数据。UIowner8文件不包含在本数据patch中，联合验证不等于本机桌面验收；忙账号仅被动接收，由主代理后续比对。未修改session/stores/rpc/clock/mark-read、主工作树或官方安装文件。
