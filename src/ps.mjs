// The jobs an agent starts, which `pane.process_info` cannot see.
//
// herdr reports a pane's *foreground process group*, and an agent CLI does not run
// its tool commands there. Kiro CLI and Claude Code both hand the command to a shell
// forked into a new process group with no controlling terminal, as a sibling of the
// tree sitting on the tty. Measured on a live floor: a `sleep` an agent had started
// was in process group 36125 with tty `??`, while the pane's foreground group was
// 36052, so the payload that is supposed to say what the desk is running contained
// the agent, its launcher, its credential helper and its MCP servers, and not the one
// process anybody wanted to see. Every desk read as running nothing, which is exactly
// what a desk genuinely running nothing reads as.
//
// There is no API for the wider tree. `pane.process_info` takes a pane id and nothing
// else, and `PaneProcessInfo` in the published schema carries `foreground_processes`,
// `foreground_process_group_id`, `shell_pid` and `tty`. So the tree gets walked here:
// one `ps` for the whole floor per pass, about 90ms and 270KB on a busy laptop, and
// only the processes *below* a desk's own reported pids are ever described. The table
// is read whole because `ps` cannot be asked for a subtree, and everything outside
// the subtree is dropped without being looked at.
//
// This file is also where the promise at the top of process.mjs gets qualified, so it
// says here what it costs. `ps` reports arguments as one already-joined string, so
// unlike `pane.process_info` there is no structured argv to prefer over a joined
// cmdline, and splitting it back apart on spaces is the only option available. That is
// a genuine widening of what could be read, and it is why the allowlist in process.mjs
// is absolute rather than advisory: a token reaches a desk only if it is a bare word
// of sixteen characters or fewer, and only the single token after the program is even
// a candidate. Quoting is deliberately not reconstructed, because a token torn in half
// by a space fails that allowlist and dropped cannot leak.
//
// The name is asked for separately, as `ucomm`, and that is not a detail. Splitting
// the joined arguments to find the program is what a first attempt did, and on this
// machine every Kiro desk then proudly reported `Kiro`, off the front of
// `/Users/you/.local/tools/kiro-cli/2.0.0/Kiro CLI.app/...`: a space in a path, a
// fragment that happens to be a bare word, and a monitor confidently naming something
// that does not exist. `ucomm` is the kernel's own name for the process, capped at
// sixteen characters and with no arguments in it, so a path with a space in it can now
// only ever cost a sub-command, never invent a program.
import { execFile } from 'node:child_process';

// Long enough that a loaded machine still answers, short enough that a wall display
// never visibly stalls on it.
const PS_TIMEOUT_MS = 2000;
// An agent's argv can be a 33KB settings blob, and there are a thousand processes on
// a working laptop, so the buffer is sized for the whole table rather than for a
// typical one. Overrunning it yields no table, which falls back cleanly.
const PS_MAX_BYTES = 16 * 1024 * 1024;
// A subtree deeper than this is a runaway or a pid-reuse cycle, not somebody's build.
// `seen` below already makes cycles terminate; this bounds the work either way.
const MAX_DEPTH = 12;

const ROW = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/;

// `[[DD-]HH:]MM:SS`, which is how `ps` writes an elapsed time. Returns seconds, or
// null when it is not that shape, because a guessed age is worse than no age.
export function parseElapsed(text) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const [, days, hours, minutes, seconds] = m.map((v) => (v === undefined ? 0 : Number(v)));
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

// `pid ppid etime ucomm arguments...`, one process per line. Anything that is not that
// shape is skipped rather than guessed at.
export function parseProcessTable(text, { self = process.pid } = {}) {
  const rows = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = ROW.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || rows.has(pid)) continue;
    // The office never reports itself. Dropping this row also breaks the chain above
    // the `ps` it just ran, so the reader cannot turn up on a desk as the job.
    if (pid === self) continue;
    // Split on whitespace and nothing cleverer, for the reason in the header: a
    // half-token cannot survive the allowlist, and a reassembled one might. The name
    // comes from `ucomm` instead, which has no arguments in it to be confused with.
    const name = m[4];
    const argv = m[5].trim() ? m[5].trim().split(/\s+/) : [name];
    rows.set(pid, { pid, ppid, age: parseElapsed(m[3]), name, argv0: name, argv });
  }
  return rows;
}

