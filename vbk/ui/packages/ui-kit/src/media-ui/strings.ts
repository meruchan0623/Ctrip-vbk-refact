/** Local attachment rejection notices. */
export const mediaUiStrings = {
  'mediaUi.mediaLimit.empty': '附件是空的，未发送。',
  'mediaUi.mediaLimit.tooLarge': '附件超过大小上限（图片 10 MB、文件 30 MB、视频 300 MB），未发送。',
  'mediaUi.mediaLimit.videoTooLong': '视频超过 3 分钟，未发送。',
  'mediaUi.mediaLimit.videoDurationUnknown': '无法读取视频时长，未发送。',
  'mediaUi.mediaLimit.tooManyFiles': '一次最多发送 10 个文件，未发送。',
  'mediaUi.mediaLimit.chunkedUnsupported': '该视频超过 30 MB，当前版本暂不支持大视频分片上传，未发送。',
  'mediaUi.mediaLimit.unknownKind': '不支持的附件类型，未发送。',
} as const;
