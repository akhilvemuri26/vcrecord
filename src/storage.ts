export interface SyncMetadata {
  teamId?: string;
  ownerId?: string;
  objectPath?: string;
  syncState?: 'local' | 'pending' | 'synced' | 'error';
  syncError?: string;
  revision?: number;
  uploaded?: boolean;
  deletedAt?: number;
}

export interface Answer extends SyncMetadata {
  id: string;
  questionId: string;
  person?: string;
  personId?: string;
  question: string;
  createdAt: number;
  duration: number;
  mime: string;
  video: Blob;
  audio: Float32Array;
  transcript: string;
  status: 'pending' | 'working' | 'done' | 'error' | 'silent';
  transcriptError?: string;
  edited?: boolean;
}

export type RemotePendingAnswer = Omit<Answer, 'video' | 'audio'> & { remoteOnly: true };
export type SyncRecord = Answer | RemotePendingAnswer;

export function isLocalAnswer(answer: SyncRecord): answer is Answer {
  return !('remoteOnly' in answer && answer.remoteOnly);
}

const DATABASE = 'vcrecord-answers';
const STORE = 'answers';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('This browser does not support local answer storage.'));
      return;
    }

    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    let blocked = false;
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open local answer storage.'));
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Answer storage is open in another tab. Close it and try again.'));
    };
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  action: (
    store: IDBObjectStore,
    resolveResult: (value: T) => void,
    abortWith: (error: unknown) => void,
  ) => void,
): Promise<T> {
  const database = await openDatabase();

  return new Promise<T>((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(STORE, mode);
    } catch (error) {
      database.close();
      reject(error);
      return;
    }

    let result: T;
    let hasResult = false;
    const resolveResult = (value: T) => {
      result = value;
      hasResult = true;
    };

    transaction.oncomplete = () => {
      database.close();
      if (hasResult) resolve(result);
      else reject(new Error('Answer storage returned no result.'));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error('Answer storage transaction was aborted.'));
    };
    transaction.onerror = () => {
      // The abort event carries the final transaction error.
    };

    const abortWith = (error: unknown) => {
      transaction.onabort = () => {
        database.close();
        reject(error);
      };
      transaction.abort();
    };

    try {
      action(transaction.objectStore(STORE), resolveResult, abortWith);
    } catch (error) {
      abortWith(error);
    }
  });
}

export function listSyncRecords(): Promise<SyncRecord[]> {
  return transact('readonly', (store, setResult) => {
    const request = store.getAll();
    request.onsuccess = () => {
      const answers = request.result as SyncRecord[];
      answers.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
      setResult(answers);
    };
  });
}

export async function listAnswers(): Promise<Answer[]> {
  return (await listSyncRecords()).filter((answer): answer is Answer => isLocalAnswer(answer) && !answer.deletedAt);
}

export function getSyncRecord(id: string): Promise<SyncRecord | undefined> {
  return transact('readonly', (store, setResult) => {
    const request = store.get(id);
    request.onsuccess = () => setResult(request.result as SyncRecord | undefined);
  });
}

export async function getAnswer(id: string): Promise<Answer | undefined> {
  const answer = await getSyncRecord(id);
  return answer && isLocalAnswer(answer) && !answer.deletedAt ? answer : undefined;
}

export async function saveAnswer(answer: Answer): Promise<void> {
  await transact<void>('readwrite', (store, setResult) => {
    store.put(answer);
    setResult(undefined);
  });

  // This is only a request; browsers can decline or evict data later.
  if (navigator.storage?.persist) {
    void navigator.storage.persist().catch(() => {});
  }
}

export async function deleteAnswer(id: string): Promise<void> {
  await transact<void>('readwrite', (store, setResult) => {
    store.delete(id);
    setResult(undefined);
  });
}

/** Bookkeeping changes are atomic but never automatically mark content dirty. */
export function mutateSync(id: string, change: (answer: SyncRecord) => void): Promise<boolean> {
  return transact('readwrite', (store, setResult, abortWith) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const answer = request.result as SyncRecord | undefined;
      if (!answer) { setResult(false); return; }
      try {
        change(answer);
        store.put(answer);
        setResult(true);
      } catch (error) { abortWith(error); }
    };
  });
}

/** Late inference results and edits cannot resurrect deleted recordings. */
export function updateAnswer(id: string, change: (answer: Answer) => void): Promise<boolean> {
  return transact('readwrite', (store, setResult, abortWith) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const answer = request.result as SyncRecord | undefined;
      if (!answer || answer.deletedAt || !isLocalAnswer(answer)) { setResult(false); return; }
      try {
        change(answer);
        answer.revision = (answer.revision ?? 0) + 1;
        if (answer.teamId) { answer.syncState = 'pending'; delete answer.syncError; }
        store.put(answer);
        setResult(true);
      } catch (error) { abortWith(error); }
    };
  });
}

/** Materialize remote edits/deletions without replacing a local recording. */
export function mutateRemote(
  remote: RemotePendingAnswer,
  change: (answer: SyncRecord) => void,
): Promise<boolean> {
  return transact('readwrite', (store, setResult, abortWith) => {
    const request = store.get(remote.id);
    request.onsuccess = () => {
      const answer = (request.result as SyncRecord | undefined) ?? remote;
      if (answer.deletedAt) { setResult(false); return; }
      try {
        change(answer);
        answer.revision = (answer.revision ?? 0) + 1;
        answer.syncState = 'pending';
        delete answer.syncError;
        store.put(answer);
        setResult(true);
      } catch (error) { abortWith(error); }
    };
  });
}

/** Remove acknowledged remote overlays only if no newer edit arrived. */
export function removeRemoteOverlay(id: string, revision: number): Promise<void> {
  return transact('readwrite', (store, setResult) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const answer = request.result as SyncRecord | undefined;
      if (answer && !isLocalAnswer(answer) && !answer.deletedAt &&
          (answer.revision ?? 0) === revision) store.delete(id);
      setResult(undefined);
    };
  });
}

/** Choose local deletion or a shared tombstone in the same transaction as the read. */
export function markForDeletion(id: string): Promise<void> {
  return transact('readwrite', (store, setResult) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const answer = request.result as SyncRecord | undefined;
      if (answer) {
        if (!answer.teamId) store.delete(id);
        else if (!answer.deletedAt) {
          answer.deletedAt = Date.now();
          answer.revision = (answer.revision ?? 0) + 1;
          answer.syncState = 'pending';
          delete answer.syncError;
          store.put(answer);
        }
      }
      setResult(undefined);
    };
  });
}
