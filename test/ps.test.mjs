// Walking the tree herdr cannot see.
//
// The fixture below is the shape of a real live floor, reduced to the part that
// matters: an agent whose visible tree sits on the pane's tty, and the shell it
// forked off the tty to run a command in. herdr reports only the first group, so
// every test in here is really one test, asked several ways: is the job found, and
// is nothing found that was not asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProcessTable, parseElapsed, descendantsOf, paneProcesses, readProcessTable } from '../src/ps.mjs';
import { runningCommand } from '../src/process.mjs';

// `ps -Ao pid=,ppid=,ucomm=,args=`, trimmed to one pane's worth plus some of the
// machine. The pids and the tree shape are the ones measured on a live session,
// including the app-bundle paths with spaces in them; the home directory is written the
// way this repo writes one.
const PS = `
    1     0 12-04:11:09 launchd          /sbin/launchd
36052 36051    03:22:14 devtool          devtool sandbox --client kiro-cli
36053 36052    03:22:14 launcher         /Users/you/.local/tools/devtool/1.0.0.0/sandbox/launcher --session-id 00000000-0000-0000-0000-000000000000
36057 36053    03:22:13 kiro-cli         /Users/you/.local/tools/kiro-cli/2.0.0/Kiro CLI.app/Contents/MacOS/kiro-cli
36092 36057    03:22:13 kiro-cli-chat    /Users/you/.local/tools/kiro-cli/2.0.0/Kiro CLI.app/Contents/MacOS/kiro-cli-chat chat
36122 36092    03:22:12 bun              /Users/you/Library/Application Support/kiro-cli/bun /Users/you/Library/Application Support/kiro-cli/tui.js chat
36125 36122    03:22:11 kiro-cli-chat    /Users/you/.local/tools/kiro-cli/2.0.0/Kiro CLI.app/Contents/MacOS/kiro-cli-chat acp
39785 36125 04-23:27:25 otelcol-contrib  /usr/local/bin/otelcol-contrib --config /etc/otel/config.yaml
48078 36125       00:04 bash             bash
48079 48078       00:03 sleep            sleep 300
 9001     1  2-01:00:00 mysqld           /usr/local/mysql/bin/mysqld --datadir=/usr/local/mysql/data
 9002     1  2-01:00:00 secretagentd     /usr/libexec/secretagentd --token abcdef
`;

// What herdr hands back for that pane: the foreground process group, and nothing
// below it. Note 48079 is absent, which is the entire problem.
const REPORTED = {
  pane_id: 'w1:pA',
  shell_pid: 83243,
  foreground_process_group_id: 36052,
  foreground_processes: [
    { pid: 36122, name: 'bun', argv0: 'bun', argv: ['/Users/you/Library/Application Support/kiro-cli/bun', '/Users/you/Library/Application Support/kiro-cli/tui.js', 'chat'] },
    { pid: 36092, name: 'kiro-cli-chat', argv0: 'kiro-cli-chat', argv: ['kiro-cli-chat', 'chat'] },
    { pid: 36057, name: 'kiro-cli', argv0: 'kiro-cli', argv: ['kiro-cli'] },
    { pid: 36053, name: 'launcher', argv0: 'launcher', argv: ['launcher', '--session-id', '00000000-0000-0000-0000-000000000000'] },
    { pid: 36052, name: 'tool-exec', argv0: 'devtool', argv: ['devtool', 'sandbox', '--client', 'kiro-cli'] },
  ],
};

test('a table is pid, parent and command, and nothing else is guessed at', () => {
  const table = parseProcessTable(PS);
  assert.equal(table.get(48079).ppid, 48078);
  assert.deepEqual(table.get(48079).argv, ['sleep', '300']);
  assert.equal(table.get(48079).age, 3);
  assert.equal(table.get(48078).name, 'bash');
  // Leading spaces are how ps right-aligns pids, so they cannot be significant.
  assert.equal(table.get(9001).ppid, 1);
  // Lines that are not that shape are skipped rather than half-read.
  const junk = parseProcessTable('total garbage\n\n  PID  PPID ELAPSED COMMAND\nnot a row\n42 7 00:09 real real --flag');
  assert.equal(junk.size, 1);
  assert.equal(junk.get(42).name, 'real');
  // A process with no arguments reported still gets an argv, so nothing downstream
  // has to special-case it.
  assert.deepEqual(parseProcessTable('42 7 00:09 lonely').get(42).argv, ['lonely']);
  // The office is never in its own table: the row is dropped, which also strands the
  // `ps` it just spawned rather than describing it as somebody's job.
  assert.equal(parseProcessTable('42 7 00:09 me me', { self: 42 }).size, 0);
  for (const empty of ['', null, undefined, '\n\n']) assert.equal(parseProcessTable(empty).size, 0);
});

