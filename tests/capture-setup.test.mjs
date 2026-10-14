import test from 'node:test';
import assert from 'node:assert/strict';
import { startCapture } from '../src/capture.ts';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

for (const stage of ['permission', 'preview', 'worklet', 'resume']) {
  for (const event of ['visibilitychange', 'pagehide']) {
    test(`capture cancels ${stage} setup on ${event}, including a later visible page`, async t => {
      const gate = deferred();
      const reached = deferred();
      const pause = async phase => {
        if (phase === stage) { reached.resolve(); await gate.promise; }
      };
      const document = new EventTarget();
      document.visibilityState = 'visible';
      document.baseURI = 'https://example.com/app/';
      const window = new EventTarget();
      const track = new EventTarget();
      track.readyState = 'live';
      track.stop = () => { track.readyState = 'ended'; };
      const stream = { getTracks: () => [track] };
      let starts = 0;
      let context;
      class Context {
        state = 'running';
        destination = {};
        audioWorklet = { addModule: async () => pause('worklet') };
        constructor() { context = this; }
        createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
        createGain() { return { gain: {}, connect() {}, disconnect() {} }; }
        async resume() { await pause('resume'); }
        async close() { this.state = 'closed'; }
      }
      class Recorder { static isTypeSupported() { return true; } constructor() { starts++; } }
      class Worklet { port = {}; connect() {} disconnect() {} }
      for (const [key, value] of Object.entries({ document, window, navigator: { mediaDevices: { getUserMedia: async () => { await pause('permission'); return stream; } } }, AudioContext: Context, AudioWorkletNode: Worklet, MediaRecorder: Recorder })) {
        const old = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, value });
        t.after(() => { if (old) Object.defineProperty(globalThis, key, old); else delete globalThis[key]; });
      }
      const preview = { srcObject: null, play: async () => pause('preview') };
      const result = startCapture(preview, () => assert.fail('cancelled capture ticked'), () => assert.fail('cancelled capture saved'), () => assert.fail('cancelled capture recorded'));
      await reached.promise;
      if (event === 'visibilitychange') {
        document.visibilityState = 'hidden';
        document.dispatchEvent(new Event(event));
      } else window.dispatchEvent(new Event(event));
      if (stage !== 'permission') assert.equal(track.readyState, 'ended', 'acquired track stops before pending setup resolves');
      if (context) assert.equal(context.state, 'closed');
      document.visibilityState = 'visible';
      gate.resolve();
      await assert.rejects(result, /cancelled.*hidden/);
      assert.equal(starts, 0, 'late setup never constructs/starts a recorder');
      assert.equal(track.readyState, 'ended');
      assert.equal(preview.srcObject, null);
    });
  }
}
