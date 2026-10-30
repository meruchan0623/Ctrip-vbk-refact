# 消息左右布局

2026-10-31，按用户明确要求：merchant_self和merchant_other的所有普通消息（文字、图片、文件、视频、订单卡）靠右；customer、ctrip_agent、robot及unknown靠左。system类型通知仍居中，不冒充可发送气泡。角色由数据适配层提供，布局不根据显示名猜身份。

message-alignment.ts将side与self分别返回，main.messageRow只用side决定mine布局类；状态、重试、本人身份/头像兜底仍依据self。商户同事不会因靠右而获得本人发送状态或重试入口。既有CSS的msg.mine已负责右侧排列，无需变更CSS。

回归对五类普通消息验证两种商户角色，以及客户/未知与系统通知；旧仅self靠右实现5项失败，新实现7项通过（/tmp/vbk-message-alignment-red.log与-green.log）。新包原生视觉效果待第3轮验证。
