import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch({executablePath: process.env.CHROMIUM_EXECUTABLE ?? '/Users/akhilvemuri/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
try {
 const context = await browser.newContext({permissions:['camera','microphone']});
 await context.route(/huggingface\.co|cdn\.jsdelivr\.net/,r=>r.abort());
 await context.addInitScript(()=>{
  window.events=[]; window.streams=[];
  const gum=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia=async args=>{
   if(window.denyMedia) throw new DOMException('Permission denied','NotAllowedError');
   const stream=await gum(args); window.streams.push(stream);
   if(window.delayPermission) await new Promise(resolve=>window.releasePermission=resolve);
   return stream;
  };
  const start=MediaRecorder.prototype.start;
  MediaRecorder.prototype.start=function(...args){window.events.push({type:'video-start',time:performance.now()});return start.apply(this,args);};
  const post=MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage=function(...args){if(args[0]==='start')window.events.push({type:'pcm-start',time:performance.now()});return post.apply(this,args);};
 });
 const page=await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const url=process.env.TEST_URL ?? 'http://localhost:4173/';
 const phase=async expected=>page.waitForFunction(p=>document.querySelector('#phase').textContent===p,expected,{timeout:22000});
 const allStopped=()=>page.evaluate(()=>window.streams.every(s=>s.getTracks().every(t=>t.readyState==='ended')));
 const records=()=>page.evaluate(()=>new Promise((resolve,reject)=>{const req=indexedDB.open('vcrecord-answers',1);req.onsuccess=()=>{const db=req.result;const tx=db.transaction('answers');const get=tx.objectStore('answers').getAll();get.onsuccess=()=>resolve(get.result.map(a=>({id:a.id,duration:a.duration,size:a.video.size,samples:a.audio.length,question:a.question})));tx.oncomplete=()=>db.close();};req.onerror=()=>reject(req.error);}));
 await page.goto(url);assert.equal(await page.locator('#question').isVisible(),false);
 await page.locator('#record').click();assert.match(await page.locator('#status').textContent(),/Enter your name/);
 await page.locator('#person').selectOption('Akhil');await page.locator('#record').click();await phase('Prepare');
 const revealed=await page.locator('#question').textContent();const prepAt=await page.evaluate(()=>performance.now());
 await page.waitForTimeout(14000);assert.deepEqual(await page.evaluate(()=>window.events),[]);
 await phase('Answer');const starts=await page.evaluate(()=>window.events);assert.equal(starts.length,2);assert.ok(starts[0].time-prepAt>=14500);
 await page.waitForTimeout(1000);assert.ok(await page.locator('#record').isHidden());await phase('Ready to practice');
 let saved=await records();assert.equal(saved.length,1);assert.ok(saved[0].duration>=19.8&&saved[0].duration<21);assert.ok(saved[0].samples>300000);assert.ok(saved[0].size>0);assert.equal(await page.locator('#question').textContent(),revealed);assert.ok(await allStopped());
 await page.locator('#answers-nav').click();await page.locator('.player').waitFor();await page.waitForFunction(()=>document.querySelector('.player')?.readyState>=1);assert.ok(await page.locator('.player').evaluate(v=>v.duration>=19));
 await page.locator('#practice-nav').click();await page.waitForTimeout(150);assert.equal((await page.evaluate(()=>window.events)).length,2);
 await page.locator('#timing-settings summary').click();await page.locator('#prep-seconds').fill('1.5');await page.locator('#timing-form button').click();assert.match(await page.locator('#timing-error').textContent(),/whole seconds/);
 await page.locator('#prep-seconds').fill('1');await page.locator('#answer-seconds').fill('5');await page.locator('#timing-form button').click();
 await page.reload();assert.equal(await page.locator('#prep-seconds').inputValue(),'1');await page.locator('#next').click();await phase('Prepare');assert.notEqual(await page.locator('#question').textContent(),revealed);await phase('Answer');await phase('Ready to practice');saved=await records();assert.equal(saved.length,2);assert.ok(saved.some(a=>a.duration>=4.8&&a.duration<6));assert.ok(await allStopped());
 console.log('PASS default automatic 15s preparation + 20s video/PCM, playable answer, automatic Next with persisted 1s/5s custom timing');
 // Preparation cancellation keeps an already saved answer set stable and never starts recording.
 await page.locator('#timing-settings summary').click();await page.locator('#prep-seconds').fill('15');await page.locator('#timing-form button').click();await page.locator('#record').click();await phase('Prepare');await page.locator('#cancel').click();assert.ok(await allStopped());
 await page.locator('#record').click();await phase('Prepare');await page.locator('#answers-nav').click();assert.ok(await allStopped());await page.locator('#practice-nav').click();
 await page.locator('#record').click();await phase('Prepare');await page.locator('#timing-settings summary').click();await phase('Ready to practice');assert.ok(await allStopped());
 await page.locator('#record').click();await phase('Prepare');await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));await phase('Ready to practice');assert.ok(await allStopped());
 await page.locator('#record').click();await phase('Prepare');await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));});await phase('Ready to practice');assert.ok(await allStopped());
 // Pending permission cannot resurrect a cancelled setup or save anything.
 await page.evaluate(()=>window.delayPermission=true);await page.locator('#record').click();await page.waitForFunction(()=>window.releasePermission);assert.equal(await page.locator('#question').isVisible(),false);await page.locator('#cancel').click();await page.evaluate(()=>{window.delayPermission=false;window.releasePermission();});await page.waitForTimeout(300);assert.ok(await allStopped());
 await page.evaluate(()=>window.denyMedia=true);await page.locator('#record').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Permission denied'));assert.equal(await page.locator('#record').isEnabled(),true);await page.evaluate(()=>window.denyMedia=false);
 await page.waitForTimeout(15500);assert.equal((await records()).length,2);assert.equal((await page.evaluate(()=>window.events)).length,2);assert.ok(await allStopped());assert.deepEqual(errors,[]);
 await page.setViewportSize({width:375,height:812});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=375));await page.screenshot({path:'/tmp/vcrecord-timer-mobile.png'});
 console.log('PASS cancel, Answers/settings/pagehide/hidden preparation cancellation, late permission, denial recovery, stale timers, 375px width, no UI errors');
 await context.close();
}finally{await browser.close();}
