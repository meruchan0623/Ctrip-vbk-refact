# 快捷回复分组管理端点契约（16037）

2026-11-05，Asia/Singapore。**证据级别：静态调用点（官方桌面客户端渲染层），无实机样本。** 来源是本机官方 Windows 客户端热更新渲染层的只读静态检查，未执行目标代码；没有抓到请求或响应样本，因此本文只写字段名、类型和结构，不含任何真实值，也不含响应样本。

决策与写入规则见[快捷回复分组管理决定](../decisions/2026-11-05-quick-reply-manage.md)。读端点 `getCategories`、`getCustomerScripts` 另有真实样本，见 [endpoints/m.ctrip.com-16037-getCategories-post.md](endpoints/m.ctrip.com-16037-getCategories-post.md) 与 [endpoints/m.ctrip.com-16037-getCustomerScripts-post.md](endpoints/m.ctrip.com-16037-getCustomerScripts-post.md)。个人 VAGENT 的 createRootCategory、addCustomerScript、updateCustomerScript、deleteCustomerScript、deleteCategory 在 2026-10-30 另有实机读回（见[浏览器验证摘要](../research/2026-10-30-browser-api-validation.md)），本文各端点的请求体以本次静态调用点为准。

## 通用约定

- 方法与地址：`POST https://m.ctrip.com/restapi/soa2/16037/{method}`，JSON。
- `head`：业务 head，由当前账号页面上下文生成，见[鉴权说明](authentication.md)。下表“请求体”均不再重复列出 `head`，UI 不得传入。
- 其余 Header、鉴权沿用[鉴权说明](authentication.md)，本文不重复。
- 响应：只有 `ResponseStatus.Ack` 为 `Failure` 直接判业务拒绝；其他非 `Success` 的 Ack、非 `SUCCESS` 的业务结果码都要经读回核对，见决定文档的结果分类。
- ID 编码不统一，不得按“都是 ID”合并成一种表示：
  - `id` 为 number：deleteCustomerScript、deleteCategory、updateCategory、两个排序接口的列表项；
  - `id` 为 string：updateCustomerScript；
  - 转换为 number 前必须通过 `Number.isSafeInteger`，超出范围不发请求。
- `ownerType` 的两种表示：
  - 字符串（取值为分类类型名，个人为 `VAGENT`，团队为 `VSKILLGROUP`）：仅 createRootCategory；
  - 原样回显写前读取到的分类 `ownerType`（目前观测为数字；行内没有时省略）：addCustomerScript、deleteCategory。
- 官方在移动话术时不带 `{browser:true}` 选项，也不调用 checkResponse；删除话术时 `id` 使用读回得到的原值（number）。

## 端点

### getSkillGroupInfoByVenAgent（读）

用途：团队分类表单的“适用范围”候选。

| 方向 | 结构 |
| --- | --- |
| 请求体 | `agentUid: string`，值为当前坐席的 buid（不是 IM uid） |
| 响应 | `vskillGroupInfos[]{skillGroupId, skillGroupName}`，ID 与名称的具体类型无样本，实现按“可能为 number 或 string”容错并在写入前转换 |

### createRootCategory（写）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string | 必填，trim 后 1–15 个字符 |
| `type` | string | 固定 `CUSTOMSCRIPT`，补齐了 I-26 文档中的阻塞项 |
| `status` | string | 固定 `ACTIVE` |
| `ownerType` | string | 取 `VAGENT` 或 `VSKILLGROUP`，字符串表示 |
| `vSkillGroupIds` | array | 个人为空数组；团队必填多选，元素为技能组 ID |

响应体：本项目不读取。核对靠写前、写后两次 getCategories 之间新出现的分类 id，加名称一致。

### updateCategory（写：改名或改适用范围）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | number | 分类 ID |
| `name` | string | 新名称，1–15 个字符 |
| `status` | string | 固定 `ACTIVE` |
| `vSkillGroupIds` | array | 个人为空；团队为适用范围 |

### deleteCategory（写）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | number | 分类 ID |
| `ownerType` | 原样 | 回显写前读取的分类 `ownerType`（目前观测为 number），行内没有时省略 |

官方不检查分类是否为空，删除分类时服务端是否连带删除其中话术未有样本；本项目按官方行为，删除前确认文案标明话术数量，并在读回时核对其下话术都已不存在。

### updateCategorySortNo（写：分类拖拽排序）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `categorySortList` | array | 元素 `{id: number, sortNo: number}`，`sortNo` 取该项在新顺序中的数组下标 |

### addCustomerScript（写）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `content` | string | 非空，长度不超过 5000（UTF-16 计） |
| `ownerType` | 原样 | 回显写前读取的目标分类 `ownerType`（目前观测为 number），行内没有时省略 |
| `categoryCode` | string | 取自写前读取的目标分类 `code`，不是分类 `id` |

响应体：本项目不读取。核对靠新出现的话术 id 加内容一致。

### updateCustomerScript（写：编辑或移动）

| 场景 | 请求体 |
| --- | --- |
| 编辑内容 | `id: string`，`content: string` |
| 移动到其他分类 | `id: string`，`content: string`（原内容，取自写前读取），`categoryCode: string`（目标分类 `code`） |

两种场景是同一端点，移动靠附带 `categoryCode` 区分。`id` 为字符串。

### deleteCustomerScript（写）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | number | 话术 ID，读回得到的原值 |

### updateCustomerScriptSort（写：话术拖拽排序）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sortInfos` | array | 元素 `{id: number, sortNo: number}`，`sortNo` 取该项在新顺序中的数组下标 |

## 读取端点补充（已有样本，仅列本功能用到的字段）

- `getCategories` 请求体：`typeList: [type]`，`categoryType: "CUSTOMSCRIPT"`，`status: "ACTIVE"`。
- 响应分类：`id: number`、`code: string`、`name: string`、`ownerType: number`、`customerScripts[]{id: number, content: string, sortNo: number}`、`vSkillGroups[]{skillGroupId, skillGroupName}`。
- 组长判定：`getVenAgentByUid` 响应的 `venAgent.jobPosition`，值 `LEADER` 为组长。

## 证据边界

- 全部 9 个端点只有静态调用点证据，无实机样本。
- 仅静态可见、尚未实机核对的行为：分类改名、话术移动、分类排序、话术排序、团队写、非空分组删除。
- 没有这些端点的 Ack 失败、权限失败、超时样本；失败只能按决定文档的分类处理，不能推断服务端权限模型。
