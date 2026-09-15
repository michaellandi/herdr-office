// The filter. It is a small feature with one big rule: it has to mean exactly what
// it looks like it means. A filter box that quietly does something clever is a
// filter box you have to run experiments against, and this one is for when you are
// in a hurry and somebody is waiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterPeople, matches, terms, typeFilterChunk, MAX_FILTER } from '../src/filter.mjs';
import { officeRoster } from './fixtures.mjs';

const people = officeRoster().people;

test('no filter is not a filter', () => {
  // The empty case is the one that runs on every single frame, so it returns the
  // very same array rather than a copy: the floor is not rebuilt sixty times a
  // minute for a feature nobody has switched on.
  const floor = officeRoster().people;
  assert.equal(filterPeople(floor, ''), floor);
  assert.equal(filterPeople(floor, '   '), floor);
  assert.equal(filterPeople(floor, null), floor);
  assert.deepEqual(terms('  '), []);
});

test('a status word means the status', () => {
  const waiting = filterPeople(people, 'waiting');
  assert.ok(waiting.length, 'the fixture office has stuck desks');
  assert.ok(waiting.every((p) => p.status === 'blocked'));
  // The aliases all land in the same place, including the one the API itself uses.
  for (const word of ['stuck', 'blocked', 'hand']) {
    assert.deepEqual(filterPeople(people, word).map((p) => p.id), waiting.map((p) => p.id), word);
  }
  assert.ok(filterPeople(people, 'busy').every((p) => p.status === 'working'));
  assert.ok(filterPeople(people, 'quiet').every((p) => p.status === 'idle'));
});

test('a status word is not also a substring search', () => {
  // The trap: `done` matching a tab called "done-migration" would quietly turn a
  // status filter into a text search, and you would only notice by reading the
  // desks and doubting the tool.
  const odd = [
    { id: 'w1:p1', name: 'Ada', kind: 'claude', status: 'working', tabName: 'done-migration', cwd: '' },
    { id: 'w1:p2', name: 'Bo', kind: 'claude', status: 'done', tabName: 'sso', cwd: '' },
  ];
  assert.deepEqual(filterPeople(odd, 'done').map((p) => p.id), ['w1:p2']);
  // And the other way: a plain word still searches everything, tab names included.
  assert.deepEqual(filterPeople(odd, 'migration').map((p) => p.id), ['w1:p1']);
});

test('half a word narrows, and so does what the desk says', () => {
  // The one that bit in a live drive: typing `/wait` emptied the whole floor,
  // because `wait` is not the alias `waiting` and no other field contains it. A
  // filter you have to finish spelling before it stops lying to you is worse than
  // no filter, so the status words are searchable text as well as exact words.
  const waiting = filterPeople(people, 'waiting');
  for (const partial of ['w', 'wa', 'wai', 'waitin']) {
    const out = filterPeople(people, partial).map((p) => p.status);
    assert.ok(out.includes('blocked'), `${partial} should be on its way to the raised hands`);
  }
  assert.deepEqual(filterPeople(people, 'waitin').map((p) => p.id), waiting.map((p) => p.id));
  // And the nameplate itself: NEEDS YOU is what is drawn, so it is what people type.
  assert.deepEqual(filterPeople(people, 'needs').map((p) => p.id), waiting.map((p) => p.id));
  assert.ok(filterPeople(people, 'unsure').every((p) => p.status === 'unknown'));
  assert.ok(filterPeople(people, 'unsure').length, 'the fixture office has one of those');
  // Exactness still wins where it matters: `done` is a status, not a substring.
  const odd = [{ id: 'w1:p1', name: 'Ada', kind: 'claude', status: 'working', tabName: 'done-migration', cwd: '' }];
  assert.deepEqual(filterPeople(odd, 'done'), []);
});

test('a plain word searches everything worth searching', () => {
  const person = {
    id: 'w1:p9',
    name: 'Zed',
    kind: 'codex',
    status: 'working',
    tabName: 'sso-login',
    workspaceName: 'main',
    title: 'fixing the resolver',
    command: 'cargo build',
    event: { label: 'tests passed', kind: 'good' },
    cwd: '/Users/you/Desktop/projects/herdr-office',
  };
  for (const word of ['zed', 'codex', 'sso', 'main', 'resolver', 'cargo', 'passed', 'herdr-office', 'projects']) {
    assert.ok(matches(person, word), `${word} should match`);
  }
  assert.ok(matches(person, 'ZED'), 'case does not matter');
  assert.ok(!matches(person, 'gemini'));
});

test('every term has to match, and none of them are patterns', () => {
  const person = { id: 'w1:p1', name: 'Ada', kind: 'claude', status: 'blocked', tabName: 'sso-login', cwd: '' };
  assert.ok(matches(person, 'ada sso'));
  assert.ok(matches(person, 'waiting sso'), 'a status word and a text word together');
  assert.ok(!matches(person, 'ada gemini'), 'one miss is a miss');
  // No regex, no globs. A filter of `.*` finds nothing, which is honest: it is not
  // a pattern language and pretending otherwise would be the surprise.
  assert.ok(!matches(person, '.*'));
  assert.ok(!matches(person, 's?o'));
  assert.ok(!matches(person, '!gemini'), 'no negation either');
});

test('typing in the field', () => {
  assert.deepEqual(typeFilterChunk('', 'wait'), { text: 'wait', done: false });
  assert.deepEqual(typeFilterChunk('wait', 'ing\r'), { text: 'waiting', done: true });
  assert.deepEqual(typeFilterChunk('waiting', '\x7f'), { text: 'waitin', done: false });
  assert.deepEqual(typeFilterChunk('waiting sso', '\x17'), { text: 'waiting', done: false });
  assert.deepEqual(typeFilterChunk('waiting', '\x15'), { text: '', done: false });
  // An escape sequence is not text. Not one character of it: an arrow key must not
  // leave `[A` in the filter.
  assert.deepEqual(typeFilterChunk('wait', '\x1b[A'), { text: 'wait', done: false });
  assert.deepEqual(typeFilterChunk('wait', ''), { text: 'wait', done: false });
  // Capped, so the header chip has a bounded thing to draw.
  assert.equal(typeFilterChunk('', 'x'.repeat(MAX_FILTER + 20)).text.length, MAX_FILTER);
  // And whatever junk a paste carries cannot get into the grid through here.
  const junk = typeFilterChunk('', 'rocket 🚀 tab\there').text;
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\u0000-\u001f\u007f]/.test(junk), JSON.stringify(junk));
  assert.ok(!junk.includes('🚀'), JSON.stringify(junk));
});

test('a filter cannot invent people', () => {
  // Whatever it does, it is always a subset of the room, in the same order.
  for (const query of ['waiting', 'a', 'zzz', 'claude', 'group resolver', '/', '  a  ']) {
    const out = filterPeople(people, query);
    assert.ok(out.length <= people.length, query);
    const order = people.filter((p) => out.includes(p));
    assert.deepEqual(out, order, `${query} reordered the floor`);
  }
});
