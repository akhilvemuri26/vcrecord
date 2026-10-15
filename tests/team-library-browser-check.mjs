import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const base = process.env.VCRECORD_TEST_URL || 'http://127.0.0.1:4173/';
const browser = await chromium.launch({headless:true, args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'], executablePath:'/Users/akhilvemuri/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'});
const legacy='11111111-1111-4111-8111-111111111111', canonical='22222222-2222-4222-8222-222222222222';
const module = `
let user=localStorage.getItem('testIdentity')||'member', listeners=[];
export const getUserId=()=>user;
export const onSessionChange=fn=>{listeners.push(fn);return ()=>listeners=listeners.filter(f=>f!==fn)};
window.changeIdentity=id=>{user=id;localStorage.setItem('testIdentity',id);listeners.forEach(fn=>fn(id))};
export const ensureSession=async()=>user;
export const joinTeam=async(id,token)=>{if(token!=='a'.repeat(64))throw Error('Invalid invitation');return id};
export const fetchAccessibleTeams=async()=>{if(window.lookupFailure)throw Error('Lookup failure');if(window.slowLookup)await new Promise(r=>setTimeout(r,800));return user==='member'?[{id:'${legacy}',canonicalTeamId:'${canonical}'},{id:'${canonical}',canonicalTeamId:'${canonical}'}]:[]};
export const fetchAnswers=async team=>{if(window.slowFetch)await new Promise(r=>setTimeout(r,800));if(window.fetchFailure===team)throw Error('Fetch failure');return [{id:'remote-'+team,teamId:team,ownerId:'someone',objectPath:team+'/someone/remote',questionId:'q',question:'Remote question',person:team==='${legacy}'?'Akhil Vemuri':'Prakrit',personId:'',createdAt:5,duration:2,mime:'video/webm',transcript:'remote',status:'done',edited:false}]};
export const downloadVideo=async()=>new Blob(['mock']);
export const uploadAnswer=async()=>{if(window.uploadFailure)throw Error('Upload failed')};
export const updateAnswer=async()=>{}; export const deleteAnswer=async()=>{};`;
const context=await browser.newContext({permissions:['camera','microphone']});
await context.route('**/src/sharing.ts',route=>route.fulfill({contentType:'application/javascript',body:module}));
await context.route('https://**/*',route=>route.abort());
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
 await context.addInitScript(()=>{window.Worker=class {postMessage({id}){setTimeout(()=>this.onmessage?.({data:{id,status:'done',text:'fixture'}}),10)}terminate(){}}});
 await page.goto(base);await page.waitForFunction(()=>document.querySelector('#team-status').textContent.includes('connected'));
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('vcrecord-team')).id),canonical,'lost preference restored via membership');
 await page.evaluate(async legacy=>{const {saveAnswer}=await import('/src/storage.ts');for(const [id,person,teamId,createdAt] of [['old','  AKHIL Vemuri ',legacy,30],['local','Prakrit',undefined,20],['historical','Zoe',undefined,10],['blank','',undefined,8]])await saveAnswer({id,person,teamId,ownerId:teamId?'member':undefined,questionId:id,question:'Question '+id,createdAt,duration:3,mime:'video/webm',video:new Blob(['original-'+id]),audio:new Float32Array([.2]),transcript:'saved',status:'done',syncState:teamId?'synced':undefined});window.slowFetch=true},legacy);
 await page.locator('#answers-nav').click();await page.waitForFunction(()=>document.querySelectorAll('#answer-list button').length===6);
 assert.equal(await page.locator('#library-count').textContent(),'6 of 6 recordings');
 assert.ok(await page.locator('#detail video').getAttribute('src')?.then(s=>s.startsWith('blob:')));
 await page.locator('#person-filter').selectOption('akhil');await page.waitForFunction(()=>document.querySelector('#library-count').textContent==='2 of 6 recordings');
 await page.locator('#person-filter').selectOption('aarav');await page.waitForFunction(()=>document.querySelector('#library-count').textContent==='0 of 6 recordings');assert.match(await page.locator('#answer-list').textContent(),/No recordings for Aarav/);
 await page.getByRole('button',{name:'Show all people'}).click();await page.locator('#group-by').selectOption('question');await page.waitForFunction(()=>document.querySelectorAll('.group-heading').length===5);
 await page.locator('#person-filter').selectOption('');await page.waitForFunction(()=>document.querySelector('#library-count').textContent==='1 of 6 recordings');
 await page.locator('#person-filter').selectOption('*');
 for (const width of [390,768,1440]) {await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'/tmp/vcrecord-team-library-'+width+'.png'});}
 // Original ID/token is retained when canonical destination changes.
 await page.goto(base+'#team='+legacy+'&invite='+'a'.repeat(64));await page.waitForFunction(()=>document.querySelector('#team-status').textContent.includes('connected'));
 assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('vcrecord-invitation'))),{id:legacy,invite:'a'.repeat(64)});
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('vcrecord-team')).id),canonical);
 await page.evaluate(id=>window.fetchFailure=id,legacy);await page.locator('#refresh-team').click();await page.waitForFunction(()=>document.querySelector('#team-status').textContent.includes('Could not refresh'));assert.doesNotMatch(await page.locator('#team-status').textContent(),/connected/);
 await page.evaluate(()=>{window.fetchFailure=null;window.lookupFailure=true});await page.locator('#refresh-team').click();await page.waitForFunction(()=>document.querySelector('#team-status').textContent.includes('Could not connect'));
 await page.locator('#answers-nav').click();assert.ok(await page.locator('#answer-list').textContent().then(s=>s.includes('Question old')));
 await page.evaluate(()=>{window.lookupFailure=false;window.changeIdentity('unrelated')});await page.locator('#refresh-team').click();await page.waitForFunction(()=>document.querySelector('#team-status').textContent.includes('Local practice ready'));
 await page.locator('#answers-nav').click();await page.waitForFunction(()=>document.querySelector('#library-count').textContent==='4 of 4 recordings');
 assert.ok(await page.locator('#answer-list').textContent().then(s=>s.includes('Question old')));
 const old=await page.evaluate(async()=>{const a=await(await import('/src/storage.ts')).getAnswer('old');return {id:a.id,teamId:a.teamId,size:a.video.size,audio:a.audio.length}});assert.deepEqual(old,{id:'old',teamId:legacy,size:12,audio:1});
 await page.locator('#answer-list button').filter({hasText:'Question old'}).click();await page.waitForFunction(()=>document.querySelector('#detail').dataset.answerId==='old');
 const localDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Download video',exact:true}).click();const downloaded=await localDownload;assert.equal((await readFile(await downloaded.path())).toString(),'original-old');
 // Practice and media remain usable with a real disposable video; restore pending saves locally.
 await page.locator('#practice-nav').click();await page.locator('#person').selectOption('Akhil');
 await page.evaluate(()=>{localStorage.setItem('vcrecord-timing',JSON.stringify({preparationSeconds:1,answerSeconds:5}))});await page.reload();
 await page.waitForFunction(()=>document.querySelector('#team-status').textContent.includes('Local practice ready'));
 await page.locator('#test-media').click();await page.locator('#media-test-player').waitFor({state:'visible'});
 await page.locator('#media-test-player').evaluate(v=>v.play());await page.waitForFunction(()=>document.querySelector('#media-test-player').currentTime>0);await page.locator('#media-test-close').click();
 await page.evaluate(()=>{window.slowLookup=true;window.changeIdentity('member')});await page.locator('#refresh-team').click();
 await page.locator('#person').selectOption('Akhil');await page.locator('#record').click();await page.locator('#stop').waitFor({state:'visible'});await page.waitForTimeout(350);await page.locator('#stop').click();
 await page.waitForFunction(async()=> (await(await import('/src/storage.ts')).listAnswers()).length===5);
 await page.locator('#answers-nav').click();await page.locator('#group-by').selectOption('recent');await page.waitForFunction(()=>document.querySelector('#library-count').textContent.startsWith('7 of 7'));await page.locator('#answer-list button').first().click();await page.waitForFunction(()=>document.querySelector('#detail video')?.readyState>=2);
 await page.locator('#detail video').evaluate(v=>v.play());await page.waitForFunction(()=>document.querySelector('#detail video').currentTime>0);
 assert.equal(await page.evaluate(async()=> (await(await import('/src/storage.ts')).listAnswers()).sort((a,b)=>b.createdAt-a.createdAt)[0].teamId),undefined);
 await page.evaluate(()=>window.uploadFailure=true);await page.locator('#share-saved').click();await page.waitForFunction(()=>document.querySelector('#team-status').textContent.includes('uploads or changes failed'));
 assert.doesNotMatch(await page.locator('#team-status').textContent(),/connected/);
 // A superseded refresh must not reintroduce another identity's remote cache.
 await page.evaluate(()=>window.slowFetch=true);await page.locator('#refresh-team').click();await page.waitForFunction(()=>document.querySelector('#team-status').textContent.includes('Connecting'));
 await page.evaluate(()=>window.changeIdentity('unrelated'));await page.locator('#refresh-team').click();await page.waitForFunction(()=>document.querySelector('#team-status').textContent.includes('Local practice ready'));await page.waitForTimeout(1000);
 await page.waitForFunction(()=>document.querySelector('#library-count').textContent==='5 of 5 recordings');
 await page.goto(base+'#team='+legacy+'&invite=bad');await page.waitForFunction(()=>document.querySelector('#team-status').textContent.includes('Invalid invitation'));assert.doesNotMatch(await page.locator('#team-status').textContent(),/connected/);
 assert.deepEqual(errors,[]);console.log('team library mocked browser: recovery, local playback, filters/counts, question groups, layouts, invitation pair, failures, identity isolation passed');
}finally{await context.close();await browser.close()}
