#!/bin/sh
# Recorded verification script, bound to ego task space 5 and this run's in-memory
# Network templates. It fails if those templates are missing; recapture first.
# No credential values or request bodies are printed or persisted.
set -eu
ego-browser nodejs <<'EOF'
const page = (await taskSpace(5)).page('p1');
const names = [
  'getMessageList', 'getOrderDetailsForVbk', 'getVenAgentByUid',
  'getCategories', 'checkMemberStatus', 'getLatestConversationByGid',
];
const preview = await page.evaluate((names) => names.map(name => {
  const entry = Object.entries(window.__ctripValidationTemplates || {})
    .find(([url]) => url.endsWith('/' + name));
  if (!entry) throw new Error('Missing observed template: ' + name + '; recapture first');
  return { name, url: entry[0], method: 'POST', bodyKeys: Object.keys(entry[1]),
    diff: name === 'getMessageList' ? 'pageSize=2' : 'none', writes: false };
}), names);
console.log({ dryRun: preview });
const results = await page.evaluate(async (names) => {
  const results = [];
  for (const name of names) {
    const [url, observed] = Object.entries(window.__ctripValidationTemplates || {})
      .find(([url]) => url.endsWith('/' + name));
    const body = { ...observed };
    if (name === 'getMessageList') body.pageSize = 2;
    const response = await fetch(url, { method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    const result = { name, httpStatus: response.status, ack: data.ResponseStatus?.Ack,
      resultCode: data.bizResponseStatus?.resultCode ?? data.resultCode };
    if (name === 'getMessageList') result.count = data.rangeMessage?.messages?.length;
    if (name === 'getOrderDetailsForVbk') {
      result.expectedPermissionDenial = data.resultCode === 3 && data.resultMsg === 'No permission';
      result.orderInfoPresent = !!data.orderInfoDto;
    }
    if (name === 'getVenAgentByUid') result.automaticTranslation =
      data.venAgentOption?.agentOption?.venOptionList?.find(o => o.optionCode === 'automatic_translation')?.optionValue;
    if (name === 'getCategories') {
      result.categoryCount = data.categories?.length;
      result.scriptCounts = data.categories?.map(c => c.customerScripts?.length);
    }
    if (name === 'checkMemberStatus') result.members = data.members?.map(m => ({
      alias: m.nick?.includes('Meru') ? 'current-agent' : m.nick?.includes('Sara') ? 'invited-agent' : 'other',
      roles: m.roles, status: m.status,
    }));
    if (name === 'getLatestConversationByGid') result.conversationStatus = data.conversation?.status;
    results.push(result);
  }
  return results;
}, names);
console.log({ results });
if (results.some(r => r.httpStatus !== 200 || r.ack !== 'Success')) throw new Error('Transport/envelope verification failed');
if (!results.find(r => r.name === 'getOrderDetailsForVbk')?.expectedPermissionDenial) throw new Error('Permission-denial sample changed; review result');
if (results.find(r => r.name === 'getVenAgentByUid')?.automaticTranslation !== 'Y') throw new Error('Translation setting not restored');
const fs = await import('node:fs/promises');
await fs.writeFile('/Users/tashima_meru/Develop/Ctrip-vbk-refact/docs/research/evidence/browser-replay-check-20261030.json',
  JSON.stringify({ dryRun: preview, results, at: new Date().toISOString() }, null, 2) + '\n');
EOF
