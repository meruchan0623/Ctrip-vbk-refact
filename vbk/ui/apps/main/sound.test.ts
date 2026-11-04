import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playSound, stopSound } from './sound.ts';

test('notification session closes after the last tone and on cancellation', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const contexts: FakeContext[] = [];
  class FakeContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    closed = false;
    nodes: { onended: (() => void) | null }[] = [];
    constructor() { contexts.push(this); }
    createOscillator() {
      const node = {
        frequency: { value: 0 }, type: '', onended: null as (() => void) | null,
        connect() {}, disconnect() {}, start() {}, stop() {},
      };
      this.nodes.push(node);
      return node;
    }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} };
    }
    close() { this.closed = true; return Promise.resolve(); }
  }
  const session = { type: 'auto' };
  Object.defineProperty(globalThis, 'window', {
    configurable: true, value: { AudioContext: FakeContext, navigator: { audioSession: session } },
  });
  try {
    assert.equal(playSound('timeout'), 3);
    assert.equal(session.type, 'transient');
    const first = contexts[0]!;
    first.nodes[0]!.onended!();
    assert.equal(first.closed, false, 'remaining notes must finish');
    first.nodes[1]!.onended!();
    first.nodes[2]!.onended!();
    assert.equal(first.closed, true);
    assert.equal(playSound('loop'), 3);
    assert.equal(contexts.length, 2, 'next chime gets a fresh context');
    stopSound();
    assert.equal(contexts[1]!.closed, true);
    // Late callbacks from a cancelled chime cannot close a new active one.
    playSound('timeout');
    contexts[1]!.nodes.forEach(node => node.onended!());
    assert.equal(contexts[2]!.closed, false);
  } finally {
    stopSound();
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
