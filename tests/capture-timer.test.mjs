import test from 'node:test';
import assert from 'node:assert/strict';
import { startCapture, startMediaTest } from '../src/capture.ts';

function fixture(t, running = true, autoFlush = true) {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  doc.baseURI = 'https://example.com/';
  const win = new EventTarget();
  const track = new EventTarget();
  track.readyState = 'live';
  track.stop = () => { track.readyState = 'ended'; };
  const stream = { getTracks: () => [track] };
  const messages = [];
  let starts = 0;
  let context;
  let worklet;
  let recorder;
  class Context {
    state = running ? 'running' : 'suspended';
    destination = {};
    audioWorklet = { addModule: async () => {} };
    constructor() { context = this; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: {}, connect() {}, disconnect() {} }; }
    async resume() {}
    async close() { this.state = 'closed'; }
  }
  class Worklet {
    constructor() { worklet = this; }
    port = { onmessage: null, postMessage: message => {
      messages.push(message);
      if (message === 'flush' && autoFlush) this.port.onmessage?.({ data: 'flushed' });
    } };
    connect() {} disconnect() {}
  }
  class Recorder extends EventTarget {
    constructor() { super(); recorder = this; }
    static isTypeSupported() { return true; }
    mimeType = 'video/webm';
    state = 'inactive';
    start() { starts++; this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      const data = new Event('dataavailable');
      data.data = new Blob(['answer'], { type: this.mimeType });
      this.dispatchEvent(data);
      this.dispatchEvent(new Event('stop'));
    }
  }
  for (const [key, value] of Object.entries({ document: doc, window: win,
    navigator: { mediaDevices: { getUserMedia: async () => stream } }, AudioContext: Context,
    AudioWorkletNode: Worklet, MediaRecorder: Recorder, performance: { now: () => now },
    setInterval: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearInterval: id => timers.delete(id),
  })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (old) Object.defineProperty(globalThis, key, old); else delete globalThis[key]; });
  }
  const preview = { srcObject: null, play: async () => {} };
  return { preview, track, messages, doc, win, get worklet() { return worklet; }, get recorder() { return recorder; }, get starts() { return starts; }, get context() { return context; },
    advance(ms) { now += ms; for (const callback of [...timers.values()]) callback(); },
    get timers() { return timers.size; } };
}

for (const timings of [{ preparationSeconds: 1, answerSeconds: 5 }, { preparationSeconds: 3, answerSeconds: 7 }, {}]) {
  test(`preparation and answer have independent deadlines ${JSON.stringify(timings)}`, async t => {
    const f = fixture(t);
    const phases = [];
    const ticks = [];
    const results = [];
    const prep = timings.preparationSeconds ?? 15;
    const answer = timings.answerSeconds ?? 20;
    const handle = await startCapture(f.preview, n => ticks.push(n), r => results.push(r), assert.fail,
      { ...timings, onPhase: p => phases.push(p) });
    assert.deepEqual(phases, ['preparing']);
    assert.equal(ticks[0], prep);
    assert.equal(f.starts, 0);
    assert.deepEqual(f.messages, []);
    assert.equal(f.track.readyState, 'live');
    f.advance(prep * 1000 - 1);
    assert.equal(f.starts, 0);
    f.advance(1);
    assert.equal(f.starts, 1);
    assert.deepEqual(phases, ['preparing', 'recording']);
    assert.deepEqual(f.messages, ['start']);
    assert.equal(ticks.at(-1), answer);
    f.advance(answer * 1000 - 1);
    assert.equal(results.length, 0);
    f.advance(1);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(results.length, 1);
    assert.equal(results[0].duration, answer);
    assert.equal(f.track.readyState, 'ended');
    assert.equal(f.context.state, 'closed');
    assert.equal(f.preview.srcObject, null);
    assert.equal(f.timers, 0);
    handle.stop();
    assert.equal(results.length, 1);
  });
}

for (const cause of ['stop', 'abort', 'hidden', 'pagehide', 'ended']) {
  test(`preparation cancellation by ${cause} releases resources without an answer`, async t => {
    const f = fixture(t);
    const controller = new AbortController();
    let cancelled = 0;
    const handle = await startCapture(f.preview, () => {}, assert.fail, assert.fail,
      { preparationSeconds: 1, signal: controller.signal, onCancelled: () => cancelled++ });
    if (cause === 'stop') handle.stop();
    if (cause === 'abort') controller.abort();
    if (cause === 'hidden') { f.doc.visibilityState = 'hidden'; f.doc.dispatchEvent(new Event('visibilitychange')); }
    if (cause === 'pagehide') f.win.dispatchEvent(new Event('pagehide'));
    if (cause === 'ended') f.track.dispatchEvent(new Event('ended'));
    handle.stop();
    f.advance(10_000);
    assert.equal(cancelled, 1);
    assert.equal(f.starts, 0);
    assert.deepEqual(f.messages, []);
    assert.equal(f.track.readyState, 'ended');
    assert.equal(f.preview.srcObject, null);
    assert.equal(f.context.state, 'closed');
    assert.equal(f.timers, 0);
  });
}

