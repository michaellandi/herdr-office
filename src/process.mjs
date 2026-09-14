// What somebody is actually running, read off `pane.process_info`.
//
// The status tells you an agent is working. This tells you what it is working
// *with*: the test run, the build, the rebase. That is the difference between a
// desk that is busy and a desk you can see the job on from across the room.
//
// One rule dominates this file, and it is a safety rule rather than a style one:
// **`cmdline` is never used, and neither is any long or unusual argv token.** A
// real foreground process on a real machine carries API endpoints, tokens, whole
// JSON settings blobs and absolute paths under somebody's home directory in its
// arguments. None of that belongs on a screen somebody screen-shares, so what
// comes out of here is a name and at most one plain sub-command word, both put
// through an allowlist. Anything that is not obviously a bare word is dropped
// rather than trimmed, because "dropped" cannot leak and "trimmed" can.

// The agent itself, the shell it sits in, and the scaffolding herdr and the
// toolbox wrap around both. None of these are the job: they are always there, so
// reporting them would mean every working desk permanently said "zsh".
const NOT_THE_JOB = new Set([
  // shells
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'login',
  // the agents themselves, by every name they run under
  'claude', 'kiro', 'kiro-cli', 'kiro-cli-chat', 'codex', 'gemini', 'cursor',
  'devin', 'cline', 'opencode', 'copilot', 'amp', 'grok', 'droid', 'qwen',
  'kimi', 'pi', 'agy', 'hermes', 'kilo', 'qodercli', 'maki', 'muse', 'q', 'aider',
  // wrappers, launchers and credential helpers
  'toolbox-exec', 'launcher', 'creds_agent', 'aim', 'brazil', 'env', 'sudo',
  // things that are running but are not somebody doing something
  'caffeinate', 'ssh-agent', 'pbcopy', 'pbpaste', 'tee', 'script',
]);

// A whole process is ignored if any of these turn up in its name or in an argv
// token: an MCP server is a permanent child of every agent, and a language
// runtime hosting one is not the agent doing a job either.
const SCAFFOLDING = /mcp|language-server|-lsp\b|tui\.js/i;

// Runtimes that are only interesting because of what they were pointed at. On
// their own they say nothing, so they only survive if the script name does.
const RUNTIMES = new Set(['node', 'bun', 'deno', 'python', 'python3', 'ruby', 'perl', 'java', 'dotnet']);

// A bare word: a command or a sub-command, nothing else. No slashes (a path), no
// equals sign (an assignment), no quotes or braces (a blob), and short enough
// that it cannot be a smuggled sentence.
const BARE = /^[A-Za-z][A-Za-z0-9._:+-]{0,15}$/;

const basename = (str) => String(str ?? '').split('/').pop();

// True if this process is scaffolding rather than a job. Checked against the
// name, argv0 and every argv token, because the giveaway can be in any of them.
function isScaffolding(proc) {
  const name = basename(proc?.name);
  if (!name) return true;
  // argv0 as well as name, because they disagree in practice: herdr reports the
  // toolbox wrappers with `name: 'toolbox-exec'` and `argv0: 'pippin-mcp-server'`,
  // and the informative half is whichever one is not the wrapper.
  const argv0 = basename(proc?.argv0);
  for (const label of [name, argv0]) {
    if (!label) continue;
    if (NOT_THE_JOB.has(label)) return true;
    if (SCAFFOLDING.test(label)) return true;
  }
  const argv = Array.isArray(proc?.argv) ? proc.argv : [];
  // Deliberately tests argv and NOT cmdline. Same information for this purpose,
  // and cmdline is the field that carries the settings blobs.
  for (const tok of argv) if (SCAFFOLDING.test(String(tok ?? ''))) return true;
  return false;
}

// The label for one process, or null if it cannot be described safely.
export function describeProcess(proc) {
  const name = basename(proc?.name);
  if (!name || !BARE.test(name)) return null;
  const argv = (Array.isArray(proc?.argv) ? proc.argv : []).map((t) => String(t ?? ''));
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
