// Reading what a desk is running off `pane.process_info`.
//
// The fixtures in here are shaped like the real payloads off a live machine,
// including the parts that make this dangerous: an agent's own argv can be a
// forty-kilobyte JSON settings blob with endpoints and environment variables in
// it, and every agent permanently carries a handful of MCP servers as children.
// The tests that matter most are the ones asserting that none of that reaches a
// label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runningCommand, describeProcess } from '../src/process.mjs';

const proc = (name, argv) => ({ pid: 1, name, argv0: name, argv, cmdline: (argv || [name]).join(' ') });

// A CLI agent sitting at its own prompt, shaped the way herdr reports one: the
// agent, its wrappers, its credential helper. Nothing here is a job.
const IDLE_AGENT = {
  pane_id: 'w1:p1',
  shell_pid: 1,
  foreground_process_group_id: 100,
  foreground_processes: [
    proc('bun', ['/Users/you/Library/Application Support/kiro-cli/bun', '/Users/you/Library/Application Support/kiro-cli/tui.js', 'chat']),
    proc('kiro-cli-chat', ['/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli-chat', 'chat']),
    proc('kiro-cli', ['/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli']),
    proc('launcher', ['/opt/tools/launcher', '--session-id', '00000000-0000-0000-0000-000000000000', '/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli']),
    proc('cred-agent', ['/opt/tools/cred-agent', '--port', '50865', '--exit-on-orphan']),
    proc('tool-exec', ['sandbox', '--client', 'kiro-cli']),
    proc('tool-exec', ['kiro-cli']),
  ],
};

test('an agent doing nothing but being an agent is running nothing', () => {
  assert.equal(runningCommand(IDLE_AGENT), null);
  assert.equal(runningCommand(null), null);
  assert.equal(runningCommand({}), null);
  assert.equal(runningCommand({ foreground_processes: null }), null);
  assert.equal(runningCommand({ foreground_processes: [] }), null);
});

test('MCP servers are furniture, not work', () => {
  // Every agent permanently carries these. A desk that said "docs-mcp" would be
  // saying so all day, about nothing.
  const info = {
    foreground_processes: [
      proc('docs-mcp-darw', ['/opt/mcp/build/docs-mcp/docs-mcp-darwin-arm64']),
      proc('mcp-host', ['/opt/mcp/mcp-host', 'mcp', 'start-server', 'docs-mcp']),
      proc('node', ['node', '/opt/mcp/notes-mcp-server/dist/index.js']),
      proc('search-mcp', ['/opt/mcp/search-mcp', '--include-tools', 'Search,Read']),
      proc('claude', ['/opt/agents/claude-code/bin/claude']),
      proc('tool-exec', ['claude']),
    ],
  };
  assert.equal(runningCommand(info), null);
});

test('a real job is read, and named the way you would say it out loud', () => {
  const running = (p) => runningCommand({ foreground_processes: [p, ...IDLE_AGENT.foreground_processes] });
  assert.equal(running(proc('npm', ['npm', 'test'])), 'npm test');
  assert.equal(running(proc('git', ['git', 'rebase', '--onto', 'main'])), 'git rebase');
  assert.equal(running(proc('cargo', ['cargo', 'build', '--release'])), 'cargo build');
  assert.equal(running(proc('pytest', ['pytest'])), 'pytest');
  assert.equal(running(proc('make', ['make', '-j8'])), 'make');
  // A runtime is only worth reporting when the script says something.
  assert.equal(running(proc('node', ['node', 'scripts/build.js'])), 'node build.js');
  assert.equal(running(proc('node', ['node'])), null);
  // The innermost job wins: the build the test run kicked off is the thing that
  // is actually taking the time.
  assert.equal(
    runningCommand({ foreground_processes: [proc('tsc', ['tsc', '--noEmit']), proc('npm', ['npm', 'test']), ...IDLE_AGENT.foreground_processes] }),
    'tsc',
  );
});

