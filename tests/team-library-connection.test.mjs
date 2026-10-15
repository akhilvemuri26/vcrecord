import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
const connectionSource = source.slice(source.indexOf('async function refreshRemote()'), source.indexOf('el("copy-invite").onclick'));
const navigationSource = source.slice(source.indexOf('el("answers-nav").onclick ='), source.indexOf('function queueWorker()'));
const compiled = ts.transpileModule(connectionSource + navigationSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness() {
  const nodes = new Map();
  const el = id => { if (!nodes.has(id)) nodes.set(id, { hidden: id === 'library', textContent: '' }); return nodes.get(id); };
  const requests = [];
  const context = vm.createContext({
    team: undefined, confirmedUser: null, accessibleTeams: [], connectionGeneration: 0, remoteRefresh: 0,
    connecting: false, remoteAnswers: [], phase: 'idle', invitation: undefined,
    el, teamControls() {}, savePreference() {}, closeMediaTest() {}, cancelAttempt() {},
    async renderLibrary() {}, async drainSync() {}, async listSyncRecords() { return []; },
    stored() { return null; }, readTeam() { return undefined; },
    sharing: {
      getUserId: () => 'member', ensureSession: async () => 'member',
      fetchAccessibleTeams: async () => [{ id: 'legacy', canonicalTeamId: 'canonical' }, { id: 'canonical', canonicalTeamId: 'canonical' }],
      fetchAnswers: id => new Promise((resolve, reject) => requests.push({ id, resolve, reject })),
    },
  });
  vm.runInContext(compiled, context);
  return { context, requests, el };
}
async function until(predicate) {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await Promise.resolve(); }
  assert.fail('Expected asynchronous stage was not reached');
}
async function navigationRace(outcome = 'success') {
  const h = harness();
  const initialization = h.context.initializeTeam();
  await until(() => h.requests.length === 2);
  // Execute the actual Answers handler while initialization still awaits both teams.
  h.el('answers-nav').onclick();
  await until(() => h.requests.length === 4);
  for (const request of h.requests.slice(0, 2)) request.resolve([]);
  await initialization;
  assert.equal(h.context.connecting, false);
  if (outcome === 'upload') h.context.listSyncRecords = async () => [{ syncState: 'error', ownerId: 'member' }];
  for (const [index, request] of h.requests.slice(2).entries()) {
    if (outcome === 'partial' && index === 0) request.reject(new Error('Fetch failed'));
    else request.resolve([{ id: request.id, teamId: request.id }]);
  }
  await until(() => !h.el('team-status').textContent.includes('Connecting'));
  return h;
}

test('Answers superseding initialization completes connection status', async () => {
  const h = await navigationRace();
  assert.equal(h.el('team-status').textContent, 'Shared cofounder library connected.');
  assert.equal(h.context.remoteAnswers.length, 2);
});
test('superseding Answers refresh preserves partial-fetch warning', async () => {
  const h = await navigationRace('partial');
  assert.match(h.el('team-status').textContent, /Could not refresh 1 of 2 teams/);
});
test('superseding Answers refresh preserves upload warning', async () => {
  const h = await navigationRace('upload');
  assert.match(h.el('team-status').textContent, /1 uploads or changes failed/);
});
test('identity change rejects pending navigation results and status', async () => {
  const h = harness();
  Object.assign(h.context, { team: { id: 'canonical' }, confirmedUser: 'member', accessibleTeams: ['canonical'] });
  const refresh = h.context.refreshLibraryConnection();
  await until(() => h.requests.length === 1);
  h.context.sharing.getUserId = () => 'other';
  h.context.connectionGeneration++;
  h.context.remoteAnswers = [];
  h.el('team-status').textContent = 'Browser identity changed.';
  h.requests[0].resolve([{ id: 'old', teamId: 'canonical' }]);
  assert.equal(await refresh, false);
  assert.equal(h.context.remoteAnswers.length, 0);
  assert.equal(h.el('team-status').textContent, 'Browser identity changed.');
});
test('older completion cannot erase a newer refresh warning during sync lookup', async () => {
  const h = harness();
  Object.assign(h.context, { team: { id: 'canonical' }, confirmedUser: 'member', accessibleTeams: ['canonical'] });
  let releaseLookup;
  h.context.listSyncRecords = () => new Promise(resolve => { releaseLookup = resolve; });
  const first = h.context.refreshLibraryConnection();
  h.requests[0].resolve([]);
  await until(() => !!releaseLookup);
  const oldLookup = releaseLookup;
  h.context.listSyncRecords = async () => [];
  const second = h.context.refreshLibraryConnection();
  h.requests[1].reject(new Error('Unavailable'));
  await second;
  oldLookup([]);
  assert.equal(await first, false);
  assert.match(h.el('team-status').textContent, /Could not refresh 1 of 1 teams/);
});
