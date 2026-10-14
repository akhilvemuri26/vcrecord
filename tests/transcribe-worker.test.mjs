import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Exercise the real worker handler with a local recognizer stub; no model downloads.
test('worker recognizes quiet PCM and distinguishes missing, zero, and empty model text', async t => {
  const messages = [], recognized = [];
  let transcript = 'quiet speech';
  const self = { postMessage: message => messages.push(message) };
  const stub = { env: {}, pipeline: async () => async audio => { recognized.push(audio); return { text: transcript }; } };
  for (const [key, value] of Object.entries({ self, __recognizerStub: stub })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (old) Object.defineProperty(globalThis, key, old); else delete globalThis[key]; });
  }
  const source = await readFile(new URL('../src/transcribe.worker.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/import \{ pipeline, env \} from '@huggingface\/transformers';/, 'const { pipeline, env } = globalThis.__recognizerStub;')
    .replace("'./audio-analysis.ts'", JSON.stringify(new URL('../src/audio-analysis.ts', import.meta.url).href));
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
  await self.onmessage({ data: { id: 'missing', audio: new Float32Array() } });
  assert.equal(messages.at(-1).status, 'silent');
  assert.match(messages.at(-1).error, /not captured/);
  await self.onmessage({ data: { id: 'zero', audio: new Float32Array(100) } });
  assert.match(messages.at(-1).error, /input was silent/);
  assert.equal(recognized.length, 0);
  const quiet = new Float32Array([0.000001, -0.000001]);
  await self.onmessage({ data: { id: 'quiet', audio: quiet } });
  assert.equal(recognized[0], quiet);
  assert.equal(messages.at(-1).status, 'done');
  assert.equal(messages.at(-1).text, 'quiet speech');
  const brief = new Float32Array(160000);
  brief[1000] = 0.01;
  transcript = '';
  await self.onmessage({ data: { id: 'brief', audio: brief } });
  assert.equal(recognized[1], brief);
  assert.equal(messages.at(-1).status, 'silent');
  assert.match(messages.at(-1).error, /No transcript was recognized/);
  assert.doesNotMatch(messages.at(-1).error, /No speech|input was silent/);
});