test('nothing private can reach a label', () => {
  // This is the whole point of the file. A settings blob, a token, a home
  // directory, a search pattern: every one of them is dropped rather than cut
  // down, because a truncated secret is still a leak.
  const blob = JSON.stringify({ env: { AWS_SECRET_ACCESS_KEY: 'AKIAIOSFODNN7EXAMPLE', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:17122' } });
  const cases = [
    [proc('claude', ['claude', '--settings', blob]), null], // the agent, and the blob, both gone
    [proc('curl', ['curl', 'https://api.example.com/v1?token=hunter2']), 'curl'],
    [proc('rg', ['rg', 'password = "correct horse battery staple"']), 'rg'],
    [proc('git', ['git', 'clone', 'https://user:pat@github.com/acme/secrets.git']), 'git clone'],
    [proc('grep', ['grep', '-r', '/Users/someone/Desktop/private-project']), 'grep'],
    [proc('ssh', ['ssh', 'deploy@prod-db-01.internal.example.com']), 'ssh'],
    [proc('psql', ['psql', 'postgres://admin:s3cret@db/prod']), 'psql'],
  ];
  for (const [p, want] of cases) {
    const got = runningCommand({ foreground_processes: [p, ...IDLE_AGENT.foreground_processes] });
    assert.equal(got, want, `${p.name}: ${JSON.stringify(got)}`);
    if (got) {
      for (const bad of ['secret', 'token', 'password', 'hunter2', 'AKIA', '@', '=', '/', '"', '{', 'Users']) {
        assert.ok(!got.includes(bad), `${p.name} leaked ${bad} in ${JSON.stringify(got)}`);
      }
    }
  }
  // cmdline is never read, so a process whose cmdline is a secret and whose argv
  // is boring still comes out boring.
  assert.equal(
    describeProcess({ pid: 1, name: 'make', argv: ['make', 'build'], cmdline: `make build AWS_SECRET_ACCESS_KEY=${'A'.repeat(40)}` }),
    'make build',
  );
});

test('a label is always short, and always a bare word or two', () => {
  const bad = [
    { pid: 1, name: '', argv: [] },
    { pid: 1, name: null, argv: null },
    { pid: 1, name: 'a'.repeat(40), argv: [] },
    { pid: 1, name: '/usr/bin/../../etc/passwd', argv: [] },
    { pid: 1, name: 'sh -c evil', argv: [] },
  ];
  for (const p of bad) assert.ok(!describeProcess(p) || describeProcess(p).length <= 32, JSON.stringify(describeProcess(p)));
  // A path as a name is taken as its basename, which is how a process actually
  // shows up, and only if that basename is itself a bare word.
  assert.equal(describeProcess({ pid: 1, name: '/opt/homebrew/bin/rg', argv: ['rg'] }), 'rg');
  assert.equal(describeProcess({ pid: 1, name: 'passwd', argv: ['passwd'] }), 'passwd');
  // Long labels cannot happen: name is capped at 16 and so is the sub-command.
  const long = describeProcess({ pid: 1, name: 'gradlew', argv: ['gradlew', 'assembleReleaseWithAVeryLongTaskName'] });
  assert.equal(long, 'gradlew');
});

test('a wrapper is furniture even when it is wearing the job as a name', () => {
  // The shape a live machine reports: a `name` that is the wrapper and an `argv0`
  // that is the thing being wrapped, or the other way round. Either half naming
  // scaffolding is enough to skip the process, or a desk would spend all day
  // proudly announcing "notes-mcp-server".
  const info = {
    foreground_processes: [
      { pid: 1, name: 'tool-exec', argv0: 'notes-mcp-server', argv: ['notes-mcp-server'] },
      { pid: 2, name: 'node', argv0: 'docs-mcp-darwin-arm64', argv: ['node'] },
      { pid: 3, name: 'caffeinate', argv0: 'caffeinate', argv: ['caffeinate', '-dimsu'] },
      { pid: 4, name: 'runner', argv0: 'search-mcp', argv: ['runner'] },
      ...IDLE_AGENT.foreground_processes,
    ],
  };
  assert.equal(runningCommand(info), null);
  // And the wrapper hiding a real job still reports the job, because the job is
  // the innermost process rather than the outer name.
  assert.equal(
    runningCommand({ foreground_processes: [{ pid: 9, name: 'npm', argv0: 'npm', argv: ['npm', 'test'] }, ...info.foreground_processes] }),
    'npm test',
  );
});

test('a wrapper does not take the job down with it', () => {
  // The case this file used to get wrong. On a managed machine every installed
  // tool is launched through a wrapper, and herdr reports the wrapper as one of
  // `name`/`argv0` and the real program as the other. Treating a wrapper on either
  // side as grounds to skip the process meant a desk running a full test suite
  // showed nothing at all, which is indistinguishable from a desk running nothing.
  const running = (p) => runningCommand({ foreground_processes: [p, ...IDLE_AGENT.foreground_processes] });
  assert.equal(running({ pid: 9, name: 'pytest', argv0: 'tool-exec', argv: ['pytest', '-x'] }), 'pytest');
  // Either way round, because which half holds which varies.
  assert.equal(running({ pid: 9, name: 'tool-exec', argv0: 'cargo', argv: ['cargo', 'build', '--release'] }), 'cargo build');
  // And the wrapper is in front of its own argv too, so the program after it is
  // read as the program rather than as a sub-command of itself.
  assert.equal(running({ pid: 9, name: 'tool-exec', argv0: 'npm', argv: ['/opt/tools/tool-exec', 'npm', 'test'] }), 'npm test');
  // What must not change: a wrapper with nothing but another wrapper on the other
  // side has nothing to report, and a wrapper around scaffolding or around the
  // agent itself is still skipped by the thing it is wrapping.
  assert.equal(running({ pid: 9, name: 'tool-exec', argv0: 'tool-exec', argv: ['tool-exec'] }), null);
  assert.equal(running({ pid: 9, name: 'tool-exec', argv0: 'claude', argv: ['claude'] }), null);
  assert.equal(running({ pid: 9, name: 'tool-exec', argv0: 'devtool', argv: ['devtool', 'mcp', 'start-server'] }), null);
  // The one this got wrong on a real machine: the sandbox supervising each agent is
  // a process with a perfectly informative name, and what gives it away is the
  // sub-command. A desk announcing "devtool sandbox" all day is the same uselessness as
  // a desk announcing "zsh".
  assert.equal(running({ pid: 9, name: 'tool-exec', argv0: 'devtool', argv: ['devtool', 'sandbox', '--client', 'kiro-cli'] }), null);
  // The wrapper's own name is never what gets drawn.
  for (const p of [
    { pid: 9, name: 'pytest', argv0: 'tool-exec', argv: ['pytest'] },
    { pid: 9, name: 'tool-exec', argv0: 'make', argv: ['make', 'build'] },
  ]) {
    assert.ok(!String(running(p)).includes('exec'), JSON.stringify(running(p)));
  }
});
