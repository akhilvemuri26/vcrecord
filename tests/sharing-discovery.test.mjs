import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

let moduleVersion = 0;
const first = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const second = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const user = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

async function fixture({ data = [], error = null, getSession } = {}) {
  let onAuth;
  const calls = [];
  const client = {
    auth: {
      onAuthStateChange(callback) { onAuth = callback; },
      getSession: getSession ?? (async () => ({ data: { session: { user: { id: user } } }, error: null })),
      signInAnonymously() { assert.fail('Existing session should be restored'); },
    },
    async rpc(name) { calls.push(name); return { data, error }; },
  };
  const key = `__sharingFixture${moduleVersion++}`;
  globalThis[key] = client;
  const source = (await readFile(new URL('../src/sharing.ts', import.meta.url), 'utf8'))
    .replace(/^import .* from '@supabase\/supabase-js';/m, `const createClient = () => globalThis[${JSON.stringify(key)}]; type SupabaseClient = any;`);
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText;
  const api = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
  delete globalThis[key];
  return { api, calls, event: (event, id) => onAuth(event, id ? { user: { id } } : null) };
}

test('discovery returns validated, deduplicated, deterministic accessible destinations', async () => {
  const { api, calls } = await fixture({ data: [
    { team_id: second.toUpperCase(), canonical_team_id: first },
    { team_id: first, canonical_team_id: first },
    { team_id: second, canonical_team_id: first.toUpperCase() },
  ] });
  assert.deepEqual(await api.fetchAccessibleTeams(), [
    { id: first, canonicalTeamId: first }, { id: second, canonicalTeamId: first },
  ]);
  assert.deepEqual(calls, ['accessible_teams']);
});

test('discovery rejects malformed or conflicting authorization snapshots and propagates errors', async () => {
  for (const data of [null, [{}], [null], [{ team_id: first, canonical_team_id: 'invalid' }], [
    { team_id: first, canonical_team_id: first }, { team_id: first, canonical_team_id: second },
  ]]) {
    const { api } = await fixture({ data });
    await assert.rejects(api.fetchAccessibleTeams(), /invalid|conflicting/);
  }
  const { api } = await fixture({ error: { message: 'Offline discovery' } });
  await assert.rejects(api.fetchAccessibleTeams(), /Offline discovery/);
});

test('identity observers notify changes and unsubscribe without auth work', async () => {
  const { api, event } = await fixture();
  const users = [];
  const unsubscribe = api.onSessionChange(id => users.push(id));
  event('SIGNED_IN', user);
  event('TOKEN_REFRESHED', user);
  event('SIGNED_OUT', null);
  unsubscribe();
  event('SIGNED_IN', second);
  assert.deepEqual(users, [user, null]);
});

test('a delayed old session cannot authorize discovery after identity changes', async () => {
  let resolve;
  const pendingSession = new Promise(done => { resolve = done; });
  const { api, calls, event } = await fixture({ getSession: () => pendingSession });
  event('SIGNED_IN', user);
  const pending = api.fetchAccessibleTeams();
  event('SIGNED_OUT', null);
  event('SIGNED_IN', second);
  resolve({ data: { session: { user: { id: user } } }, error: null });
  await assert.rejects(pending, /session changed/);
  assert.deepEqual(calls, []);
  assert.equal(api.getUserId(), second);
});
