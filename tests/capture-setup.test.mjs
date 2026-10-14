import test from 'node:test';
import assert from 'node:assert/strict';
import { startCapture } from '../src/capture.ts';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

for (const stage of ['permission', 'preview', 'worklet', 'resume']) {
  for (const event of ['visibilitychange', 'pagehide', 'abort']) {
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
      const controller = new AbortController();
      let cancellations = 0;
      const preview = { srcObject: null, play: async () => pause('preview') };
      const result = startCapture(preview, () => assert.fail('cancelled capture ticked'), () => assert.fail('cancelled capture saved'), () => assert.fail('cancelled capture recorded'), { signal: controller.signal, onCancelled: () => cancellations++ });
      const rejected = assert.rejects(result, /cancelled/);
      await reached.promise;
      if (event === 'visibilitychange') {
        document.visibilityState = 'hidden';
        document.dispatchEvent(new Event(event));
      } else if (event === 'abort') controller.abort();
      else window.dispatchEvent(new Event(event));
      if (stage !== 'permission') assert.equal(track.readyState, 'ended', 'acquired track stops before pending setup resolves');
      if (context) assert.equal(context.state, 'closed');
      document.visibilityState = 'visible';
      gate.resolve();
      await rejected;
      await Promise.resolve();
      assert.equal(cancellations, 1);
      assert.equal(starts, 0, 'late setup never constructs/starts a recorder');
      assert.equal(track.readyState, 'ended');
      assert.equal(preview.srcObject, null);
    });
  }
}
