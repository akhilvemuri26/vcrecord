import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_PEOPLE, filterLibrary, normalizePerson, personName, personOptions, projectLibrary, selectLibraryAnswer } from '../src/library.ts';

const remote = (id, overrides = {}) => ({ id, teamId: 'team', ownerId: 'me', objectPath: `team/me/${id}`, questionId: 'q1', question: 'Question', person: 'Akhil', personId: '', createdAt: 10, duration: 2, mime: 'video/webm', transcript: 'remote', status: 'done', edited: false, ...overrides });
const local = (id, overrides = {}) => ({ ...remote(id), video: new Blob(['original']), audio: new Float32Array([0.2]), revision: 4, ...overrides });
const overlay = (id, overrides = {}) => ({ ...remote(id), remoteOnly: true, transcript: 'pending edit', syncState: 'pending', revision: 2, ...overrides });

test('every durable local Blob survives team and identity changes unchanged', () => {
  const records = [local('old', { teamId: 'old' }), local('new'), local('unassigned', { teamId: undefined, ownerId: undefined })];
  for (const [teams, user] of [[['team'], 'me'], [['other'], 'other-user'], [[], null]]) {
    const answers = projectLibrary(records, [remote('old')], teams, user);
    assert.equal(answers.length, 3);
    for (const record of records) assert.equal(answers.find(answer => answer.id === record.id), record);
  }
  assert.equal(records[0].teamId, 'old');
  assert.equal(records[0].video.size, 8);
  assert.equal(records[0].audio[0], new Float32Array([0.2])[0]);
  assert.equal(records[0].revision, 4);
});

test('remote data and pending overlays are scoped to confirmed teams and current owner', () => {
  const records = [overlay('edit'), overlay('other-owner', { ownerId: 'prior-user' }), overlay('other-team', { teamId: 'old' })];
  const fetched = [remote('edit'), remote('other-owner', { ownerId: 'prior-user' }), remote('hidden', { teamId: 'old' })];
  const answers = projectLibrary(records, fetched, ['team'], 'me');
  assert.equal(answers.find(answer => answer.id === 'edit'), records[0]);
  assert.equal(answers.find(answer => answer.id === 'other-owner'), fetched[1]);
  assert.equal(answers.some(answer => answer.id === 'other-team' || answer.id === 'hidden'), false);
  assert.deepEqual(projectLibrary(records, fetched, ['team'], null), []);
  assert.equal(projectLibrary([records[0]], [], ['team'], 'me')[0], records[0]);
});

test('tombstones suppress only matching accessible owner rows and never expose deleted locals', () => {
  const records = [overlay('deleted', { deletedAt: 0 }), overlay('foreign', { ownerId: 'other', deletedAt: 20 }), overlay('wrong-team', { teamId: 'old', deletedAt: 20 }), local('deleted-local', { deletedAt: 20 })];
  const fetched = [remote('deleted'), remote('foreign', { ownerId: 'other' }), remote('wrong-team'), remote('deleted-local')];
  assert.deepEqual(projectLibrary(records, fetched, ['team'], 'me').map(answer => answer.id), ['wrong-team', 'foreign']);
  assert.equal(projectLibrary([overlay('foreign', { deletedAt: 20 })], [remote('foreign', { ownerId: 'other' })], ['team'], 'me').length, 1);
});

test('local content wins duplicate IDs and pending metadata without altering inputs', () => {
  const saved = local('same', { transcript: 'local', teamId: 'old' });
  const answers = projectLibrary([saved], [remote('same'), remote('same')], ['team'], 'me');
  assert.deepEqual(answers, [saved]);
  assert.equal(saved.transcript, 'local');
  assert.equal(saved.teamId, 'old');
});

test('person aliases, stable options, historical labels, and unassigned filtering', () => {
  const answers = [remote('a', { person: '  AKHIL   Vemuri ' }), remote('b', { person: ' prakrit ' }), remote('c', { person: 'zoe' }), remote('d', { person: ' Zoe ' }), remote('e', { person: '   ' }), remote('f', { person: 'Amy' })];
  assert.equal(normalizePerson('  AKHIL   Vemuri '), 'akhil');
  assert.equal(personName(' prakrit '), 'Prakrit');
  assert.equal(personName(undefined), 'Unassigned');
  assert.deepEqual(personOptions(answers), [
    { value: ALL_PEOPLE, label: 'All people' }, { value: 'akhil', label: 'Akhil' }, { value: 'prakrit', label: 'Prakrit' }, { value: 'aarav', label: 'Aarav' },
    { value: 'amy', label: 'Amy' }, { value: 'zoe', label: 'Zoe' }, { value: '', label: 'Unassigned' },
  ]);
  assert.deepEqual(personOptions([...answers].reverse()), personOptions(answers));
  assert.equal(filterLibrary(answers, 'akhil').length, 1);
  assert.equal(filterLibrary(answers, 'zoe').length, 2);
  assert.equal(filterLibrary(answers, '').length, 1);
  assert.equal(filterLibrary(answers, 'aarav').length, 0);
});

test('recent/question sorting is deterministic and selection falls back to newest', () => {
  const answers = [remote('a', { createdAt: 30, questionId: 'q2', question: 'Why?' }), remote('b', { createdAt: 10, questionId: 'q1', question: 'How?' }), remote('c', { createdAt: 30, questionId: 'q2', question: 'Why?' })];
  assert.deepEqual(filterLibrary(answers).map(answer => answer.id), ['c', 'a', 'b']);
  const byQuestion = filterLibrary(answers, ALL_PEOPLE, 'question');
  assert.deepEqual(byQuestion.map(answer => answer.id), ['b', 'c', 'a']);
  assert.equal(selectLibraryAnswer(byQuestion, 'b').id, 'b');
  assert.equal(selectLibraryAnswer(byQuestion, 'gone').id, 'c');
  assert.equal(selectLibraryAnswer([]), undefined);
  assert.deepEqual(answers.map(answer => answer.id), ['a', 'b', 'c']);
});
