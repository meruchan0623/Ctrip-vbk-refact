/** Concrete local decoder used only by the official-page boot runtime. */
export async function browserMediaProbe(kind: 'image' | 'video', mime: string, bytes: Uint8Array): Promise<{ width: number; height: number; duration: number | null }> {
  const blob = new Blob([Uint8Array.from(bytes)], { type: mime });
  if (kind === 'image') {
    const image = await createImageBitmap(blob);
    try { return { width: image.width, height: image.height, duration: null }; }
    finally { image.close(); }
  }
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    if (!video.canPlayType(mime)) { reject(new Error('unsupported local video decoder')); return; }
    const url = URL.createObjectURL(blob);
    const cleanup = (): void => { clearTimeout(timer); video.onloadedmetadata = null; video.onerror = null; video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('local video metadata timeout')); }, 10000);
    video.preload = 'metadata'; video.muted = true;
    video.onloadedmetadata = () => { const result = { width: video.videoWidth, height: video.videoHeight, duration: video.duration }; cleanup(); resolve(result); };
    video.onerror = () => { cleanup(); reject(new Error('local video decoding failed')); };
    video.src = url;
  });
}

export async function browserSha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
