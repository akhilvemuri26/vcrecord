import {
  deleteAnswer as removeLocal, getSyncRecord, isLocalAnswer, listSyncRecords,
  mutateRemote, mutateSync, removeRemoteOverlay, markForDeletion, type RemotePendingAnswer, type SyncRecord,
} from './storage';
import {
  deleteAnswer as removeRemote, ensureSession, uploadAnswer,
  updateAnswer as updateRemote, type RemoteAnswer,
} from './sharing';

type RemotePatch = Pick<RemoteAnswer, 'transcript' | 'status' | 'transcriptError' | 'edited'>;
type OnChange = () => void | Promise<void>;
let activeDrain: Promise<void> | undefined;
let requestVersion = 0;
const listeners = new Set<OnChange>();
// IndexedDB and browser identity are shared by every tab on this origin.
const drainLockName = 'vcrecord:shared-answer-sync';

export async function assignTeam(id: string, teamId: string, ownerId: string): Promise<boolean> {
  return mutateSync(id, answer => {
    if (answer.deletedAt || answer.teamId) return;
    answer.teamId = teamId;
    answer.ownerId = ownerId;
    answer.objectPath = `${teamId}/${ownerId}/${id}`;
    answer.revision = (answer.revision ?? 0) + 1;
    answer.syncState = 'pending';
    delete answer.syncError;
  });
}

export function markDeleted(id: string): Promise<void> {
  return markForDeletion(id);
}

function remoteRecord(answer: RemoteAnswer): RemotePendingAnswer {
  return { ...answer, remoteOnly: true, uploaded: true, revision: 0, syncState: 'synced' };
}

export async function queueRemoteEdit(answer: RemoteAnswer, patch: Partial<RemotePatch>): Promise<boolean> {
  return mutateRemote(remoteRecord(answer), current => Object.assign(current, patch));
}

export async function queueRemoteDelete(answer: RemoteAnswer): Promise<void> {
  await mutateRemote(remoteRecord(answer), current => { current.deletedAt = Date.now(); });
}

async function notifyChange(): Promise<void> {
  // View refresh failures must never turn a successful upload into a sync failure.
  await Promise.allSettled([...listeners].map(listener => Promise.resolve().then(listener)));
}

function isDirty(answer: SyncRecord): boolean {
  return !!answer.teamId && (!!answer.deletedAt || answer.syncState !== 'synced');
}

/** One drain across all tabs; failed revisions are attempted once per explicit trigger. */
export function drainSync(onChange?: OnChange): Promise<void> {
  requestVersion += 1;
  if (onChange) listeners.add(onChange);
  if (!activeDrain) {
    activeDrain = runLockedDrain().finally(() => { activeDrain = undefined; listeners.clear(); });
  }
  return activeDrain;
}

async function runLockedDrain(): Promise<void> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  try {
    if (!locks?.request) {
      throw new Error('Sharing sync is unavailable in this browser. Use a browser with Web Locks on HTTPS. Your recording and pending changes remain saved locally.');
    }
    // Hold the lock through reads, network requests and acknowledgment. In particular,
    // another tab must not delete a tombstone while an older upload is in flight.
    await locks.request(drainLockName, { mode: 'exclusive' }, runDrain);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const answer of await listSyncRecords()) {
      if (!isDirty(answer)) continue;
      await mutateSync(answer.id, latest => {
        if (!isDirty(latest)) return;
        latest.syncState = 'error';
        latest.syncError = `Sharing sync unavailable: ${message}`;
      });
    }
    await notifyChange();
  }
}

async function runDrain(): Promise<void> {
  const attempted = new Map<string, number>();
  for (;;) {
    const versionAtRead = requestVersion;
    const answer = (await listSyncRecords()).find(record =>
      isDirty(record) && attempted.get(record.id) !== (record.revision ?? 0));
    if (!answer) {
      if (versionAtRead !== requestVersion) continue;
      return;
    }
    const revision = answer.revision ?? 0;
    attempted.set(answer.id, revision);
    try {
      const userId = await ensureSession();
      if (!answer.ownerId || answer.ownerId !== userId) {
        throw new Error('This recording belongs to a different browser identity. Its original owner must sync it.');
      }
      const path = answer.objectPath ?? `${answer.teamId}/${answer.ownerId}/${answer.id}`;
      // Re-read after authentication: a deletion may have arrived during that request.
      const current = await getSyncRecord(answer.id);
      if (!current) continue;
      if (current.deletedAt) {
        await removeRemote(current.id, path);
        await removeLocal(current.id);
      } else {
        if (isLocalAnswer(answer) && !answer.uploaded) {
          await uploadAnswer({ ...answer, teamId: answer.teamId!, ownerId: answer.ownerId, objectPath: path,
            person: answer.person ?? '', personId: answer.personId ?? '', edited: answer.edited ?? false });
        } else {
          await updateRemote(answer.id, {
            transcript: answer.transcript, status: answer.status,
            transcriptError: answer.transcriptError, edited: answer.edited,
          });
        }
        await mutateSync(answer.id, latest => {
          latest.uploaded = true;
          latest.objectPath = path;
          if (!latest.deletedAt && (latest.revision ?? 0) === revision) {
            latest.syncState = 'synced';
            delete latest.syncError;
          }
        });
        if (!isLocalAnswer(answer)) await removeRemoteOverlay(answer.id, revision);
      }
    } catch (error) {
      await mutateSync(answer.id, latest => {
        if ((latest.revision ?? 0) !== revision) return;
        latest.syncState = 'error';
        latest.syncError = error instanceof Error ? error.message : String(error);
      });
    }
    await notifyChange();
  }
}

/** Local durable remote overlays win over fetched metadata until they are sent. */
export async function listPendingRemote(): Promise<RemotePendingAnswer[]> {
  return (await listSyncRecords()).filter((answer): answer is RemotePendingAnswer =>
    !isLocalAnswer(answer) && !answer.deletedAt);
}

export async function listDeletedIds(): Promise<string[]> {
  return (await listSyncRecords()).filter(answer => !!answer.deletedAt).map(answer => answer.id);
}
