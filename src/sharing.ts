import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://hedvfgmuezfyhrrzcjok.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_Hvp_aKOvLpCdNkWe9bMw2Q_xA3giH0w';
const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

export type AnswerStatus = 'pending' | 'working' | 'done' | 'error' | 'silent';

export interface RemoteAnswer {
  id: string;
  teamId: string;
  ownerId: string;
  objectPath: string;
  questionId: string;
  question: string;
  person: string;
  personId: string;
  createdAt: number;
  duration: number;
  mime: string;
  transcript: string;
  status: AnswerStatus;
  transcriptError?: string;
  edited: boolean;
}

export type UploadAnswer = RemoteAnswer & { video: Blob };

export type AnswerPatch = Partial<Pick<RemoteAnswer, 'transcript' | 'status' | 'transcriptError' | 'edited'>>;

let activeUserId: string | null = null;
let sessionPromise: Promise<string> | undefined;

supabase.auth.onAuthStateChange((event, session) => {
  const previousUserId = activeUserId;
  activeUserId = session?.user.id ?? null;
  if (event === 'SIGNED_OUT' || (previousUserId && activeUserId && previousUserId !== activeUserId)) {
    sessionPromise = undefined;
  }
});

function throwIfError(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

export function getUserId(): string | null {
  return activeUserId;
}

/** Restores the saved anonymous session or creates one for this browser. */
export function ensureSession(): Promise<string> {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    const { data, error } = await supabase.auth.getSession();
    throwIfError(error);
    if (data.session?.user.id) {
      activeUserId = data.session.user.id;
      return activeUserId;
    }
    const signedIn = await supabase.auth.signInAnonymously();
    throwIfError(signedIn.error);
    const id = signedIn.data.user?.id;
    if (!id) throw new Error('Anonymous sign-in did not return a user.');
    activeUserId = id;
    return id;
  })().catch((error: unknown) => {
    sessionPromise = undefined;
    throw error;
  });
  return sessionPromise;
}

function newInviteToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createTeam(name: string): Promise<{ id: string; invite: string }> {
  await ensureSession();
  const invite = newInviteToken();
  const { data, error } = await supabase.rpc('create_team', {
    p_name: name,
    p_invite_token: invite,
  });
  throwIfError(error);
  if (typeof data !== 'string') throw new Error('Team creation returned no team ID.');
  return { id: data, invite };
}

export async function joinTeam(id: string, invite: string): Promise<string> {
  await ensureSession();
  const { data, error } = await supabase.rpc('join_team', {
    p_team_id: id,
    p_invite_token: invite,
  });
  throwIfError(error);
  if (typeof data !== 'string') throw new Error('Joining the team returned no team ID.');
  return data;
}

function fromRow(row: Record<string, unknown>): RemoteAnswer {
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    ownerId: String(row.owner_user_id),
    objectPath: String(row.object_path),
    questionId: String(row.question_id),
    question: String(row.question),
    person: String(row.person ?? ''),
    personId: String(row.person_id ?? ''),
    createdAt: new Date(String(row.created_at)).getTime(),
    duration: Number(row.duration),
    mime: String(row.mime),
    transcript: String(row.transcript ?? ''),
    status: row.status as AnswerStatus,
    transcriptError: typeof row.transcript_error === 'string' ? row.transcript_error : undefined,
    edited: Boolean(row.edited),
  };
}

function toRow(answer: UploadAnswer): Record<string, unknown> {
  const createdAt = new Date(answer.createdAt).toISOString();
  return {
    id: answer.id,
    team_id: answer.teamId,
    owner_user_id: answer.ownerId,
    person: answer.person,
    person_id: answer.personId,
    question_id: answer.questionId,
    question: answer.question,
    created_at: createdAt,
    duration: answer.duration,
    mime: answer.mime,
    object_path: answer.objectPath,
    transcript: answer.transcript,
    status: answer.status,
    transcript_error: answer.transcriptError ?? null,
    edited: answer.edited,
    updated_at: createdAt,
  };
}

