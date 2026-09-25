# Herdr Office

[![check](https://github.com/michaellandi/herdr-office/actions/workflows/check.yml/badge.svg)](https://github.com/michaellandi/herdr-office/actions/workflows/check.yml)
[![herdr 0.9.0+](https://img.shields.io/badge/herdr-0.9.0%2B-7c3aed.svg)](https://herdr.dev)
[![node 18+](https://img.shields.io/badge/node-18%2B-brightgreen.svg)](https://nodejs.org)
[![license MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [Herdr](https://herdr.dev) plugin that draws your agents as people in an open-plan
office. Every agent is a person at a desk. They type while they work, doze when they
are idle, and **raise a hand** when they are blocked on an approval. Click a desk (or
hit enter) to ask what they are up to.

![the office](docs/demo.gif)

The card pinned to each cubicle wall is the **tab name**, so you can see who is on
which job without opening anything. When someone gets stuck, a **speech bubble**
appears over their head with the actual thing they are waiting on, and `y` / `n`
answers it from right here without walking over to their pane.

## Install

```sh
herdr plugin install michaellandi/herdr-office
```

Or clone it and link it instead, which is the one you want if you plan to change the
art:

```sh
git clone https://github.com/michaellandi/herdr-office.git && cd herdr-office
herdr plugin link .
```

No dependencies and no build step: it is plain Node (18+) talking to the Herdr socket API.

## Use

| How | What |
|---|---|
| `herdr plugin action invoke office.view.open` | Open the office as a zoomed pane |
| `herdr plugin action invoke office.view.peek` | Open it as a session-modal popup |
| `herdr plugin pane open --plugin office.view --entrypoint office --placement tab` | Pick your own placement |
| `node office.mjs` | Run it standalone in any terminal that can reach the socket |
| `node office.mjs --demo` | Fake roster, no server needed (good for hacking on the art) |
| `node office.mjs --once` | Render a single frame to stdout and exit |
| `node office.mjs --quiet` | Same, without the toast when somebody starts waiting on you |
| `node office.mjs --no-title` | Same, leaving the window title alone |
| `node office.mjs --no-graphics` | Text only, no pixel charts, even where the terminal can draw them |
| `node office.mjs --no-git` | Never run git in anybody's checkout, so no desk shows uncommitted work |
| `node office.mjs --no-context` | Never read anybody's screen for a context gauge, so no desk shows how full it is |
| `node office.mjs --follow` | Start in shepherd mode, standing at whoever needs you |
| `node office.mjs --zoom=list` | Open as the compact list (or `--zoom=cubicle` for one desk) |

Bind it to a key in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+o"
type = "plugin_action"
command = "office.view.open"
description = "open the office"
```

You get a Herdr toast when somebody starts waiting on you. Run it with `--quiet` if you
would rather not.

## Keys

| Key | Action |
|---|---|
| arrows / `hjkl` | walk around the floor (walking off the edge pages to the next floor) |
| `enter` / click | ask that person what they are up to |
| drag a desk onto another | swap the two real panes |
| `+` / click the empty desk | hire somebody: opens a tab and starts an agent in it |
| `w` / `t` / `e` (hiring) | into a new worktree / back to a plain tab / name the branch |
| `a` | give the selected person a job |
| `A` | standup: give the same job to everybody who is free |
| `^w` / `^u` (typing) | delete the last word / clear the field |
| `y` / click `[y]` | approve what they are stuck on |
| `n` / click `[n]` | deny it |
| `s` | answer them in words, for a question that is not a yes or a no |
| `Y` | allow it from now on, when the prompt offers that. Arms, and `enter` grants |
| `/` | filter the floor: names, kinds, tabs, directories, statuses |
| `F` | shepherd mode: walk to hands as they go up |
| `z` | zoom: floor plan, list view, one desk |
| `b` | jump to the next raised hand |
| `f` | focus that agent's real pane |
| `r` | refresh now |
| `esc` | close the panel |
| `q` | leave |

`y` and `n` work from the floor and from an open desk, on whoever is selected. They
only do anything if that person is actually waiting on you.

The `[y]` and `[n]` drawn on a stuck person's monitor are real buttons: click either
one to answer that desk without selecting it first or opening anything. The same
choices in the detail panel's **answer them** row are clickable too.

## Who is who

| State | Desk |
|---|---|
| `working` | hands on the keyboard, green. The monitor shows the command it is running when herdr can name one, and scrolling code when it cannot |
| `blocked` | hand up and waving, `APPROVE?` on screen, a speech bubble with the ask, pulsing amber |
| `idle` | dozing (`z`), slate |
| `done` | arms up, `ALL DONE`, cyan |
| `unknown` | shrugging, violet. Herdr sees an agent it cannot classify, which is *not* proof of completion |

Desks are named by seat from a pool of forty, so the front row is always Ada,
Bo, Cass, Dev and Ede. Faces, hair and shirt colours come from the pane id instead, so
a desk keeps its look between runs even if a new pane appearing earlier on the floor
shifts the names along. `*` marks the focused pane.
Durations prefixed with `~` are a lower bound: the API reports current state, not when
it was entered, so the first sighting of an agent starts the clock. Reopening the office
does not restart it, though. Each desk's clock is kept for the day and picked up again
wherever herdr can show the desk has not changed state in between, and one that did
change while the pane was shut goes back to `~` ([the day book](docs/design.md#the-day-book)).

## What a desk tells you

One line each, with the reasoning behind it in
[`docs/design.md`](docs/design.md):

| On a desk | What it means |
|---|---|
| the monitor's contents | the actual foreground command, `npm test` or `cargo build`, and scrolling code when herdr cannot name one ([why only a command name](docs/design.md#what-they-are-working-on)) |
| a speech bubble | the thing they are actually stuck on, with `[y]` and `[n]` as real buttons ([answering](docs/design.md#answering-from-the-office)) |
| `┌─ 73% ─┐` in the monitor's frame | how full that agent's context window is. Colour above 50%, heavier frame above 90%, bare edge means nobody has read it yet ([how full their head is](docs/design.md#how-full-their-head-is)) |
| a pile of paper | how much is uncommitted in that checkout, and it turns the colour of bad news if anything is conflicted ([how much they have changed](docs/design.md#how-much-they-have-changed)) |
| `@feature/sso` on the bottom line | the branch, which gives up its space before the job does ([which branch](docs/design.md#which-branch-they-are-on)) |
| a coloured slab, for 12s | news off the terminal: tests passing, a build breaking, a merge conflict ([news from a desk](docs/design.md#news-from-a-desk)) |
| the sticky note | the tab name |
| the wall colour | which workspace, one shade per room ([rooms](docs/design.md#rooms-one-per-workspace)) |

And around the floor: a **whiteboard** with where the session's time actually went
([the punch clock](docs/design.md#what-the-day-actually-looked-like)), an **empty desk**
you can hire into ([hiring](docs/design.md#hiring-somebody)), and a **window title**
carrying the headline count ([on the window itself](docs/design.md#on-the-window-itself)).

Three things are worth knowing up front, because they are the rules the whole thing
is built around:

- **Almost nothing off a screen reaches your screen.** Commands go through an
  allowlist, a matched output line only picks which of seven fixed labels to show, the
  context parser emits a number and a model name and nothing else, and git returns
  counts rather than paths. This pane gets screen-shared, so a truncated secret is
  treated as a secret and dropped rather than trimmed.
- **`y`, `n`, `s`, `Y`, `a` and `A` send real input to real agents.** They are the only
  things here that cannot be taken back, and they are the most guarded part of the
  plugin. `--demo` prints what it would have sent instead.
- **Every line is exactly as wide as the pane.** One cell too many wraps and shoves the
  whole floor down a row. `test/grid.test.mjs` is the suite that matters.

## Hacking on it

```sh
node --test test/*.test.mjs      # the whole suite, no dependencies to install
node office.mjs --demo           # the office, with a fake roster and no server
node office.mjs --once --demo    # one frame to stdout, for diffing the art
./scripts/record-demo.sh         # re-record the README's GIF (needs vhs + ffmpeg)
```

Two rules that are easy to break by accident:

- **Only unambiguous-width glyphs in the art.** Latin-1, box drawing (U+2500 to
  U+257F) and block elements (U+2580 to U+259F). Geometric Shapes start at U+25A0 and
  are off limits, because `▪` is one cell in some terminals and two in others, which
  is unfixable once it is on the grid. `test/sprites.test.mjs` enforces this.
- **Never test approve, deny, answer, grant or assign against a live office.** Those
  keys type at somebody's real agent. `--demo` prints what it would have sent, and the
  tests send them for real down a socket no agent is listening on.

CI runs the suite plus a couple of live `--once` renders on macOS and Linux across
Node 18, 20 and 22, and a separate job installs herdr and checks every request the
office can send against that herdr's own schema, on both the oldest version supported
and the current one. The Herdr marketplace indexes whatever is on the default branch
rather than a release tag, so `main` is what strangers install and it has to stay
green.

[`docs/design.md`](docs/design.md) covers the rest: what every request costs, what each
test suite exists to catch, and the reasoning behind each surface above. The source is
commented at about the same depth, and for anything belonging to a single file the
comment there is the source of truth rather than the doc.

## Known rough edges

- **A request/response socket answers exactly once and then closes.** Measured against
  herdr 0.9.0 on 2026-09-17: one request, one answer, connection gone, whether or not
  anything was concurrent. A second request written to the same socket gets `EPIPE`
  even when written in the same tick as the first answer arriving. So the client opens
  a connection per request and still sends them single file, and callers can fire
  whatever they like concurrently. A raw `Promise.all` over one socket of your own
  would keep the first answer and lose the rest.
- **The event socket is the exception**: `events.subscribe` holds its connection open
  and pushes, and one invalid entry rejects the whole batch and leaves it silent
  forever, which looks exactly like nothing ever happening.
- **Emoji and other ambiguous-width glyphs are stripped** from pane titles and screen
  text before drawing, because they wreck a fixed cell grid.
- **`y` sends a real keystroke to a real agent.** The prompt shape is inferred, so on
  an agent whose approval UI nobody has taught it about, `y` falls back to enter. Check
  what the panel says it will send before trusting it on a new agent.
- **The "stuck on" line is a heuristic** over the visible screen: keybinding hints are
  filtered out and real questions preferred, but a novel prompt shape can still fool
  it. The full screen is right there underneath it.
- macOS and Linux only. Windows would work in principle (the socket helper falls back
  to the CLI path Herdr recommends) but is untested.

## License

MIT. See [LICENSE](LICENSE).
