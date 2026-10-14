import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const executablePath = process.env.CHROMIUM_EXECUTABLE ?? '/Users/akhilvemuri/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({executablePath, headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--use-file-for-fake-audio-capture=/tmp/vcrecord-spoken.wav']});
try {
 const context=await browser.newContext({permissions:['camera','microphone']});
 const jobs=[]; const uploads=[];
 await context.route(/huggingface\.co|cdn\.jsdelivr\.net/,r=>{jobs.push(r.request().url());return r.abort();});
 context.on('request',r=>{if(r.method()!=='GET'&&/supabase/.test(r.url()))uploads.push(r.url());});
 await context.addInitScript(()=>{
  window.streams=[]; window.contexts=[]; window.workers=0;
  const gum=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia=async args=>{if(window.denyMedia)throw new DOMException('Permission denied','NotAllowedError');const s=await gum(args);window.streams.push(s);if(window.delayMedia)await new Promise(r=>window.releaseMedia=r);return s;};
  const AW=AudioWorkletNode;window.AudioWorkletNode=class extends AW{constructor(...a){super(...a);const port=this.port;const setter=Object.getOwnPropertyDescriptor(MessagePort.prototype,'onmessage').set;Object.defineProperty(port,'onmessage',{configurable:true,set(handler){setter.call(port,handler?e=>{if(e.data instanceof Float32Array&&window.pcmMode){if(window.pcmMode==='missing')return;handler({data:new Float32Array(e.data.length)});}else handler(e);}:null);}});}};
  const AC=AudioContext;window.AudioContext=class extends AC{constructor(...a){super(...a);window.contexts.push(this);}};
  const W=Worker;window.Worker=class extends W{constructor(...a){super(...a);window.workers++;}};
 });
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.env.TEST_URL??'http://localhost:4173/');
 const stopped=()=>page.waitForFunction(()=>window.streams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))&&window.contexts.every(c=>c.state==='closed'));
 const count=()=>page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('vcrecord-answers',1);r.onsuccess=()=>{const db=r.result;const q=db.transaction('answers').objectStore('answers').count();q.onsuccess=()=>{resolve(q.result);db.close();};};r.onerror=()=>reject(r.error);}));
 const before=await count();const q=await page.locator('#question').textContent();
 await page.locator('#test-media').click();await page.waitForFunction(()=>document.querySelector('#media-test-meter').value>0);
 assert.equal(await page.locator('#media-test-preview').evaluate(v=>v.srcObject?.active),true);
 await page.locator('#media-test-player').waitFor({state:'visible'});await stopped();
 assert.match(await page.locator('#media-test-status').textContent(),/Audio input was captured/);
 await page.locator('#media-test-player').evaluate(v=>v.play());await page.waitForFunction(()=>{const v=document.querySelector('#media-test-player');return !v.muted&&v.currentTime>0&&v.videoWidth>0;});await page.locator('#media-test-player').evaluate(v=>v.pause());
 const duration=await page.locator('#media-test-player').evaluate(v=>v.duration);console.log('sample playback duration',duration);assert.ok(duration>=4.8&&duration<6||duration===Infinity);
 assert.equal(await count(),before);assert.equal(await page.evaluate(()=>window.workers),0);assert.deepEqual(jobs,[]);assert.deepEqual(uploads,[]);assert.equal(await page.locator('#question').textContent(),q);
 await page.setViewportSize({width:375,height:812});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=375));await page.screenshot({path:'/tmp/vcrecord-media-test-mobile.png'});
 await page.locator('#media-test-again').click();await page.waitForFunction(()=>document.querySelector('#media-test-meter').value>0);await page.locator('#media-test-close').click();await stopped();assert.ok(await page.locator('#media-test').isHidden());assert.equal(await page.evaluate(()=>document.activeElement.id),'test-media');
 await page.evaluate(()=>window.delayMedia=true);await page.locator('#test-media').click();await page.waitForFunction(()=>window.releaseMedia);await page.locator('#media-test-close').click();await page.evaluate(()=>{window.delayMedia=false;window.releaseMedia();});await stopped();
 for(const action of ['answers','hidden','pagehide','track']){
  await page.locator('#test-media').click();await page.waitForFunction(()=>document.querySelector('#media-test-meter').value>0);
  if(action==='answers'){await page.locator('#answers-nav').click();await page.locator('#practice-nav').click();}
  else await page.evaluate(action=>{if(action==='hidden'){Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});}else if(action==='pagehide')window.dispatchEvent(new Event('pagehide'));else window.streams.at(-1).getTracks()[0].dispatchEvent(new Event('ended'));},action);
  await stopped();assert.ok(await page.locator('#media-test').isHidden());
 }
 await page.evaluate(()=>window.denyMedia=true);await page.locator('#test-media').click();await page.waitForFunction(()=>document.querySelector('#media-test-status').textContent.includes('Permission denied'));await page.locator('#media-test-close').click();await page.evaluate(()=>window.denyMedia=false);
 for(const mode of ['zero','missing']){
  await page.evaluate(mode=>window.pcmMode=mode,mode);await page.locator('#test-media').click();await page.locator('#media-test-player').waitFor({state:'visible'});await stopped();
  assert.match(await page.locator('#media-test-status').textContent(),mode==='zero'?/input was silent/:/audio was not captured/);assert.equal(await count(),before);await page.locator('#media-test-close').click();
 }
 await page.evaluate(()=>window.pcmMode=undefined);
 await page.locator('#person').fill('Media QA');await page.locator('#test-media').click();await page.waitForFunction(()=>document.querySelector('#media-test-meter').value>0);await page.locator('#record').click();await page.waitForFunction(()=>document.querySelector('#phase').textContent==='Prepare');assert.ok(await page.locator('#media-test').isHidden());await page.locator('#cancel').click();await stopped();
 await page.locator('#timing-settings summary').click();await page.locator('#prep-seconds').fill('1');await page.locator('#answer-seconds').fill('5');await page.locator('#timing-form button').click();await page.locator('#record').click();await page.locator('#stop').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('saved'));await stopped();assert.equal(await count(),before+1);
 assert.deepEqual(errors,[]);console.log('PASS media preview, PCM meter, user playback, ephemeral storage/no worker/upload, retest/close/late grant/nav/hidden/pagehide/track/denial, practice after test, narrow layout');
 await context.close();
}finally{await browser.close();}
