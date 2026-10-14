import { chromium } from 'playwright';
import fs from 'node:fs';
import assert from 'node:assert/strict';

// Use an isolated known-speech WAV, never a saved user answer.
const fixture = fs.readFileSync(process.env.SPEECH_FIXTURE ?? '/tmp/vcrecord-spoken.wav').toString('base64');
const bundle = fs.readdirSync('dist/assets').find(name => name.startsWith('transcribe.worker'));
assert.ok(bundle, 'Build the app before this check.');
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE ?? '/Users/akhilvemuri/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.goto(process.env.TEST_URL ?? 'http://localhost:4173/', { waitUntil: 'domcontentloaded' });
  const start = Date.now();
  const result = await page.evaluate(async ({ bundle, fixture }) => {
    const bytes = Uint8Array.from(atob(fixture), c => c.charCodeAt(0));
    const context = new AudioContext({ sampleRate: 16000 });
    const decoded = await context.decodeAudioData(bytes.buffer);
    const audio = decoded.getChannelData(0);
    await context.close();
    const rms = samples => Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length);
    const scale = 0.001 / rms(audio);
    for (let i = 0; i < audio.length; i++) audio[i] *= scale;
    const inputRms = rms(audio);
    return new Promise(resolve => {
      const worker = new Worker('/assets/' + bundle, { type: 'module' });
      const finish = output => { clearTimeout(timeout); worker.terminate(); resolve({ ...output, inputRms }); };
      const timeout = setTimeout(() => finish({ status: 'timeout' }), 150000);
      worker.onmessage = event => { if (event.data.status !== 'progress') finish(event.data); };
      worker.onerror = event => finish({ status: 'error', error: event.message });
      worker.postMessage({ id: 'quiet-known-speech-test', audio });
    });
  }, { bundle, fixture });
  console.log('QUIET REAL INFERENCE', Date.now() - start, JSON.stringify(result));
  assert.ok(result.inputRms > 0 && result.inputRms < 0.003);
  assert.equal(result.status, 'done');
  assert.match(result.text, /founders|practice|interview|product/i);
} finally {
  await browser.close();
}