// Every process below `roots`, deepest first, so the innermost job is reached before
// the shell that started it. `roots` are the pids herdr reported for one pane, and
// that is what confines this to one desk's own subtree.
export function descendantsOf(table, roots) {
  if (!(table instanceof Map) || !table.size) return [];
  const children = new Map();
  for (const row of table.values()) {
    const kin = children.get(row.ppid);
    if (kin) kin.push(row);
    else children.set(row.ppid, [row]);
  }
  const seen = new Set((Array.isArray(roots) ? roots : []).filter((pid) => Number.isInteger(pid)));
  let frontier = [...seen];
  const out = [];
  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth += 1) {
    const next = [];
    for (const pid of frontier) {
      for (const child of children.get(pid) || []) {
        if (seen.has(child.pid)) continue;
        seen.add(child.pid);
        next.push(child.pid);
        out.push({ ...child, depth });
      }
    }
    frontier = next;
  }
  return out.sort((a, b) => b.depth - a.depth);
}

// True if this table looks like it came from the machine the pane is on, judged by the
// only thing both sides describe: a pid and the name of the process at it. One
// agreement is enough, and none is a refusal rather than a maybe.
//
// Names are compared by prefix because the two sides truncate differently. herdr and
// `ps` both read the kernel's own name for a process, but the field widths do not
// match: an MCP server that herdr calls `docs-search-mcp` at fifteen characters is
// `docs-search-mcp-` in `ucomm` at sixteen.
function sameMachine(reported, table) {
  if (!(table instanceof Map) || !table.size) return false;
  for (const proc of reported) {
    const row = table.get(proc?.pid);
    if (!row) continue;
    const theirs = String(proc?.name ?? '').split('/').pop();
    const ours = String(row.name ?? '').split('/').pop();
    if (!theirs || !ours) continue;
    if (theirs.startsWith(ours) || ours.startsWith(theirs)) return true;
  }
  return false;
}

// One pane's whole tree, in the shape `runningCommand` reads: the processes herdr
// cannot see first, deepest of those first, then what herdr did report. Order is the
// policy here. The deepest process is the job, and everything above it, up to and
// including the agent, is the furniture the job was started from.
//
// Age is the other half of the policy, and it is what stops this reporting sidecars.
// An agent accumulates long-lived children that are not work: MCP servers, and on a
// managed machine a telemetry collector that had been up for five days when this was
// written. Those are named in the filters in process.mjs, but naming them one at a time
// only ever catches the ones already seen. The general rule is that a job is something
// the agent started *after* it started itself, so a descendant older than everything on
// the pane's own tty came up with the machine rather than with the work, and is not it.
// A process whose age `ps` reported in some shape this cannot read is kept, because the
// name filters still apply to it and a monitor that goes blank is the thing being fixed.
export function paneProcesses(info, table) {
  const reported = Array.isArray(info?.foreground_processes) ? info.foreground_processes : [];
  // Only walk a tree that is demonstrably the same machine's. A plugin pane is spawned
  // by the server whose socket it talks to, so over `herdr --remote` this runs on the
  // remote host beside the agents and the two views agree. But a herdr window can hold
  // panes from several machines, the socket API has no concept of a host to check
  // against, and pids are only unique per machine: trusting them blindly means a desk
  // on another machine could be labelled with whatever local process happens to share a
  // number with it. That is worse than saying nothing, so the tree is only walked when
  // at least one process herdr named is in this table under that name.
  if (!sameMachine(reported, table)) return { foreground_processes: [...reported] };
  const ages = reported.map((p) => table?.get?.(p?.pid)?.age).filter((age) => Number.isFinite(age));
  const youngest = ages.length ? Math.min(...ages) : null;
  const below = descendantsOf(table, reported.map((p) => p?.pid)).filter(
    (p) => youngest === null || !Number.isFinite(p.age) || p.age < youngest,
  );
  return { foreground_processes: [...below, ...reported] };
}

// One `ps` for the whole floor. Always resolves: a monitor that cannot read the tree
// falls back to what herdr reported, rather than taking the office down with it.
export function readProcessTable({ exec = execFile } = {}) {
  return new Promise((resolve) => {
    const done = (text) => resolve(parseProcessTable(text));
    try {
      // An absolute path, because this runs with whatever PATH the session had.
      exec(
        '/bin/ps',
        ['-Ao', 'pid=,ppid=,etime=,ucomm=,args='],
        { timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BYTES, encoding: 'utf8' },
        (err, stdout) => done(err && !stdout ? '' : stdout),
      );
    } catch {
      done('');
    }
  });
}
