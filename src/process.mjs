// What somebody is actually running, read off `pane.process_info`.
//
// The status tells you an agent is working. This tells you what it is working
// *with*: the test run, the build, the rebase. That is the difference between a
// desk that is busy and a desk you can see the job on from across the room.
//
// One rule dominates this file, and it is a safety rule rather than a style one:
// **no long or unusual token ever reaches a screen, and of herdr's payload the
// `cmdline` field is never read at all.** A real foreground process on a real
// machine carries API endpoints, tokens, whole JSON settings blobs and absolute
// paths under somebody's home directory in its arguments. None of that belongs on a
// screen somebody screen-shares, so what comes out of here is a name and at most one
// plain sub-command word, both put through an allowlist. Anything that is not
// obviously a bare word is dropped rather than trimmed, because "dropped" cannot
// leak and "trimmed" can.
//
// The allowlist is also load-bearing for a caller this file cannot see. The jobs an
// agent starts are not in the pane's foreground process group, so src/ps.mjs walks
// the tree with `ps` and feeds the results through here, and `ps` reports arguments
// pre-joined with no structured argv to prefer. That file owns the argument at
// length. What matters here is that these functions are the only thing standing
// between a joined command line and a wall display, so they stay absolute: shape
// checks first, and no token is ever trimmed to fit.

// The agent itself, the shell it sits in, and the scaffolding wrapped around
// both. None of these are the job: they are always there, so reporting them would
// mean every working desk permanently said "zsh".
const NOT_THE_JOB = new Set([
  // shells
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'login',
  // the agents themselves, by every name they run under
  'claude', 'kiro', 'kiro-cli', 'kiro-cli-chat', 'codex', 'gemini', 'cursor',
  'devin', 'cline', 'opencode', 'copilot', 'amp', 'grok', 'droid', 'qwen',
  'kimi', 'pi', 'agy', 'hermes', 'kilo', 'qodercli', 'maki', 'muse', 'q', 'aider',
  // launchers and the environment they are launched through
  'launcher', 'env', 'sudo', 'doas', 'nice',
  // things that are running but are not somebody doing something
  'caffeinate', 'ssh-agent', 'pbcopy', 'pbpaste', 'tee', 'script',
]);

// Wrappers, sandboxes and credential helpers, matched by the shape of the name
// rather than by product: a managed machine has several of them, they vary by
// employer, and they are all called some variation on this. Matching the shape
// means an environment this was never run in still gets a clean monitor.
const WRAPPER = /^(.*-(exec|shim|wrapper|sandbox)|.*launcher|creds?[-_]?agent|sandbox)$/i;

// A whole process is ignored if any of these turn up in its name or in an argv
// token: an MCP server is a permanent child of every agent, and a language
// runtime hosting one is not the agent doing a job either.
// Telemetry is in here for the same reason MCP servers are, and it was found the same
// way: walking a live tree turned up an OpenTelemetry collector five days old sitting
// under an agent, with seven `agent-telemetry` siblings beside it. A desk announcing
// that would announce it until the machine was rebooted.
const SCAFFOLDING = /mcp|language-server|-lsp\b|tui\.js|telemetry|otelcol|collector/i;

// Runtimes that are only interesting because of what they were pointed at. On
// their own they say nothing, so they only survive if the script name does.
const RUNTIMES = new Set(['node', 'bun', 'deno', 'python', 'python3', 'ruby', 'perl', 'java', 'dotnet']);

// A bare word: a command or a sub-command, nothing else. No slashes (a path), no
// equals sign (an assignment), no quotes or braces (a blob), and short enough
// that it cannot be a smuggled sentence.
const BARE = /^[A-Za-z][A-Za-z0-9._:+-]{0,15}$/;

const basename = (str) => String(str ?? '').split('/').pop();

// The half of the process that says something.
//
// `name` and `argv0` disagree in practice: a wrapped process is reported with the
// wrapper as one of the two and the thing being wrapped as the other, so the
// informative half is whichever one is not a wrapper. Reading `name` alone, or
// throwing away anything with a wrapper on either side, throws away the job with
// the wrapper. On a machine where every installed tool is launched through one,
// that is every job there is.
function informative(proc) {
  for (const label of [basename(proc?.name), basename(proc?.argv0)]) {
    if (label && !WRAPPER.test(label)) return label;
  }
  return null;
}

// The process's own argv with the wrapper taken off the front. A wrapped job is
// launched as `wrapper program sub-command`, so dropping the wrapper leaves the
// program in front and the sub-command behind it, which is what both the filter
// and the label want to read.
function jobArgv(proc) {
  let argv = (Array.isArray(proc?.argv) ? proc.argv : []).map((t) => String(t ?? ''));
  while (argv.length && WRAPPER.test(basename(argv[0]))) argv = argv.slice(1);
  return argv;
}

// True if this process is scaffolding rather than a job. Checked against the
// name, argv0 and every argv token, because the giveaway can be in any of them.
function isScaffolding(proc) {
  const labels = [basename(proc?.name), basename(proc?.argv0)].filter(Boolean);
  if (!labels.length) return true;
  // An agent or an MCP server is still one of those whichever half names it, so
  // these two discard the process outright.
  for (const label of labels) {
    if (NOT_THE_JOB.has(label)) return true;
    if (SCAFFOLDING.test(label)) return true;
  }
  // A wrapper, by contrast, only makes its own half unreadable. Both halves being
  // wrappers is what leaves nothing worth reporting.
  if (!informative(proc)) return true;
  const argv = jobArgv(proc);
  // Deliberately tests argv and NOT cmdline. Same information for this purpose,
  // and cmdline is the field that carries the settings blobs.
  for (const tok of argv) if (SCAFFOLDING.test(tok)) return true;
  // A wrapper shape in the sub-command position rather than the name: on this
  // machine every agent is supervised by its toolchain running `devtool sandbox`, which
  // is a real process with an informative name doing nothing anybody wants a desk
  // to announce. A program whose job is a sandbox or a launcher is supervising
  // something, not doing something, whichever word carries that.
  for (const tok of argv.slice(1)) if (WRAPPER.test(basename(tok))) return true;
  return false;
}

// The label for one process, or null if it cannot be described safely.
export function describeProcess(proc) {
  const name = informative(proc);
  if (!name || !BARE.test(name)) return null;
  const argv = jobArgv(proc);
  // argv[0] is the program again (sometimes as a full path), so the sub-command
  // is the first token after it. Only one, and only if it is a bare word: `git
  // rebase` and `npm test` are worth reading, and a search pattern or a file path
  // is both uninteresting and the thing most likely to be private.
  const rest = argv.slice(1).filter((t) => !t.startsWith('-'));
  const sub = rest.length && BARE.test(rest[0]) ? rest[0] : null;
  if (RUNTIMES.has(name)) {
    // A runtime with nothing safe to say about it is not worth a row on a desk.
    const script = rest.length ? basename(rest[0]) : null;
    if (!script || !BARE.test(script)) return null;
    return `${name} ${script}`;
  }
  return sub ? `${name} ${sub}` : name;
}

// What the pane is running, as one short line, or null if it is only running the
// agent. `foreground_processes` is the whole foreground tree (the agent, its MCP
// servers, and anything it has shelled out to), deepest first, so the first
// process that is not scaffolding is the innermost real job.
export function runningCommand(info) {
  const procs = Array.isArray(info?.foreground_processes) ? info.foreground_processes : [];
  for (const proc of procs) {
    if (isScaffolding(proc)) continue;
    const label = describeProcess(proc);
    if (label) return label;
  }
  return null;
}
