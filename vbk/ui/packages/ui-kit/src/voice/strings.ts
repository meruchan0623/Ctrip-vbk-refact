/** Shared pure catalog: safe fixed display projection without bundling the main UI dictionary. */
export const voiceStrings = {
  'voice.preview': '[音频]',
  'voice.message': '[音频消息]',
  'voice.play': '播放音频',
  'voice.pause': '暂停音频',
  'voice.loading': '正在加载音频…',
  'voice.failed': '音频无法播放，请在官方网页查看。',
  'voice.unavailable': '音频消息暂不支持播放，请在官方网页查看。',
  'voice.duration': '{seconds} 秒',
} as const satisfies Readonly<Record<`voice.${string}`, string>>;
