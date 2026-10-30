# 账号恢复标记的元数据探测

2026-10-31。用户要求尽可能减少新包启动时的钥匙串读取提示。第1/2轮进程采样均显示恢复线程经 `SecretStore.contains → keyring.get_secret → SecKeychainFindGenericPassword` 等待；该条目仅保存profile提交标记，不是网页密码/Cookie。第2轮二进制为adhoc/linker-signed、无TeamIdentifier；不能将开发包每次授权视为已稳定签名分发。

常规恢复现调用 `SecretStore.probe -> Result<bool, AppError>`。macOS只查询与keyring一致的User默认Keychain、GenericPassword类别、精确service/account元数据，加载attributes而不加载data或refs。不扩大搜索范围、不修改ACL、不关闭认证、不跳过需认证条目。依据Apple [kSecReturnAttributes](https://developer.apple.com/documentation/security/ksecreturnattributes)及本机security-framework3.7.0实际API。

只有查询返回errSecItemNotFound(-25300)才判不存在；其他错误及成功但空结果进入unavailable报告。registry保留原引用和revision；宿主仍发布账号metadata/profile，但不自动打开该账号的恢复WebView。既有profile不因暂时不可访问被视为孤儿删除。恢复后重新启动可重新探测。staged条目缺失时的幂等commit也使用probe并传播访问错误，不伪装成缺失。

回归通过实际AccountRegistry和CredentialLedger，模拟后端探测不可用：旧实现误判missing失败，修复后保留引用/revision，随后正常探测成功。既有明确缺失、正常恢复和提交顺序测试保留。纯结果分类回归对成功空结果先失败，再验证其为unavailable；明确-25300仍为missing。尚需下轮新二进制实际验证不再出现常规读取弹窗；当前运行包未含本修复。

范围：只消除常规存在检查的不必要秘密读取。显式登录提交需要复制staged标记；keyring在删除旧条目/历史journal清理时也可能读取内容，仍可能出现系统提示。TSim真实token访问另属assistant链路，不在此块声称已消除。不迁移或删除现有钥匙串项，不改签名/访问控制，不保证所有系统提示永久消失。
