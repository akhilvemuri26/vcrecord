import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = ts.transpileModule(await readFile(new URL('../src/sync.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
let moduleNumber = 0;
const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function setup(t, { unsupported = false, rejected = false } = {}) {
  const records = new Map();
  const remote = new Map();
  const objects = new Set();
  const sent = [];
  const entered = deferred();
  const release = deferred();
  let firstUpload = true;
  const copy = value => value && structuredClone(value);
  const mutate = async (id, change) => {
    const record = copy(records.get(id));
    if (!record) return false;
    change(record);
    records.set(id, record);
    return true;
  };
  const storage = {
    deleteAnswer: async id => { records.delete(id); },
    getSyncRecord: async id => copy(records.get(id)),
    isLocalAnswer: record => !record.remoteOnly,
    listSyncRecords: async () => [...records.values()].map(copy),
    mutateSync: mutate,
    mutateRemote: async (record, change) => {
      if (!records.has(record.id)) records.set(record.id, copy(record));
      return mutate(record.id, current => { change(current); current.revision++; current.syncState = 'pending'; });
    },
    removeRemoteOverlay: async (id, revision) => {
      const current = records.get(id);
      if (current?.remoteOnly && current.revision === revision && !current.deletedAt) records.delete(id);
    },
    markForDeletion: async id => mutate(id, current => {
      current.deletedAt = 1;
      current.revision++;
      current.syncState = 'pending';
    }),
  };
  const sharing = {
    ensureSession: async () => 'owner',
    uploadAnswer: async answer => {
      sent.push(['upload', answer.transcript]);
      if (firstUpload) { firstUpload = false; entered.resolve(); await release.promise; }
      objects.add(answer.objectPath);
      remote.set(answer.id, copy(answer));
    },
    updateAnswer: async (id, patch) => {
      sent.push(['update', patch.transcript]);
      remote.set(id, { ...remote.get(id), ...copy(patch) });
    },
    deleteAnswer: async (id, path) => {
      sent.push(['delete', id]);
      remote.delete(id);
      objects.delete(path);
    },
  };
  // Separate ESM instances model two tabs' independent activeDrain/requestVersion,
  // while their durable records, remote service, and named lock manager are shared.
  let tail = Promise.resolve();
  const lockNames = [];
  const locks = {
    request(name, options, callback) {
      lockNames.push([name, options.mode]);
      if (rejected) return Promise.reject(new Error('Lock service refused the request'));
      const result = tail.then(callback);
      tail = result.catch(() => {});
      return result;
    },
  };
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: unsupported ? {} : { locks } });
  const key = `__syncTest${moduleNumber++}`;
  globalThis[key] = { storage, sharing };
  t.after(() => {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
    delete globalThis[key];
  });
  const storageModule = dataModule(Object.keys(storage).map(name => `export const ${name} = globalThis.${key}.storage.${name};`).join('\n'));
  const sharingModule = dataModule(Object.keys(sharing).map(name => `export const ${name} = globalThis.${key}.sharing.${name};`).join('\n'));
  const compiled = source.replaceAll("'./storage'", JSON.stringify(storageModule)).replaceAll("'./sharing'", JSON.stringify(sharingModule));
  const tabA = await import(dataModule(`${compiled}\n// tab A ${moduleNumber++}`));
  const tabB = await import(dataModule(`${compiled}\n// tab B ${moduleNumber++}`));
  records.set('answer', { id: 'answer', teamId: 'team', ownerId: 'owner', objectPath: 'team/owner/answer',
    transcript: 'first', status: 'done', edited: false, revision: 1, syncState: 'pending', uploaded: false,
    blob: new Blob(['video'], { type: 'video/webm' }) });
  return { tabA, tabB, records, remote, objects, sent, entered, release, lockNames, mutate };
}

test('two tabs cannot resurrect a deletion behind an in-flight upload', async t => {
  const h = await setup(t);
  const upload = h.tabA.drainSync();
  await h.entered.promise;
  await h.tabB.markDeleted('answer');
  const deletion = h.tabB.drainSync();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.records.get('answer').deletedAt, 1, 'tombstone survives while another tab uploads');
  assert.equal(h.sent.length, 1, 'waiting tab does not start remote deletion');
  h.release.resolve();
  await Promise.all([upload, deletion]);
  assert.equal(h.records.size, 0);
  assert.equal(h.remote.size, 0);
  assert.equal(h.objects.size, 0);
  assert.deepEqual(h.sent.map(call => call[0]), ['upload', 'delete']);
  assert.equal(h.lockNames.length, 2);
  assert.deepEqual(h.lockNames[0], h.lockNames[1]);
  assert.equal(h.lockNames[0][1], 'exclusive');
});

test('queued tabs and triggers send the newest durable edit after an older upload', async t => {
  const h = await setup(t);
  const first = h.tabA.drainSync();
  await h.entered.promise;
  const queued = h.tabB.drainSync();
  await h.mutate('answer', record => { record.transcript = 'second'; record.revision++; record.syncState = 'pending'; });
  assert.equal(h.tabB.drainSync(), queued, 'requests while waiting share the pending drain');
  await h.mutate('answer', record => { record.transcript = 'latest'; record.revision++; record.syncState = 'pending'; });
  h.tabB.drainSync();
  h.release.resolve();
  await Promise.all([first, queued]);
  assert.equal(h.remote.get('answer').transcript, 'latest');
  assert.equal(h.records.get('answer').transcript, 'latest');
  assert.equal(h.records.get('answer').syncState, 'synced');
  assert.deepEqual(h.sent, [['upload', 'first'], ['update', 'latest']]);
});

for (const failure of ['unsupported', 'rejected']) {
  test(`${failure} Web Locks preserve the Blob, edits and deletion without remote writes`, async t => {
    const h = await setup(t, { [failure]: true });
    let changes = 0;
    await h.tabA.drainSync(() => { changes++; });
    assert.equal(h.records.get('answer').syncState, 'error');
    assert.match(h.records.get('answer').syncError, /sync unavailable/i);
    assert.equal(await h.records.get('answer').blob.text(), 'video');
    await h.tabB.markDeleted('answer');
    await h.tabB.drainSync();
    assert.equal(h.records.get('answer').deletedAt, 1);
    assert.equal(h.records.get('answer').syncState, 'error');
    assert.equal(h.sent.length, 0);
    assert.equal(changes, 1);
  });
}
