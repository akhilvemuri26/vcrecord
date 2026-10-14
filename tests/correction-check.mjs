import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE ?? '/Users/akhilvemuri/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
try {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
  await context.route(/huggingface\.co|cdn\.jsdelivr\.net/, route => route.abort());
  await context.addInitScript(() => {
    localStorage.setItem('vcrecord-timing', JSON.stringify({ preparationSeconds: 1, answerSeconds: 5 }));
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = transaction.apply(this, args);
      if (window.delayNextSave && args[1] === 'readwrite') {
        window.delayNextSave = false;
        Object.defineProperty(tx, 'oncomplete', {
          set(handler) {
            tx.addEventListener('complete', event => {
              window.releaseSave = () => handler.call(tx, event);
              window.saveCompletionPending = true;
            }, { once: true });
          },
        });
      }
      return tx;
    };
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.recordingStreams = [];
    navigator.mediaDevices.getUserMedia = async args => {
      const stream = await gum(args);
      window.recordingStreams.push(stream);
      return stream;
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://localhost:4173/', { waitUntil: 'domcontentloaded' });
  // A completed answer prevents model download from obscuring the save race.
  await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('vcrecord-answers', 1);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('answers', 'readwrite');
      tx.objectStore('answers').put({ id: 'draft-regression', questionId: 'q1', question: 'Regression question', person: 'Tester', personId: 'tester', createdAt: Date.now(), duration: 1, mime: 'video/webm', video: new Blob([], { type: 'video/webm' }), audio: new Float32Array(0), transcript: 'Initial transcript', edited: true, status: 'done' });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  }));
  await page.locator('#answers-nav').click();
  const draft = page.locator('#transcript');
  await draft.fill('Saved snapshot');
  await page.evaluate(() => { window.delayNextSave = true; });
  await page.getByRole('button', { name: 'Save transcript', exact: true }).click();
  await page.waitForFunction(() => window.saveCompletionPending);
  await draft.fill('Newer unsaved draft');
  await page.evaluate(() => window.releaseSave());
  await page.waitForFunction(() => document.querySelector('#library-status').textContent.includes('Newer changes are unsaved'));
  assert.equal(await draft.inputValue(), 'Newer unsaved draft');
  assert.equal(await draft.getAttribute('data-dirty'), 'true');
  const stored = () => page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('vcrecord-answers', 1);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('answers');
      const get = tx.objectStore('answers').get('draft-regression');
      get.onsuccess = () => resolve(get.result.transcript);
      tx.oncomplete = () => db.close();
    };
    open.onerror = () => reject(open.error);
  }));
  assert.equal(await stored(), 'Saved snapshot');
  await page.getByRole('button', { name: 'Save transcript', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#library-status').textContent === 'Transcript saved.');
  assert.equal(await stored(), 'Newer unsaved draft');
  assert.equal(await draft.getAttribute('data-dirty'), null);
  await page.reload();
  await page.locator('#answers-nav').click();
  assert.equal(await draft.inputValue(), 'Newer unsaved draft');
  console.log('PASS: real IndexedDB delayed completion preserves newer draft; second save and reload retain it');

  await page.locator('#practice-nav').click();
  await page.locator('#person').fill('Tester');
  await page.locator('#record').click();
  await page.locator('#stop').waitFor({ state: 'visible' });
  await page.waitForTimeout(1100);
  await page.locator('#stop').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('saved'));
  assert.ok(await page.evaluate(() => window.recordingStreams.every(s => s.getTracks().every(t => t.readyState === 'ended'))));
  console.log('PASS: ordinary foreground capture still saves and stops all tracks');
  assert.deepEqual(errors, []);
  await context.close();
} finally {
  await browser.close();
}