test('the tree below a desk is walked deepest first', () => {
  const table = parseProcessTable(PS);
  const below = descendantsOf(table, [36122]);
  assert.deepEqual(below.map((p) => p.pid), [48079, 39785, 48078, 36125]);
  // Deepest first is what makes the job win over the shell that started it.
  assert.ok(below[0].depth > below[below.length - 1].depth);
  // Nothing to walk from, nothing walked.
  assert.deepEqual(descendantsOf(table, []), []);
  assert.deepEqual(descendantsOf(table, [999999]), []);
  assert.deepEqual(descendantsOf(null, [36122]), []);
  assert.deepEqual(descendantsOf(new Map(), [36122]), []);
});

test('a process table that points at itself still terminates', () => {
  // pid reuse can leave a parent pointing at its own descendant. A wall display must
  // come back from that rather than spin.
  const table = parseProcessTable('10 11 00:01 one one\n11 10 00:01 two two\n12 10 00:01 three three');
  const below = descendantsOf(table, [10]);
  assert.deepEqual(below.map((p) => p.pid).sort(), [11, 12]);
});

test('the job an agent started is what the desk reports', () => {
  // The whole reason this file exists. Before the tree was walked, this was null.
  const table = parseProcessTable(PS);
  assert.equal(runningCommand(paneProcesses(REPORTED, table)), 'sleep');
  // Without a table it degrades to what herdr reported, which is the agent and its
  // furniture, which is nothing.
  assert.equal(runningCommand(paneProcesses(REPORTED, null)), null);
  assert.equal(runningCommand(paneProcesses(REPORTED, new Map())), null);
  // And the shell the agent ran it in is furniture, not the answer.
  assert.ok(!String(runningCommand(paneProcesses(REPORTED, table))).includes('bash'));
});

test('only the desk\'s own subtree is ever described', () => {
  // mysqld and secretagentd are in the table, because ps cannot be asked for a
  // subtree. Neither is below this pane, so neither can reach a monitor however
  // interesting its name is.
  const table = parseProcessTable(PS);
  const label = runningCommand(paneProcesses(REPORTED, table));
  for (const bad of ['mysqld', 'secretagentd', 'abcdef', 'launchd']) {
    assert.ok(!String(label).includes(bad), `${bad} escaped its own subtree`);
  }
  assert.ok(!descendantsOf(table, [36122]).some((p) => [9001, 9002, 1].includes(p.pid)));
});

test('joined arguments are still only read a bare word at a time', () => {
  // The cost of using ps: arguments arrive as one string, so this is the widening the
  // header in src/ps.mjs owns up to. The allowlist is what makes it survivable, so
  // here it is, being leaned on.
  const secret = 'AKIAIOSFODNN7EXAMPLE';
  const table = parseProcessTable([
    '100 1 03:00:00 shell shell',
    `101 100 00:02 rg /opt/homebrew/bin/rg --hidden ${secret}`,
    '102 100 00:02 curl curl https://api.example.com/v1?token=hunter2',
    '103 100 00:02 psql psql postgres://admin:s3cret@db/prod',
    '104 100 00:02 aws aws s3 cp /Users/somebody/private.env s3://bucket/',
  ].join('\n'));
  const labels = descendantsOf(table, [100]).map((p) => runningCommand({ foreground_processes: [p] }));
  assert.deepEqual(labels.sort(), ['aws s3', 'curl', 'psql', 'rg'].sort());
  for (const label of labels) {
    for (const bad of [secret, 'hunter2', 's3cret', 'token', 'Users', 'private.env', '@', '=', '://']) {
      assert.ok(!String(label).includes(bad), `leaked ${bad} in ${JSON.stringify(label)}`);
    }
  }
});

test('the jobs somebody actually waits on come out readable', () => {
  const table = parseProcessTable([
    '200 1 03:00:00 shell shell',
    '201 200 00:30 cargo cargo build --release',
    '202 200 00:30 git git rebase --onto main feature',
    '203 200 00:30 make make -j8 all',
    '204 200 00:30 node node --test test/grid.test.mjs',
    '205 200 00:30 sleep sleep 300',
  ].join('\n'));
  const label = (pid) => runningCommand({ foreground_processes: [table.get(pid)] });
  assert.equal(label(201), 'cargo build');
  assert.equal(label(202), 'git rebase');
  assert.equal(label(203), 'make all');
  assert.equal(label(204), 'node grid.test.mjs');
  assert.equal(label(205), 'sleep');
});

test('a ps that will not run leaves the office standing', () => {
  // Every failure mode resolves to an empty table, because the fallback (report what
  // herdr said) is correct and a rejected promise in the poll loop is not.
  const cases = [
    (cmd, args, opts, cb) => cb(new Error('ENOENT'), '', ''),
    (cmd, args, opts, cb) => cb(new Error('timed out'), '', 'killed'),
    () => { throw new Error('spawn refused'); },
    (cmd, args, opts, cb) => cb(null, ''),
  ];
  return Promise.all(
    cases.map(async (exec) => {
      const table = await readProcessTable({ exec });
      assert.equal(table.size, 0);
    }),
  );
});

