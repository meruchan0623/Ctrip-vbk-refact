/** Peripheral UI explanations only; server job-role aliases are protocol data. */
export const peripheralStrings = {
  "peripheralRuntime.malformedMembers": "成员返回格式无效，正在等待自动更新。",
  "peripheralRuntime.malformedCandidates": "候选返回格式无效，正在等待自动更新。",
  "peripheralRuntime.malformedScripts": "话术返回格式无效，请刷新。",
  "peripheralRuntime.directoryTooLarge": "部门目录过大，暂时无法完整加载。",
  "peripheralRuntime.memberTimeout": "成员状态读取超时，正在等待自动更新。",
  "peripheralRuntime.finishExpired": "会话确认已过期，已只读刷新。请再次确认结束。",
  "peripheralRuntime.candidatesExpired": "候选已过期，已自动更新。请重新选择。",
  "peripheralRuntime.finishNotSubmitted": "本次操作尚未提交。请刷新会话后再次确认。",
  "peripheralRuntime.membersNotSubmitted": "本次操作尚未提交，成员和会话将自动更新，请稍后再次确认。",
  "peripheralRuntime.confirmedTitle": "已确认",
  "peripheralRuntime.confirmedMessage": "已通过独立读回确认本次操作。",
  "peripheralRuntime.acceptedTitle": "已受理，待核验",
  "peripheralRuntime.acceptedMessage": "服务端已受理操作。可刷新成员和会话核对结果，请勿重复提交。",
  "peripheralRuntime.unknownTitle": "结果未知，待核验",
  "peripheralRuntime.unknownMessage": "操作可能已经生效。仅可只读刷新成员和会话，不会重新发送操作。"
} as const;
