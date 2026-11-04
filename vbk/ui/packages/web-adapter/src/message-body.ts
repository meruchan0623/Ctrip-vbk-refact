/** Official desktop va/E0e use ext.replaceSender for forwarded/robot-wrapped content. */
export function messageBodyObject(body: unknown): Record<string, unknown> | null {
  let value = body;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function effectiveMessageSender(transportSender: string, body: unknown, msgtype: unknown): string {
  // Plain chat text can itself contain JSON; it is never identity metadata.
  if (msgtype === 0 || msgtype === '0') return transportSender;
  const ext = messageBodyObject(messageBodyObject(body)?.['ext']);
  const replacement = ext?.['replaceSender'];
  return typeof replacement === 'string' && replacement.trim() ? replacement.trim() : transportSender;
}
