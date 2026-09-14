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

// A kiro-cli agent sitting at its own prompt, as herdr really reports it: the
// agent, its wrappers, its credential helper. Nothing here is a job.
const IDLE_AGENT = {
  pane_id: 'w1:p1',
  shell_pid: 1,
  foreground_process_group_id: 100,
  foreground_processes: [
    proc('bun', ['/Users/you/Library/Application Support/kiro-cli/bun', '/Users/you/Library/Application Support/kiro-cli/tui.js', 'chat']),
    proc('kiro-cli-chat', ['/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli-chat', 'chat']),
    proc('kiro-cli', ['/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli']),
    proc('launcher', ['/tools/aim/sandbox/launcher', '--session-id', 'bf3c4493-af7e-4385-91ad-4b3d5323b995', '/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli']),
    proc('creds_agent', ['/tools/aim/sandbox/creds_agent', '--port', '50865', '--exit-on-orphan']),
    proc('toolbox-exec', ['aim', 'sandbox', '--client', 'kiro-cli']),
    proc('toolbox-exec', ['kiro-cli']),
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
  // Every agent permanently carries these. A desk that said "builder-mcp" would
  // be saying so all day, about nothing.
  const info = {
    foreground_processes: [
      proc('aws-chorus-mcp-', ['/cache/AIMLocalChorusMCP/build/local-chorus-mcp/aws-chorus-mcp-darwin-arm64']),
      proc('aim', ['/tools/aim/aim', 'mcp', 'start-server', 'local-chorus-mcp']),
      proc('node', ['node', '/tools/pippin-mcp-server/dist/index.js']),
      proc('builder-mcp', ['/tools/builder-mcp/builder-mcp', '--include-tools', 'SkillsTool,InternalSearch']),
      proc('claude', ['/tools/claude-code/bin/claude']),
      proc('toolbox-exec', ['claude']),
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
  // Straight off a live machine: herdr reports these with a `name` that is the
  // wrapper and an `argv0` that is the thing being wrapped, or the other way
  // round. Either half naming scaffolding is enough to skip the process, or a
  // desk would spend all day proudly announcing "pippin-mcp-server".
  const info = {
    foreground_processes: [
      { pid: 1, name: 'toolbox-exec', argv0: 'pippin-mcp-server', argv: ['pippin-mcp-server'] },
      { pid: 2, name: 'node', argv0: 'aws-chorus-mcp-darwin-arm64', argv: ['node'] },
      { pid: 3, name: 'caffeinate', argv0: 'caffeinate', argv: ['caffeinate', '-dimsu'] },
      { pid: 4, name: 'runner', argv0: 'builder-mcp', argv: ['runner'] },
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
