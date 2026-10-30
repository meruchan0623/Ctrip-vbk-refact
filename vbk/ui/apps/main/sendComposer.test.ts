import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendComposer } from './sendComposer.ts';

for (const name of ['synthetic-image.png', 'synthetic-file.pdf', 'synthetic-screenshot.png']) {
  for (const draft of ['', '  SYNTHETIC DRAFT\nkeep whitespace  ']) {
    test(`unimplemented ${name} blocks before outbound callbacks with ${draft ? 'text' : 'empty draft'}`, async () => {
      const attachment = Object.freeze({ name });
      const input = Object.freeze({ draft, attachment });
      let currentDraft = draft;
      let currentAttachment: typeof attachment | null = attachment;
      let outboundCalls = 0;
      // This callback represents the real translation/text-IPC path supplied by handleSend.
      const result = await sendComposer(input, async () => {
        outboundCalls++;
        currentDraft = '';
        currentAttachment = null;
      });
      assert.equal(outboundCalls, 0, 'must not reach translation, text IPC or SDK submission');
      assert.equal(result, 'blocked_attachment');
      assert.equal(currentDraft, draft);
      assert.equal(currentAttachment, attachment);
    });
  }
}

test('repeated send with attachment stays blocked; explicit removal enables the existing text path', async () => {
  const input = { draft: '  SYNTHETIC TEXT  ', attachment: { name: 'synthetic-file.pdf' } };
  const sent: string[] = [];
  const send = async (text: string) => { sent.push(text); };
  await sendComposer(input, send); await sendComposer(input, send);
  assert.deepEqual(sent, []);
  assert.equal(await sendComposer({ ...input, attachment: null }, send), 'submitted');
  assert.deepEqual(sent, ['SYNTHETIC TEXT']);
});

test('no attachment and empty draft stays a no-op', async () => {
  let calls = 0;
  assert.equal(await sendComposer({ draft: ' \n ', attachment: null }, async () => { calls++; }), 'empty');
  assert.equal(calls, 0);
});
