import type { Answer, RemotePendingAnswer, SyncRecord } from './storage';
import type { RemoteAnswer } from './sharing';

export type LibraryAnswer = Answer | RemotePendingAnswer | RemoteAnswer;
export type LibraryView = 'recent' | 'question';
export const ALL_PEOPLE = '*';
export const COFOUNDERS = ['Akhil', 'Prakrit', 'Aarav'] as const;
export interface PersonOption { value: string; label: string }

function cleanPerson(person?: string): string {
  return (person ?? '').trim().replace(/\s+/g, ' ');
}

/** A display/filter key only: attribution and authenticated ownership stay unchanged. */
export function normalizePerson(person?: string): string {
  const key = cleanPerson(person).toLowerCase();
  return key === 'akhil vemuri' ? 'akhil' : key;
}

export function personName(person?: string): string {
  const key = normalizePerson(person);
  return COFOUNDERS.find(name => name.toLowerCase() === key) ?? (cleanPerson(person) || 'Unassigned');
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareRecent(a: LibraryAnswer, b: LibraryAnswer): number {
  return b.createdAt - a.createdAt || compareText(b.id, a.id);
}

/** Preserve every durable video while isolating cached remote data to this session. */
export function projectLibrary(
  records: readonly SyncRecord[],
  remoteAnswers: readonly RemoteAnswer[],
  accessibleTeamIds: readonly string[],
  currentUserId: string | null,
): LibraryAnswer[] {
  const teams = new Set(currentUserId ? accessibleTeamIds : []);
  const visible = new Map<string, LibraryAnswer>();
  const scopedRecords = new Map<string, SyncRecord>();
  for (const record of records) {
    if (record.teamId && teams.has(record.teamId) && record.ownerId === currentUserId) {
      scopedRecords.set(record.id, record);
    }
  }
  for (const answer of remoteAnswers) {
    if (!teams.has(answer.teamId)) continue;
    const overlay = scopedRecords.get(answer.id);
    const matchingOverlay = overlay?.teamId === answer.teamId && overlay.ownerId === answer.ownerId;
    if (matchingOverlay && overlay.deletedAt != null) continue;
    visible.set(answer.id, matchingOverlay ? overlay : answer);
  }
  for (const record of scopedRecords.values()) {
    if (record.deletedAt == null && 'remoteOnly' in record && record.remoteOnly) {
      // A pending edit remains useful during a failed or incomplete network refresh.
      const existing = visible.get(record.id);
      if (!existing || (existing.teamId === record.teamId && existing.ownerId === record.ownerId)) {
        visible.set(record.id, record);
      }
    }
  }
  for (const record of records) {
    if (record.deletedAt == null && 'video' in record && record.video instanceof Blob) {
      visible.set(record.id, record);
    }
  }
  return [...visible.values()].sort(compareRecent);
}

export function personOptions(answers: readonly LibraryAnswer[]): PersonOption[] {
  const options: PersonOption[] = [
    { value: ALL_PEOPLE, label: 'All people' },
    ...COFOUNDERS.map(label => ({ value: normalizePerson(label), label })),
  ];
  const historical = new Map<string, string>();
  let unassigned = false;
  for (const answer of answers) {
    const value = normalizePerson(answer.person);
    if (!value) { unassigned = true; continue; }
    if (options.some(option => option.value === value)) continue;
    const label = personName(answer.person);
    const previous = historical.get(value);
    if (!previous || compareText(label, previous) < 0) historical.set(value, label);
  }
  for (const [value, label] of [...historical].sort(([a], [b]) => compareText(a, b))) {
    options.push({ value, label });
  }
  if (unassigned) options.push({ value: '', label: 'Unassigned' });
  return options;
}

export function filterLibrary(
  answers: readonly LibraryAnswer[],
  personFilter = ALL_PEOPLE,
  view: LibraryView = 'recent',
): LibraryAnswer[] {
  return answers.filter(answer => personFilter === ALL_PEOPLE || normalizePerson(answer.person) === personFilter)
    .sort(view === 'question'
      ? (a, b) => compareText(a.question, b.question) || compareRecent(a, b)
      : compareRecent);
}

/** Retain a visible selection; otherwise choose newest even in question view. */
export function selectLibraryAnswer(
  visible: readonly LibraryAnswer[],
  selectedId?: string,
): LibraryAnswer | undefined {
  return visible.find(answer => answer.id === selectedId) ?? [...visible].sort(compareRecent)[0];
}