test('suspended AudioContext rejects setup without preparation', async t => {
  const f = fixture(t, false);
  await assert.rejects(startCapture(f.preview, assert.fail, assert.fail, assert.fail), /Start practice/);
  assert.equal(f.starts, 0);
  assert.equal(f.track.readyState, 'ended');
  assert.equal(f.context.state, 'closed');
});

for (const options of [{ preparationSeconds: 0 }, { preparationSeconds: 121 }, { preparationSeconds: 1.5 },
  { answerSeconds: 4 }, { answerSeconds: 31 }, { answerSeconds: NaN }, { answerSeconds: Infinity }]) {
  test(`invalid capture timing rejects ${JSON.stringify(options)}`, async t => {
    const f = fixture(t);
    await assert.rejects(startCapture(f.preview, assert.fail, assert.fail, assert.fail, options), /whole seconds/);
    assert.equal(f.starts, 0);
  });
}

for (const callback of ['phase', 'tick']) {
  test(`cancellation inside initial ${callback} callback leaves no timer`, async t => {
    const f = fixture(t);
    const controller = new AbortController();
    await startCapture(f.preview, () => { if (callback === 'tick') controller.abort(); }, assert.fail, assert.fail,
      { signal: controller.signal, onPhase: () => { if (callback === 'phase') controller.abort(); } });
    assert.equal(f.timers, 0);
    assert.equal(f.starts, 0);
    assert.equal(f.track.readyState, 'ended');
  });
}


test('media test immediately records five seconds and meters recognition PCM at most every 100ms', async t => {
  const f = fixture(t);
  const phases = [], ticks = [], levels = [], results = [];
  await startMediaTest(f.preview, n => ticks.push(n), r => results.push(r), assert.fail,
    { onPhase: p => phases.push(p), onAudioLevel: level => levels.push(level) });
  assert.deepEqual(phases, ['recording']);
  assert.deepEqual(ticks, [5]);
  assert.equal(f.starts, 1);
  f.worklet.port.onmessage({ data: new Float32Array([0.5, -0.5]) });
  f.worklet.port.onmessage({ data: new Float32Array([0.25]) });
  assert.deepEqual(levels, [0.5]);
  f.advance(100);
  f.worklet.port.onmessage({ data: new Float32Array([0.25]) });
  assert.deepEqual(levels, [0.5, 0.25]);
  f.advance(4900);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(results.length, 1);
  assert.equal(results[0].duration, 5);
  assert.deepEqual([...results[0].audio], [0.5, -0.5, 0.25, 0.25]);
  assert.equal(f.track.readyState, 'ended');
  assert.equal(f.preview.srcObject, null);
  assert.equal(f.timers, 0);
});

for (const cause of ['stop', 'abort', 'hidden', 'pagehide', 'ended']) {
  for (const finalizing of [false, true]) {
    test(`media test discards on ${cause}, pending flush=${finalizing}`, async t => {
      const f = fixture(t, true, !finalizing);
      const controller = new AbortController();
      let cancelled = 0;
      const handle = await startMediaTest(f.preview, () => {}, assert.fail, assert.fail,
        { signal: controller.signal, onCancelled: () => cancelled++ });
      const lateMessage = f.worklet.port.onmessage;
      if (finalizing) f.advance(5000);
      if (cause === 'stop') handle.stop();
      if (cause === 'abort') controller.abort();
      if (cause === 'hidden') { f.doc.visibilityState = 'hidden'; f.doc.dispatchEvent(new Event('visibilitychange')); }
      if (cause === 'pagehide') f.win.dispatchEvent(new Event('pagehide'));
      if (cause === 'ended') f.track.dispatchEvent(new Event('ended'));
      handle.stop();
      lateMessage({ data: new Float32Array([1]) });
      lateMessage({ data: 'flushed' });
      await Promise.resolve(); await Promise.resolve();
      f.advance(10000);
      assert.equal(cancelled, 1);
      assert.equal(f.track.readyState, 'ended');
      assert.equal(f.recorder.state, 'inactive');
      assert.equal(f.context.state, 'closed');
      assert.equal(f.preview.srcObject, null);
      assert.equal(f.timers, 0);
    });
  }
}

test('practice stop still saves an active answer', async t => {
  const f = fixture(t);
  const results = [];
  const handle = await startCapture(f.preview, () => {}, r => results.push(r), assert.fail, { preparationSeconds: 1 });
  f.advance(1000);
  f.advance(2000);
  handle.stop();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(results.length, 1);
  assert.equal(results[0].duration, 2);
});

for (const callback of ['phase', 'tick']) {
  test(`media test abort inside initial ${callback} callback releases the recorder and leaves no timer`, async t => {
    const f = fixture(t);
    const controller = new AbortController();
    await startMediaTest(f.preview, () => { if (callback === 'tick') controller.abort(); }, assert.fail, assert.fail,
      { signal: controller.signal, onPhase: () => { if (callback === 'phase') controller.abort(); } });
    await Promise.resolve();
    assert.equal(f.recorder.state, 'inactive');
    assert.equal(f.timers, 0);
    assert.equal(f.track.readyState, 'ended');
    assert.equal(f.context.state, 'closed');
  });
}
