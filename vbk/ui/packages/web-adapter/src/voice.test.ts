import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_MSGTYPE, isVoiceMessage, parseVoiceBody, parseVoiceMessage, playableVoiceUrl, voiceDurationSeconds, voiceFormatOf } from './voice.ts';
import { httpMessageToUi, messageText, previewOf, previewOfUi, sdkMessageToUi, uiKindOf } from './display.ts';
import { mapMsgType } from './facts.ts';

// SYNTHETIC bodies only. Shapes follow the official bubbles; hosts and paths are invented.
const LEGACY_URL = 'https://voice.c-ctrip.com/synthetic/legacy.aac';
const CARD_URL = 'https://ak-a.tripcdn.com/synthetic/card.aac';
const legacy = (audio: Record<string, unknown>) => JSON.stringify({ audio: { filename: 'x.aac', size: 9, secret: 'synthetic-secret', ...audio } });
const card = (ext: Record<string, unknown>, top: Record<string, unknown> = {}) => JSON.stringify({ action: 'CBZ09', title: '[Voice-to-Text]synthetic', ext: { filename: 'c.aac', path: '/p', size: '1024', ...ext }, ...top });
const roles = { selfUid: 'self', roleOf: () => 'customer' as const };
const row = (msgtype: unknown, messageBody: string) => ({ msgId: 'm1', fromJid: 'cust@x', toJid: 'room@conf.x', createTime: 1700000000000, msgtype, messageBody });
const sdk = (msgtype: unknown, body: string) => ({ type: 'groupchat', from: 'room@conf.x/cust', to: 'self@x', id: 'm1', create_time: 1700000000000, msgtype, body });

test('both official shapes parse', () => {
  assert.equal(VOICE_MSGTYPE, 4);
  assert.deepEqual(parseVoiceMessage(4, legacy({ url: LEGACY_URL, duration: 7 })), { media_url: LEGACY_URL, voice_duration_s: 7, text: '' });
  assert.deepEqual(parseVoiceMessage('7', card({ url: CARD_URL, duration: 5, content: 'synthetic words' })), { media_url: CARD_URL, voice_duration_s: 5, text: 'synthetic words' });
  assert.deepEqual(parseVoiceBody(7, card({ url: CARD_URL })), { url: CARD_URL, format: 'aac' });
});

test('only type 4 and type 7 with CBZ09 are voice', () => {
  assert.equal(isVoiceMessage(7, JSON.stringify({ action: 'CBZ06', ext: { url: CARD_URL } })), false);
  assert.equal(isVoiceMessage(7, 'not json'), false);
  assert.equal(isVoiceMessage(0, card({ url: CARD_URL })), false, 'text is opaque even when it looks like a card');
  assert.equal(isVoiceMessage(5, legacy({ url: LEGACY_URL })), false);
  assert.equal(uiKindOf(7, JSON.stringify({ action: 'CBZ06' })), 'text');
  assert.equal(uiKindOf(7, card({})), 'voice');
  assert.equal(uiKindOf(4), 'voice');
});

test('transcript follows the official order and the title is only the last resort', () => {
  const text = (body: string) => parseVoiceMessage(7, body)?.text;
  assert.equal(text(card({ content: 'from ext' }, { content: 'from top' })), 'from ext');
  assert.equal(text(card({}, { content: 'from top' })), 'from top');
  assert.equal(text(card({})), '[Voice-to-Text]synthetic');
  assert.equal(text(JSON.stringify({ action: 'CBZ09', ext: {} })), '');
  assert.equal(messageText(7, card({ content: 'from ext' })), 'from ext');
});

test('missing or illegal duration is null; size as a string has no effect', () => {
  assert.equal(parseVoiceMessage(7, card({ url: CARD_URL }))?.voice_duration_s, null);
  for (const bad of [0, -3, Number.NaN, Infinity, 3601, 5000, '', 'abc', '5s', null, {}, true]) assert.equal(voiceDurationSeconds(bad), null, String(bad));
  assert.equal(voiceDurationSeconds('5'), 5);
  assert.equal(voiceDurationSeconds(2.4), 2);
  assert.equal(voiceDurationSeconds(0.2), 1);
  assert.equal(parseVoiceMessage(7, card({ url: CARD_URL, size: '2048', duration: 5 }))?.voice_duration_s, 5);
});

test('illegal URLs stay recognized voice with no media_url, and never reach the UiMessage', () => {
  for (const bad of ['http://voice.c-ctrip.com/a.aac', 'https://evil.example/a.aac', 'https://u:p@ak-a.tripcdn.com/a.aac', 'https://ak-a.tripcdn.com:8443/a.aac', 'javascript:alert(1)', 7, null]) {
    const ui = httpMessageToUi(row(7, card({ url: bad, content: 'kept' })), roles, 'room');
    assert.equal(ui?.kind, 'voice', String(bad));
    assert.equal(ui?.media_url, null, String(bad));
    assert.equal(ui?.text, 'kept');
  }
  assert.equal(httpMessageToUi(row(4, '{bad'), roles, 'room')?.kind, 'voice');
  assert.equal(httpMessageToUi(row(4, '{bad'), roles, 'room')?.text, '', 'a broken body is never shown as text');
});

test('history and realtime mappers yield the same voice message without private fields', () => {
  for (const [type, body, url, seconds, text] of [[4, legacy({ url: LEGACY_URL, duration: 7 }), LEGACY_URL, 7, ''], [7, card({ url: CARD_URL, duration: 5, content: 'w' }), CARD_URL, 5, 'w']] as const) {
    for (const ui of [httpMessageToUi(row(type, body), roles, 'room'), sdkMessageToUi(sdk(type, body), roles)]) {
      assert.equal(ui?.kind, 'voice');
      assert.equal(ui?.media_url, url);
      assert.equal(ui?.voice_duration_s, seconds);
      assert.equal(ui?.text, text);
      assert.equal(ui?.platform_type, type);
      assert.equal(JSON.stringify(ui).includes('synthetic-secret'), false);
      assert.equal(previewOfUi(ui!), '[语音]');
    }
    assert.equal(previewOf(row(type, body)), '[语音]');
  }
});

test('protocol hiding still applies to CBZ09; non-voice rows do not gain the field', () => {
  assert.equal(httpMessageToUi(row(7, card({ url: CARD_URL }, { isPresent: false })), roles, 'room'), null);
  assert.equal(sdkMessageToUi(sdk(7, card({ url: CARD_URL, visibleRule: 1 })), roles), null);
  const text = httpMessageToUi(row(0, 'hello'), roles, 'room')!;
  assert.equal('voice_duration_s' in text, false);
});

test('a voice message is business content for the fact stream', () => {
  assert.equal(mapMsgType(4), 'business');
});

test('nested audio/voice url is found, URLs must be playable under the media CSP', () => {
  const nested = JSON.stringify({ voice: { url: 'https://x.tripcdn.com/v.amr' } });
  assert.equal(parseVoiceBody(4, nested)?.format, 'amr');
  for (const bad of ['http://x.ctrip.com/a.mp3', 'https://evil.example.com/a.mp3', 'https://u:p@x.ctrip.com/a.mp3', 'https://x.ctrip.com:8443/a.mp3', 'javascript:alert(1)', 'data:audio/mp3;base64,AAAA', '', 5]) {
    assert.equal(playableVoiceUrl(bad), null, String(bad));
  }
  assert.equal(playableVoiceUrl('https://notctrip.com/a.mp3'), null, 'suffix match needs the dot');
  assert.equal(voiceFormatOf('https://x.ctrip.com/a.exe'), null);
});
