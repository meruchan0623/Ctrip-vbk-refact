# 客服状态与个人设置实施调查

> 历史调查/审查材料：事实与证据保留，本文原有实施建议、旧功能范围和验收工作包不作为当前要求。当前只做网页 IM 范围及唯一扩展“独立强提醒窗口”，以[当前范围决定](../decisions/2026-10-30-web-only-scope.md)为准。新方案尚未因此获得原型或发布验收。

2026-10-30。本轮为客户端分发包的静态调用链分析，没有切换生产客服状态、保存设置或发送消息；接口可调用性、服务端分配规则仍待运行时验证。补充既有 IM 选型调查，不能当作新增抓包证据。

## 1. 客服工作状态

证据：`vbk-electron/resources/app.asar.unpacked/dist/js/BaseController-_xbuiF6A.js` 中 `jn`、`N_`；`index-tUMj2i9C.js` 中 `St`、`Ge`、`Ct`。压缩文件通过函数名与接口字符串定位。

| 官方界面 | 枚举 | agentStatus |
| --- | --- | --- |
| 在线 | IDLE | 0 |
| 挂起（用户所说挂机） | HANGUP | 1 |
| 离开 | LEAVING | 2 |
| 下班 | GETOFF | 3 |

源码未定义第五种独立的“离线”工作状态。IM 页另有 `offline`（网络不可用）和 `lostConnect`（连接断开）提示，不能与 `GETOFF` 混为一谈。界面中的 `offline` 动作有映射为 GETOFF 的调用路径，但网络离线本身不是该枚举。

### 状态切换调用链

1. 状态菜单和个人资料的工作状态入口共用 `St`。
2. 请求 `POST /restapi/soa2/16037/setVenAgentStatus`，body 为 `{head: getHead(), agentStatus: 目标数字}`，调用选项为 `{browser:true}`。此处没有显式传其他客服 UID，已证实的是当前登录身份的状态切换，不是管理员任意控制其他客服。
3. `checkResponse` 判定业务失败后显示错误并返回。
4. 成功后请求 `getConversationList`，读取服务端 `currentStatus`。
5. 广播 `updateWorkStatus {status, currentBuid}`；主界面与个人资料按账号过滤并更新显示。`index-BvtV6ODG.js` 的账号区域也会初始化读取 `currentStatus`。

另有 `imWindow-DeDFr-7q.js` 的 `obt` 路径：将动作 `offline` 映射为 GETOFF，其他动作映射为 IDLE；成功后直接广播目标状态。同一文件还提供重新读取 `currentStatus` 的回调。重构时建议统一为服务端回读后确认，避免多个入口行为不同。

**尚不能由这些代码确定**：挂起是否停止分配新客、已有会话是否继续、下班是否自动转接、离开状态多久恢复、断网多久由服务端判离线、其他端登录是否覆盖状态。这些是服务端业务规则，不应按状态名称猜测。

### 特定角色的上线验证

`St` 在 `roleId == 14`、当前为 GETOFF、目标不是 GETOFF 时先进入 `bt` 验证组件：

| 接口 | 请求关键字段 | 用途 |
| --- | --- | --- |
| `/20016/checkVBKRealNameAuthStatus` | `head: getVBKHead()`、`ticket` | 检查实名验证状态 |
| `/20016/startVBKRealNameAuthTask` | `head`、`channel:"im"` | 获取验证地址和任务 token，生成二维码 |
| `/20016/getVbkRealNameTask` | `head`、`token` | 每秒轮询扫码／人脸验证结果 |

以上路径均位于 `/restapi/soa2` 下。检查响应包含需人脸验证、需重新验证、未实名、未绑定企业微信等分支；成功后执行原定状态切换。验证 ticket 以账号区分保存在 localStorage。源码存在未知状态／部分请求异常时继续成功回调的分支，这是旧客户端行为，不应据此认定服务端允许跳过验证，重构应明确处理失败与未知状态。

## 2. 个人设置：服务端业务配置

主要证据为 `index-tUMj2i9C.js`；接口映射为 `BaseController-_xbuiF6A.js`。打开设置先调用 `getVenAgentByUid`，读取 `venAgent` 与 `venAgentOption.agentOption.venOptionList`。

以下接口省略 `/restapi/soa2/` 前缀。

