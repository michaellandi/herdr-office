// Every request the office can send, checked against the server's own schema.
//
// This exists because of what happened to the news labels. That feature was wrong on
// the wire for its entire life and nothing noticed, because a request the server
// rejects and a request nobody ever sends look identical from in here: silence. The
// office talks to herdr over a socket whose shape is owned by another program on a
// version that moves, and most of what it can say is only said when somebody presses a
// key, so the write path can rot for months without a single test going red.
//
// So this reads the schema herdr itself prints and holds the office to it. Two things
// it can catch that no other test here can:
//
//   - a method name or a parameter the server has never heard of, including in the
//     paths a test suite cannot exercise, because sending `agent.prompt` or
//     `worktree.create` for real means typing into somebody's actual agent and making
//     a branch in their actual repository;
//   - an event descriptor that is not a real event, which matters more than it sounds:
//     one bad name makes the server reject the whole `events.subscribe` and close the
//     stream, silently, for the rest of the session. Every event after it is simply
//     never delivered.
//
// What it deliberately does not claim: that any of this *works*. Conforming to the
// schema is spelling, not meaning. `agent.send_keys` with the right parameter names
// can still send the wrong key to the wrong desk, and this test would be delighted.
//
// It reads the source rather than a hand-written table of requests, because a table is
// a second copy of the truth and would drift from the call sites. Writing this, my own
// first pass used a table, and it reported `agent.read` as missing a required parameter
// that the real call site had passed all along.
//
// With no herdr on PATH there is no schema to check against and every assertion here is
// skipped. That is the honest outcome and not a pass: the office is a herdr plugin, and
// a machine without herdr cannot say whether it speaks the protocol correctly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The schema as the installed herdr prints it, or null if there is no herdr here.
function liveSchema() {
  try {
    const out = execFileSync('herdr', ['api', 'schema', '--json'], {
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

const SCHEMA = liveSchema();
const SKIP = SCHEMA ? false : 'no herdr on PATH: nothing to check the protocol against';

// `$ref` is how the schema says everything interesting, so a checker that does not
// follow them passes everything. Mine did, at first: `params` is a bare `$ref` on
// every request variant, so a check reading `properties` off it saw no properties, no
// required fields, and no reason to complain about anything at all.
function deref(node, depth = 0) {
  if (!node || typeof node !== 'object') return node;
  if (!node.$ref) return node;
  assert.ok(depth < 8, `$ref cycle at ${node.$ref}`);
  const target = node.$ref.replace(/^#\//, '').split('/').reduce((cur, seg) => cur?.[seg], SCHEMA);
  assert.ok(target, `unresolvable $ref: ${node.$ref}`);
  const merged = { ...target };
  for (const [k, v] of Object.entries(node)) if (k !== '$ref') merged[k] = v;
  return deref(merged, depth + 1);
}

function variants(defPath) {
  const def = defPath.split('.').reduce((cur, seg) => cur?.[seg], SCHEMA);
  const byName = new Map();
  for (const v of def?.oneOf || []) {
    const name = v?.properties?.method?.const ?? v?.properties?.type?.const;
    if (name) byName.set(name, v);
  }
  return byName;
}

/* ------------------------------------------ what the office actually sends */

function sources() {
  const files = ['office.mjs', ...readdirSync(join(ROOT, 'src')).filter((f) => f.endsWith('.mjs')).map((f) => join('src', f))];
  return files.map((rel) => ({ rel, text: readFileSync(join(ROOT, rel), 'utf8') }));
}

// The object literal starting at `from`, as the set of keys written in it.
//
// A key is whatever identifier comes first after the opening brace or after a comma at
// depth one. Reading it that way rather than looking for `name:` is not pedantry: half
// the call sites in this office use shorthand, so `{ target: person.id, keys }` has a
// parameter named `keys` and a pattern needing a colon finds only one of the two. My
// first version needed the colon, and the vacuity check at the bottom of this file is
// what said so.
//
// Strings and comments are skipped rather than scanned, because a comma inside either
// one otherwise starts a new key: one call site has a comment with a comma in it, and
// the word after that comma would have been reported as a parameter the server has
// never heard of.
function literalKeys(text, from) {
  const keys = new Set();
  let spread = false;
  let depth = 0;
  let expectKey = false;
  for (let i = from; i < text.length; i += 1) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      for (i += 1; i < text.length && text[i] !== c; i += 1) if (text[i] === '\\') i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      if (i < 0) break;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i);
      if (i < 0) break;
      i += 1;
      continue;
    }
    if (c === '{') {
      depth += 1;
      if (depth === 1) expectKey = true;
      continue;
    }
    if (c === '}') {
      depth -= 1;
      if (depth === 0) break;
      continue;
    }
    if (depth !== 1) continue;
    if (c === ',') {
      expectKey = true;
      continue;
    }
    if (!expectKey || /\s/.test(c)) continue;
    if (text.startsWith('...', i)) {
      spread = true;
      expectKey = false;
      continue;
    }
    const m = /^[A-Za-z_]\w*/.exec(text.slice(i));
    expectKey = false;
    if (m) {
      keys.add(m[0]);
      i += m[0].length - 1;
    }
  }
  return { keys, spread };
}

// Every `request('method', {...})` in the source, wherever it is called from: the
// office holds three different sockets and graphics.mjs has its own.
function calls() {
  const found = [];
  for (const { rel, text } of sources()) {
    const re = /\.request\(\s*'([a-z][\w.]*)'\s*,\s*\{/g;
    let m;
    while ((m = re.exec(text))) {
      const line = text.slice(0, m.index).split('\n').length;
      const brace = text.indexOf('{', m.index + m[0].length - 1);
      found.push({ method: m[1], where: `${rel}:${line}`, ...literalKeys(text, brace) });
    }
    // `pane.graphics.set` passes its parameters on the line after the method name.
    const split = /\.request\(\s*\n\s*'([a-z][\w.]*)',\s*\n\s*\{/g;
    while ((m = split.exec(text))) {
      const line = text.slice(0, m.index).split('\n').length;
      const brace = text.indexOf('{', m.index + m[0].length - 1);
      found.push({ method: m[1], where: `${rel}:${line}`, ...literalKeys(text, brace) });
    }
  }
  return found;
}

function office() {
  return readFileSync(join(ROOT, 'office.mjs'), 'utf8');
}

// Every `type:` written in office.mjs, which is two different vocabularies sharing one
// key name. An event descriptor's type is an event name and always has a dot in it; an
// output match's type is `substring` or `regex` and never does. Splitting them on the
// dot means both get checked, against different parts of the schema, rather than the
// match types being quietly dropped from a list of events they were never members of.
function typeValues() {
  return [...office().matchAll(/type: '([\w.]+)'/g)].map((m) => m[1]);
}

// The event descriptors, built in two places: a list of names for the global
// subscriptions and one literal for the per-desk output match.
function descriptors() {
  const global = /const GLOBAL_EVENTS = \[([^\]]*)\]/.exec(office());
  assert.ok(global, 'GLOBAL_EVENTS is not where this test expects it');
  const names = [...global[1].matchAll(/'([\w.]+)'/g)].map((m) => m[1]);
  return [...new Set([...names, ...typeValues().filter((v) => v.includes('.'))])];
}

/* ---------------------------------------------------------------- the checks */

test('the office is talking to a protocol that exists', { skip: SKIP }, () => {
  assert.equal(typeof SCHEMA.protocol, 'number');
  assert.ok(SCHEMA.schemas?.request?.oneOf?.length, 'no request variants in the schema');
});

test('every method the office can call is a method the server has', { skip: SKIP }, () => {
  const known = variants('schemas.request');
  for (const call of calls()) {
    assert.ok(known.has(call.method), `${call.where}: '${call.method}' is not a method at protocol ${SCHEMA.protocol}`);
  }
});

test('every parameter the office sends is one the server takes', { skip: SKIP }, () => {
  const known = variants('schemas.request');
  for (const call of calls()) {
    const params = deref(known.get(call.method)?.properties?.params);
    const props = params?.properties;
    // A method whose parameters the schema does not describe cannot be checked, and
    // saying nothing about it is better than reporting a pass nobody earned.
    if (!props || !Object.keys(props).length) continue;
    for (const key of call.keys) {
      assert.ok(key in props, `${call.where}: '${call.method}' has no parameter '${key}'`);
    }
  }
});

test('every required parameter is actually sent', { skip: SKIP }, () => {
  const known = variants('schemas.request');
  for (const call of calls()) {
    // A spread means the keys are decided at run time and this file cannot see them.
    if (call.spread) continue;
    const params = deref(known.get(call.method)?.properties?.params);
    for (const key of params?.required || []) {
      assert.ok(call.keys.has(key), `${call.where}: '${call.method}' requires '${key}'`);
    }
  }
});

test('every event the office subscribes to is a real event', { skip: SKIP }, () => {
  // The one that bites hardest. A descriptor the server does not recognise does not
  // fail on its own: it rejects the entire subscribe, closes the stream, and every
  // event the office was going to be told about for the rest of the session is not
  // delivered. Nothing on screen says so.
  const known = variants('schemas.request.$defs.Subscription');
  assert.ok(known.size > 10, `only ${known.size} subscription variants: the schema shape has moved`);
  for (const name of descriptors()) {
    assert.ok(known.has(name), `'${name}' is not a subscribable event at protocol ${SCHEMA.protocol}`);
  }
});

test('the output match subscription carries what that event requires', { skip: SKIP }, () => {
  // This is the subscription the news labels ride on, and the one with parameters
  // worth getting wrong: a source, a match and a window.
  const variant = variants('schemas.request.$defs.Subscription').get('pane.output_matched');
  assert.ok(variant, 'the server no longer offers pane.output_matched');
  const text = readFileSync(join(ROOT, 'office.mjs'), 'utf8');
  const at = text.indexOf("type: 'pane.output_matched'");
  assert.ok(at > 0, 'the output match subscription is not where this test expects it');
  const { keys } = literalKeys(text, text.lastIndexOf('{', at));
  for (const key of variant.required || []) {
    assert.ok(keys.has(key), `the output match subscription is missing required '${key}'`);
  }
  for (const key of keys) {
    assert.ok(key in variant.properties, `the output match subscription sends unknown '${key}'`);
  }
});

test('the way the office asks for a match is a way the server matches', { skip: SKIP }, () => {
  const kinds = new Set((SCHEMA.schemas.request.$defs.OutputMatch?.oneOf || []).map((v) => v?.properties?.type?.const));
  const used = typeValues().filter((v) => !v.includes('.'));
  assert.ok(used.length, 'no output match type found: the split on the dot has stopped working');
  for (const kind of used) assert.ok(kinds.has(kind), `'${kind}' is not an output match type at protocol ${SCHEMA.protocol}`);
});

test('every part of a screen the office asks for is one the server offers', { skip: SKIP }, () => {
  // `source` is an enum, so a plausible-looking typo is a request that fails at run
  // time and nowhere else. `recent_unwrapped` in particular is easy to get wrong and
  // is only reached when a desk goes idle, which no test here does.
  const allowed = new Set(SCHEMA.schemas.request.$defs.ReadSource?.enum || []);
  assert.ok(allowed.size, 'ReadSource is no longer an enum: this check needs rewriting');
  const used = [...new Set([...office().matchAll(/source: '(\w+)'/g)].map((m) => m[1]))];
  assert.ok(used.length >= 2, `only found ${used.length} read sources`);
  for (const src of used) assert.ok(allowed.has(src), `'${src}' is not a readable source at protocol ${SCHEMA.protocol}`);
});

test('the source really was read, and every call site was found', { skip: SKIP }, () => {
  // The failure this test is most likely to have is finding nothing and reporting
  // that nothing was wrong. Both counts are floors, not exact figures, so ordinary
  // work does not have to come back here, but deleting the socket layer or breaking
  // the pattern that finds the call sites lands as a failure rather than as silence.
  const found = calls();
  assert.ok(found.length >= 20, `only found ${found.length} request call sites`);
  assert.ok(new Set(found.map((c) => c.method)).size >= 15, 'suspiciously few distinct methods');
  assert.ok(descriptors().length >= 12, 'suspiciously few event descriptors');
  // And the parser has to actually see keys, or every check above passes vacuously.
  const send = found.find((c) => c.method === 'agent.send_keys');
  assert.ok(send?.keys.has('target') && send.keys.has('keys'), 'the literal parser is not reading keys');
});
