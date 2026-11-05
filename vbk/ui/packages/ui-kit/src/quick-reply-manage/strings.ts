/**
 * zh-CN copy for the shared quick-reply manager (`ui/apps/_shared/quick-reply-manager.ts`),
 * mounted by the main-window reply popup and the settings window. Spread into the
 * shared table in `../i18n.ts`. Locked by `ui/apps/_shared/quick-reply-manage-i18n.test.ts`.
 */
export const quickReplyManageStrings = {
  // top bar
  'qrManage.tabsLabel': '快捷回复类型',
  'qrManage.tab.personal': '个人',
  'qrManage.tab.team': '团队',
  'qrManage.readonlyTeam': '仅组长可编辑团队快捷回复',
  // load states
  'qrManage.noAccount': '请先选择已登录的账号',
  'qrManage.loading': '正在加载…',
  'qrManage.loadFailed': '快捷回复加载失败',
  'qrManage.reload': '重新加载',
  // groups column
  'qrManage.groupsEmpty': '暂无分组',
  'qrManage.groupCount': '({count}条)',
  'qrManage.dragHint': '拖动可调整顺序',
  'qrManage.sortUnavailable': '此分组有未显示的话术，暂不能拖动排序',
  'qrManage.renameGroup': '改名',
  'qrManage.createGroup': '＋ 新建分组',
  'qrManage.noSkillGroups': '暂无可选技能组，无法新建团队分组',
  'qrManage.form.name': '分组名称',
  'qrManage.form.namePlaceholder': '最多 {max} 个字',
  'qrManage.form.scope': '适用范围',
  // scripts column
  'qrManage.noGroupSelected': '请选择左侧分组',
  'qrManage.scriptsEmpty': '该分组暂无话术',
  'qrManage.scopeList': '适用范围：{names}',
  'qrManage.listSeparator': '、',
  'qrManage.editScript': '编辑',
  'qrManage.moveTo': '移动至',
  'qrManage.addScript': '＋ 新增话术',
  'qrManage.scriptPlaceholder': '输入话术内容，最多 {max} 个字',
  // shared actions
  'qrManage.save': '保存',
  'qrManage.cancel': '取消',
  'qrManage.delete': '删除',
  // validation
  'qrManage.validate.nameRequired': '请输入分组名称',
  'qrManage.validate.nameTooLong': '分组名称最多 {max} 个字',
  'qrManage.validate.scopeRequired': '请至少选择一个适用技能组',
  'qrManage.validate.contentRequired': '请输入话术内容',
  'qrManage.validate.contentTooLong': '话术内容最多 {max} 个字',
  // delete confirmation
  'qrManage.confirm.script': '确定要删除此条快捷回复吗？',
  'qrManage.confirm.group': '删除分组“{name}”及其中 {count} 条快捷回复？',
  // edit outcomes (not_leader reuses `qrManage.readonlyTeam`)
  'qrManage.result.unknown': '结果未确认，已刷新列表，请核对',
  'qrManage.result.unknownUnread': '结果未确认，且列表读取失败，请重新读取后核对',
  'qrManage.result.busy': '另一项操作正在进行，请稍后再试',
  'qrManage.result.stale': '列表已变化，已为你刷新',
  'qrManage.result.auth': '登录已失效，请重新登录后再试',
  'qrManage.result.business': '服务端拒绝了此操作',
  'qrManage.result.businessCode': '服务端拒绝了此操作（{code}）',
  'qrManage.result.invalid': '输入内容不符合要求',
  'qrManage.result.notSubmitted': '未提交，可重试',
} as const;