| 功能 | 读取／写入接口 | 实施细节 |
| --- | --- | --- |
| 个人资料 | `16037/getVenAgentByUid` | 显示头像、昵称和工作状态；当前 `Ct` 组件没有发现头像／昵称提交调用，不能承诺支持修改 |
| 工作时间 | `16037/getAgentWorkingSchedule`、`getTimeZoneList` → `modifyAgentWorkingSchedule` | 读取带 `head, locale, venAgentUid`；保存带 `head, workingSchedule`，含时区、周一至周日、特殊工作日 `workdays`、休假日 `offdays`；成功广播 `updateWorkTime` |
| 快捷回复分类 | `16037/getCategories` → `createRootCategory`、`updateCategory`、`deleteCategory`、`updateCategorySortNo` | `categoryType:"CUSTOMSCRIPT"`；个人 `VAGENT`、团队 `VSKILLGROUP`；团队编辑前端要求 `jobPosition == "LEADER"` |
| 快捷回复条目 | 同服务 `addCustomerScript`、`updateCustomerScript`、`deleteCustomerScript`、`updateCustomerScriptSort` | 字段包括 `content, id, ownerType, categoryCode`；拖拽排序发送 `sortInfos:[{id,sortNo}]` |
| 自动答复 | `16037/getWordsAboves` → `saveWordsAboves` | `welContent` 欢迎语、`leaveContent` 离开／下班、`towContent` 非工作时间；保存 `{head,...表单值}` |
| 自动翻译 | `getVenAgentByUid` → `16037/modifyVendorAgentOption` | 读取 `automatic_translation`，保存 `automaticTranslation:"Y"/"N"`，广播 `updateAutoTranslate {autoTranslate,buid}` |
| 自服务设置／分配失败提醒 | `15529/queryVbkSetting` → `updateVbkSetting` | 以 `providerId` 为范围，写 `settingList`，删除通过 `needDelete:true`；包括应用通知账号、通知时间、短信号码和邮箱配置 |

接口映射中 `modifyVendorAgentOption` 原字符串没有开头 `/`，正式对接须通过请求构造层核实完整 URL，不能机械拼接。

权限与校验：

- `view_work_time` 控制工作时间标签是否可进入（缺失时默认可见）；`update_work_time == Y` 才显示编辑。
- 排班保存校验特殊工作日与休假日重复、周期时间不完整；成功后广播刷新其他窗口。
- `update_auto_reply` 控制自动答复入口／编辑（缺失时默认允许）。界面说明欢迎语用于工作时间进入聊天，离开语用于离开／下班，非工作时间语用于非工作时间进入聊天。源码提供配置管理证据，尚不能证明实际自动发送由哪一端负责。
- 自服务设置同时受 `electronGaryConfig.json` 灰度配置和响应 `hasVbkSettingAuth` 控制，不是所有客服都有该菜单。通知账号以 `12405/queryUserInfoList` 校验是否存在且启用。
- 自动翻译旧实现先广播和修改 UI，再请求保存，并吞掉异常，没有可靠回滚／业务成功检查。重构应在成功后确认，失败恢复旧值。
- 上述前端权限条件只能说明菜单行为，不能代替服务端鉴权验证。

## 3. 桌面偏好：独立于个人业务设置

证据：`settingWindow-nVV_27Vl.js`。桌面设置通过桥接 `setUserPrefrences` 等方法处理，不应将所有开关都映射为 SOA 接口。渲染层桥接已确认；主进程保存与广播的补充证据见下节。

| 分组 | 已确认界面选项 |
| --- | --- |
| 通用 | 每条消息时间、精确到秒、链接可点击、新页面全屏、开机自启、会话标注、拼写检查、本地聊天缓存 1–365 天 |
| 显示 | 语言、缩放 0.5–1.75、GPU 加速（提示重启生效） |
| IM 通知 | 新消息通知／弹窗／详情／声音，弹窗位置，回复超时提醒及 30/60/90/120 秒阈值 |
| 系统通知 | 系统通知／弹窗／详情／声音、事件未处理红点；声音设置可跳转远程通知管理页 |
| 快捷键 | Enter 或 Ctrl+Enter 发送、截图、显示／隐藏工作台 |
| 工具 | 打开安装／数据目录、清缓存 |

“个人设置”入口复用上述业务组件，工作时间、快捷回复、自动答复并非桌面本地偏好。

## 4. 重构与接口选型决策补充