export async function fetchAnswers(teamId: string): Promise<RemoteAnswer[]> {
  await ensureSession();
  const answers: RemoteAnswer[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase.from('answers')
      .select('id, team_id, owner_user_id, person, person_id, question_id, question, created_at, duration, mime, object_path, transcript, status, transcript_error, edited')
      .eq('team_id', teamId).order('created_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + 499);
    throwIfError(error);
    answers.push(...(data ?? []).map(row => fromRow(row as Record<string, unknown>)));
    if (!data || data.length < 500) return answers;
  }
}

/** Stores the private video first, then inserts or updates mutable metadata. */
export async function uploadAnswer(answer: UploadAnswer): Promise<void> {
  await ensureSession();
  if (answer.objectPath !== `${answer.teamId}/${answer.ownerId}/${answer.id}`) {
    throw new Error('The recording path does not match its team, owner, and answer ID.');
  }
  const { error: uploadError } = await supabase.storage
    .from('recordings')
    .upload(answer.objectPath, answer.video, {
      contentType: answer.mime,
    });
  if (uploadError) {
    const conflict = 'statusCode' in uploadError && uploadError.statusCode === '409';
    if (!conflict) throw new Error(uploadError.message);
    // A prior attempt may have saved the object but failed before its row.
    // Downloading through the private policy confirms this exact path is ours.
    const { data: existingVideo, error: verifyError } = await supabase.storage
      .from('recordings')
      .download(answer.objectPath);
    throwIfError(verifyError);
    if (!existingVideo) throw new Error('Could not verify the existing private recording.');
  }

  const { data: existing, error: lookupError } = await supabase
    .from('answers')
    .select('id, team_id, owner_user_id, question_id, question, created_at, duration, mime, object_path')
    .eq('id', answer.id)
    .maybeSingle();
  throwIfError(lookupError);

  if (existing) {
    const row = existing as Record<string, unknown>;
    const identityMatches = row.team_id === answer.teamId
      && row.owner_user_id === answer.ownerId
      && row.question_id === answer.questionId
      && row.question === answer.question
      && new Date(String(row.created_at)).getTime() === answer.createdAt
      && Number(row.duration) === answer.duration
      && row.mime === answer.mime
      && row.object_path === answer.objectPath;
    if (!identityMatches) throw new Error('A different shared answer already uses this answer ID.');
    await updateAnswer(answer.id, answer);
    return;
  }

  const { error: insertError } = await supabase.from('answers').insert(toRow(answer));
  throwIfError(insertError);
}

export async function updateAnswer(id: string, patch: AnswerPatch): Promise<void> {
  await ensureSession();
  const row: Record<string, unknown> = {};
  if (patch.transcript !== undefined) row.transcript = patch.transcript;
  if (patch.status !== undefined) row.status = patch.status;
  if (Object.hasOwn(patch, 'transcriptError')) row.transcript_error = patch.transcriptError ?? null;
  if (patch.edited !== undefined) row.edited = patch.edited;
  if (Object.keys(row).length === 0) return;
  const { data, error } = await supabase.from('answers').update(row).eq('id', id).select('id').maybeSingle();
  throwIfError(error);
  if (!data) throw new Error('This answer is unavailable or belongs to another owner.');
}

export async function deleteAnswer(id: string, path: string): Promise<void> {
  await ensureSession();
  const { error: rowError } = await supabase.from('answers').delete().eq('id', id);
  throwIfError(rowError);
  const { error: objectError } = await supabase.storage.from('recordings').remove([path]);
  throwIfError(objectError);
}

export async function downloadVideo(path: string): Promise<Blob> {
  await ensureSession();
  const { data, error } = await supabase.storage.from('recordings').download(path);
  throwIfError(error);
  if (!data) throw new Error('The shared recording download was empty.');
  return data;
}