test('ps is asked for the whole table once, with no shell in the way', () => {
  // Sizes and flags are load-bearing: `-A` because a subtree cannot be asked for, an
  // absolute path because PATH is whatever the session had, and an argument array
  // rather than a command string so nothing is ever handed to a shell.
  let seen = null;
  readProcessTable({
    exec: (cmd, args, opts, cb) => {
      seen = { cmd, args, opts };
      cb(null, '1 0 00:09 launchd /sbin/launchd');
    },
  });
  assert.equal(seen.cmd, '/bin/ps');
  assert.deepEqual(seen.args, ['-Ao', 'pid=,ppid=,etime=,ucomm=,args=']);
  assert.ok(seen.opts.timeout > 0 && seen.opts.timeout <= 5000);
  assert.ok(seen.opts.maxBuffer >= 1024 * 1024);
});

test('a space in a path cannot invent a program', () => {
  // The bug this cost a round trip to the live session to find. Splitting the joined
  // arguments to get the program turned `.../Kiro CLI.app/Contents/MacOS/kiro-cli-chat`
  // into `Kiro`, which is a bare word, passes every allowlist, and is not a thing. The
  // name now comes from `ucomm`, so the fragment can only ever cost a sub-command.
  const table = parseProcessTable(PS);
  assert.equal(table.get(36125).name, 'kiro-cli-chat');
  const label = runningCommand(paneProcesses(REPORTED, table));
  assert.equal(label, 'sleep');
  for (const row of table.values()) {
    const said = runningCommand({ foreground_processes: [row] });
    assert.ok(said !== 'Kiro' && said !== 'CLI.app', `${row.pid} reported ${JSON.stringify(said)}`);
  }
});

test('an elapsed time is read the several ways ps writes one', () => {
  assert.equal(parseElapsed('00:03'), 3);
  assert.equal(parseElapsed('01:30'), 90);
  assert.equal(parseElapsed('03:22:14'), 12134);
  assert.equal(parseElapsed('04-23:27:25'), 430_045);
  assert.equal(parseElapsed(' 2-01:00:00 '), 176_400);
  // Unreadable is null rather than a guess, and null means the age filter abstains.
  for (const bad of ['', null, undefined, 'ages', '1:2:3:4', '-', '12']) assert.equal(parseElapsed(bad), null);
});

test('a sidecar older than the desk it sits under is furniture', () => {
  // Found on a live floor: an OpenTelemetry collector five days old under an agent
  // whose pane was three hours old. It is a real process with an informative name and
  // it would have owned that desk's monitor until the machine was rebooted. The name
  // filters catch this one by shape, so the age rule is checked here on its own terms.
  const table = parseProcessTable(PS);
  const otel = table.get(39785);
  assert.ok(otel.age > 4 * 86400, 'the fixture should carry a genuinely old sidecar');
  const kept = paneProcesses(REPORTED, table).foreground_processes.map((p) => p.pid);
  assert.ok(!kept.includes(39785), 'the five-day sidecar reached the desk');
  assert.ok(kept.includes(48079), 'the four-second job did not');
  // With no readable ages anywhere, the rule abstains rather than blanking the monitor.
  const ageless = parseProcessTable(PS.replace(/\d+-?[\d:]*:\d\d /g, 'ages '));
  assert.ok(paneProcesses(REPORTED, ageless).foreground_processes.length > 0);
});

test('a desk on another machine is never labelled from this machine\'s table', () => {
  // A herdr window can hold panes from several saved SSH machines, the socket API has
  // no host field to check against, and pids are only unique per machine. So a remote
  // desk whose pids happen to collide with local ones must come back blank rather than
  // wearing somebody else's job. The check is that herdr and ps agree about the name of
  // at least one process, which a coincidence of numbers will not satisfy.
  const table = parseProcessTable(PS);
  const elsewhere = {
    pane_id: 'w2:pA',
    // Same pids as the local fixture, entirely different machine.
    foreground_processes: [
      { pid: 36122, name: 'nginx', argv0: 'nginx', argv: ['nginx', '-g', 'daemon off;'] },
      { pid: 36092, name: 'postgres', argv0: 'postgres', argv: ['postgres'] },
    ],
  };
  const walked = paneProcesses(elsewhere, table).foreground_processes;
  assert.deepEqual(walked.map((p) => p.pid), [36122, 36092], 'a foreign tree was walked');
  assert.equal(runningCommand(paneProcesses(elsewhere, table)), 'nginx');
  // Nothing out of this machine's table reached it.
  for (const bad of [48079, 48078, 39785, 36125]) {
    assert.ok(!walked.some((p) => p.pid === bad), `local pid ${bad} landed on a remote desk`);
  }
  // The local pane still walks, so the guard is a guard and not a wall.
  assert.equal(runningCommand(paneProcesses(REPORTED, table)), 'sleep');
  // Truncation differs between the two sources, so agreement is by prefix: herdr says
  // fifteen characters where ucomm says sixteen.
  const truncated = { foreground_processes: [{ pid: 36125, name: 'kiro-cli-cha', argv0: 'kiro-cli-cha', argv: ['kiro-cli-cha'] }] };
  assert.equal(runningCommand(paneProcesses(truncated, table)), 'sleep');
});
