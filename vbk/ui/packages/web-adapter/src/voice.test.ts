import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_MSGTYPE, parseVoiceBody, playableVoiceUrl, voiceFormatOf } from './voice.ts';

// SYNTHETIC bodies only: no real voice sample exists in the evidence.
const body = (url: string) => JSON.stringify({ url });

test('feature stays off until a verified msgtype is supplied', () => {
  assert.equal(VOICE_MSGTYPE, null);
  assert.equal(parseVoiceBody(99, body('https://dimg04.c-ctrip.com/a.mp3')), null);
});

test('with a configured msgtype only that type yields a clip', () => {
  const clip = parseVoiceBody(99, body('https://dimg04.c-ctrip.com/a.MP3'), { msgtype: 99 });
  assert.deepEqual(clip, { url: 'https://dimg04.c-ctrip.com/a.MP3', format: 'mp3' });
  assert.equal(parseVoiceBody('99', body('https://dimg04.c-ctrip.com/a.mp3'), { msgtype: 99 })?.format, 'mp3');
  assert.equal(parseVoiceBody(0, body('https://dimg04.c-ctrip.com/a.mp3'), { msgtype: 99 }), null);
  assert.equal(parseVoiceBody(99, '{bad', { msgtype: 99 }), null);
});

test('nested audio/voice url is found, URLs must be playable under the media CSP', () => {
  const nested = JSON.stringify({ voice: { url: 'https://x.tripcdn.com/v.amr' } });
  assert.equal(parseVoiceBody(5, nested, { msgtype: 5 })?.format, 'amr');
  for (const bad of ['http://x.ctrip.com/a.mp3', 'https://evil.example.com/a.mp3', 'https://u:p@x.ctrip.com/a.mp3', 'https://x.ctrip.com:8443/a.mp3', 'javascript:alert(1)', 'data:audio/mp3;base64,AAAA', '', 5]) {
    assert.equal(playableVoiceUrl(bad), null, String(bad));
  }
  assert.equal(playableVoiceUrl('https://notctrip.com/a.mp3'), null, 'suffix match needs the dot');
  assert.equal(voiceFormatOf('https://x.ctrip.com/a.exe'), null);
});