1. 工作状态管理归属 IM 业务层，使用服务 16037；它与 SDK 的 WebSocket 是否连接、账号是否登录分别建模，不能靠断开 Socket 实现下班。
2. 前端选择目标状态 → 按需验证身份 → 服务端写入 → 回读 currentStatus → 按账号广播。增加请求进行中提示，防止连续切换响应乱序。
3. 排班、话术、自动答复、自动翻译保留服务端配置来源；桌面通知／快捷键／缩放进入本地偏好模块；自服务提醒带供应商作用域单独处理。
4. 网页端与客户端能否共用这些接口，仍需比较网页实际请求与鉴权。本轮证明客户端实现与服务分层，不构成网页兼容性确认，也不足以决定 IM 传输选型。
5. 后续运行时取证应观察正常人工状态切换：记录请求字段、业务响应、回读值、其他窗口同步、会话分配变化；另验证人脸认证、无权限、网络失败、双端状态竞争。实际修改排班／自动答复等需选用可恢复的测试场景。

## 5. 补充核对：本地偏好的保存与生效

再次直接核对分发包代码后，补充以下实现链路。主进程证据取自 `resources/TripVendorCompanion.Install/original.asar` 内的 `dist-electron/main/index.js`，preload 证据取自同包 `dist-electron/preload/index.js`。这是助手安装目录的备份包，未验证其与官方原始发行包字节一致；以下结论限定于该样本，仍为静态分析，不是实机抓包。

- **读取与保存**：IPC 名称为 `get_user_preferences` 和 `change_user_preferences`。PreferencesManager 初始化从存储键 `USER_PREFERENCE` 读取，合并默认值；修改时合并旧值与提交的字段，再写回同一个键。该路径不携带 buid，是此应用数据目录内共享的偏好，不是每个客服账号独立一份。未读取真实用户配置文件。
- **多窗口同步**：保存后通知主窗口、提示窗口、超时提醒窗口和登录窗口；主窗口再向各账号下的 BrowserView 广播 `change_user_preferences`，并设置缩放比例。语言修改走单独的 locale 分支并提前返回。
- **快捷键**：修改截图或工作台快捷键后，注销已注册快捷键，再调用 Electron `globalShortcut.register` 注册；冲突或无效时记日志。当前保存链路使用 `ipcMain.on`，不能将“事件发出”视为操作系统注册成功。
- **开机自启**：通过 `app.setLoginItemSettings({openAtLogin, path:process.execPath})` 生效；开发环境不启用。
- **GPU**：在应用启动阶段读取禁用加速字段；样本中的对应启动条件含 Windows 平台判断。因此界面出现开关不等于每个平台都有相同效果，需分别验收。
- **作用域例外**：`settingWindow-nVV_27Vl.js` 的消息声音先按 `buid` 查询账号声音，无结果才回退到全局偏好 `msgVoice`。不能把设置页中的所有选项一概视为全局。

实施建议：本地偏好保存结果与副作用结果分别返回，例如“配置已保存，但快捷键被占用”；服务端业务配置则必须检查业务响应后更新显示。工作状态、账号登录状态、IM 连接状态分别建模，避免把下班实现成退出登录或断开连接。

## 6. 最终审查补证与实施门槛

15:35网页只读复核已实际观察到 `getVenAgentByUid`、`getConversationList.currentStatus`（number）、`getAgentWorkingSchedule`（head/locale/venAgentUid → workingSchedule/bizResponseStatus.resultCode），见 [网页复核](2026-10-30-web-im-observation.md#最终对抗审查只读复核1535) 及其脱敏JSON。对照相同网页主包，状态枚举同为IDLE=0/HANGUP=1/LEAVING=2/GETOFF=3，状态写入后回读currentStatus的静态链路亦存在。此前“只掌握客户端静态接口”已被这一小部分读取与网页静态证据补充；**写路径、权限和分配语义仍未动态验证**。

实施时分开维护：账号认证状态、IM连接状态、客服工作状态、会话责任归属。登录成功不得自动推断上线；WebSocket断开不得自动写GETOFF；客户端退出/崩溃是否需要远端改状态必须由服务端行为证据决定。状态修改串行化并绑定AccountContext与操作版本，超时标为“结果待核对”，先回读再判断；禁止退回旧UI值后悄悄重复发送。

本轮冻结的命令边界为按业务动作定义类型化命令，不把所有个人设置塞入任意op/payload转发。每一项写入需要成功样本、业务拒绝样本、权限样本和超时后回读路径。只读身份/排班返回Ack Success不等于状态/排班写权限；前端显示LEADER或灰度菜单也不代替服务端授权。
