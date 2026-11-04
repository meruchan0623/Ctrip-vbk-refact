// Scope is intentionally narrower than the browser API permission.
export function selectCookies(cookies, now = Date.now() / 1000) {
  return cookies.filter(c =>
    ((c.domain === '.ctrip.com' && !c.hostOnly) || (c.domain === 'vbooking.ctrip.com' && c.hostOnly)) &&
    ['bticket', 'vbkticket', 'BDUID'].includes(c.name) && c.path === '/' && c.secure && !c.partitionKey &&
    c.value && c.value.length <= 16384 && /^[\x21-\x3a\x3c-\x7e]+$/.test(c.value) &&
    (c.expirationDate === undefined || c.expirationDate > now)
  ).map(c => ({ domain: c.domain, name: c.name, value: c.value, path: c.path, secure: c.secure,
    http_only: c.httpOnly, host_only: c.hostOnly, same_site: c.sameSite,
    expiration: c.expirationDate === undefined ? null : Math.floor(c.expirationDate) }));
}
