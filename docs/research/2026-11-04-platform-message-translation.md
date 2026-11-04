# 平台消息翻译：官方实现与本项目的对应

2026-11-04。证据是官方客户端 `imWindow-DeDFr-7q.js` 的静态代码，加 `docs/api/evidence/2026-10-30` 里 12 次 `batchTranslateByMsgIds` 的脱敏样本。没有抓到俄语等外文消息的真实响应，真实账号下的表现仍待实机核对。

## 官方怎么做

**何时请求**

- 可翻译条件：`messageType == 0` 或 actionCode 属于白名单，且 `serviceTypeOptions[serviceType].translate_message == "Y"`。选项来自 `getVenAgentByUid` 的 `venAgentOption.serviceTypeOptionList[].venOptionList[]`。
- 自动路径：会话开启翻译或 `autoTranslation` 开启时，消息列表每次变化，都把“可翻译且不在已翻译列表里”的 ID 发出去。
- 手动路径：消息悬浮菜单或右键的“翻译”只发这一条，底部按钮发当前列表全部。

**请求体**

```json
{"head":"getHead()","source":"AUTO","target":"translateLocle || locale","chatType":"会话 chatType","sessionId":"","groupId":"gid","bizType":"+serviceType","appId":"100017720","messageIdList":["每批最多 20 个"]}
```

`target` 默认是显示语言 `locale`（`LOCALE_TYPE.zhCN = "zh-CN"`），也可以由“翻译为”菜单选择。

**响应**

- 成功判定走 `checkResponse`。样本的 `ResponseStatus.Ack` 为 `Success`，`status.code` 是字符串 `"0"`。
- `translateMessageList[]` 是完整消息行，`msgId` 和 `messageBody`（译文）是关键字段；卡片类的 `messageBody` 是 JSON 字符串。
- `supplier` 是翻译供应商名。
- `idWithTranslatedMap[id]` 按官方 `isTranslated: !map[id]` 解读：`true` 表示这条**不算已翻译**，不显示译文。样本里两种取值都常见，单条样本都是 `true`。这个字段名的字面意思和实际语义相反。

**显示**

- 翻译块放在同一气泡内、原文下方：先渲染译文消息，再显示“来自 XXXX 翻译”和赞/踩。
- 只有 `isTranslated` 才渲染翻译块，自动翻译过程中行上什么都不显示。
- 只有手动翻译时才显示“正在翻译…”；空结果态是“未找到翻译结果 + 点击重试”。

## 我们原来为什么不稳

1. 气泡里放了常驻的“翻译”按钮，点击后实际是**重读一页历史**，再去读返回值里的 `translation`。而这个返回值按设计就不带译文（译文随后异步推送），所以点击几乎总是落到“翻译中，点击重试”。
2. 自动翻译只请求一次且吞掉所有错误。入站消息遇到索引延迟或网络失败后，只能靠下次读历史才可能恢复。
3. `idWithTranslatedMap=true`、译文与原文相同（比如中文消息），这两种情况行上也永远留着按钮，看起来就是“一直在等翻译”。
4. 请求没有带 `chatType`（官方带）。这是否影响结果未证实，现已对齐。
5. 主窗合并时，后到的 `translation:null` 记录会盖掉已有译文。

## 现在的实现

- 新增窄命令 `im_translate_messages` / 适配器 op `im.translate_messages`，每个 ID 明确返回 `translated`、`not_needed`、`missing` 或 `unsupported`；请求失败走错误返回，不再和“没有译文”混在一起。
- `ui/apps/main/inbound-translation.ts` 只处理当前打开的会话：
  - 最新消息优先，每批 20 条，并发 2；
  - 没有结果或失败时，按 1s、3s、8s 重试后结束，单次请求最长等 30 秒；
  - 10 分钟内的新消息再追加 15s、30s。其中非中文文本即使被答 `not_needed`、`unsupported` 或译文与原文相同也继续重试，因为实机多次出现新会话首条消息静默无译文、同会话随后的通知或消息却有译文的情况（根因未抓到响应证实）；
  - 这类外文新消息重试用尽后显示“未找到翻译结果 + 点击重试”，不再静默；
  - 新消息上屏时，对 10 分钟内已结束且没有结果的行重新请求一轮，对应官方“列表变化就重发未翻译 ID”；
  - `idWithTranslatedMap=true` 的文本行，只要原文不是中文且译文与原文不同就显示。这一点有意不同于官方；
  - 每次未完全翻译成功的应答写一行宿主日志（`vbk.log` 中的 `im_translate_messages:`），只含计数、原因名和会话短哈希，用于下次复现时判断携程实际答了什么；
  - 过程中行上不显示内容，结果用尽才显示“翻译失败/未找到翻译结果 + 点击重试”；
  - 手动点击时显示“正在翻译…”，并重置重试次数。
- 读历史和实时消息不再附带翻译请求。译文写入宿主显示缓存，重读时保留。

## 与官方的已知差异

- 官方尊重 `automatic_translation` 开关。本项目继续对当前会话已加载的消息全部自动翻译，不看这个开关（这是修改前就有的行为，也符合“已上屏的每一条都翻译”的要求）。
- 官方隐藏 `idWithTranslatedMap=true` 的行；本项目对外文行照常显示其正文（见上）。
- 目标语言固定为显示语言，没有“翻译为”菜单。
- 只翻译文本和系统通知；白名单卡片类消息（消息类型 7 等）不翻译。
- 没有做赞/踩埋点。
