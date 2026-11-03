// cookies are read by the WebView, never stored here
export function hasCookie(cookieHeader: string): boolean {
  const cookie = cookieHeader.trim();
  return cookie.length > 0;
}
