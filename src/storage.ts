export interface Answer {
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

export function listAnswers(): Promise<Answer[]> {
  return transact('readonly', (store, setResult) => {
    const request = store.getAll();
    request.onsuccess = () => {
      const answers = request.result as Answer[];
      answers.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
      setResult(answers);
    };
  });
}

export function getAnswer(id: string): Promise<Answer | undefined> {
  return transact('readonly', (store, setResult) => {
    const request = store.get(id);
    request.onsuccess = () => setResult(request.result as Answer | undefined);
  });
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

/** Applies a synchronous change only if the answer still exists. */
export function updateAnswer(id: string, change: (answer: Answer) => void): Promise<boolean> {
  return transact('readwrite', (store, setResult, abortWith) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const answer = request.result as Answer | undefined;
      if (!answer) {
        setResult(false);
        return;
      }
      try {
        change(answer);
        store.put(answer);
        setResult(true);
      } catch (error) {
        abortWith(error);
      }
    };
  });
}
