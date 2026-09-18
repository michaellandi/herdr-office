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

## Hiring somebody

When there is a free slot on the last floor, the office draws **an empty desk**: a
chair nobody is in and a monitor that is off. Walk to it and press enter, or click
it, and the bottom half of the pane becomes a menu of every agent this machine can
actually start (that list comes from herdr's own manifests, so it is what will
work here rather than every name the CLI knows). Pick one and the office opens a
tab and starts that agent in its pane, in the same directory as the desk you had
focused, so a hire lands in the project you are already working on.

`+` opens the same menu from anywhere, which is the only way in on a pane too
small to draw a desk in.

### Into a new worktree

The row under the title is **where** the hire lands. `w` switches it from this
project to a fresh git worktree, and the office offers a branch name with the
agent's own name and the time in it (`office/claude-0914-1502`), which follows the
cursor as you move through the menu. `e` renames it, starting from an empty field
so you are not backspacing through a timestamp, and `esc` mid-rename puts the old
name back rather than abandoning the hire. `t` goes back to a plain tab.

A worktree hire is one `worktree.create`, which brings its own workspace, tab and
pane, and then the same `agent.start` into that pane. The branch name is filtered
as you type (letters, digits, `.`, `_`, `/`, `-`, and a space becomes a hyphen) and
sanitized once more on the way out, so what reaches git is a name git will take.
Nothing about the repository is auto-trusted: if herdr would have asked you to
trust it, it still asks, and the office reports the refusal instead of waving it
through. A hire that fails leaves the worktree, the branch and the files exactly
where they are.

Starting an agent means waiting for it to reach its own prompt, which can take
most of a minute, so the hire runs on its own connection: the floor keeps
animating and polling while somebody is being shown to their desk, and the empty
desk says who it is waiting for. If the agent never comes up, the office says so
and **leaves the tab where it is** rather than closing a pane on your behalf.

Nothing about this fires on a stray click. The empty desk only opens the menu; the
only thing that starts an agent is a name in that menu.

## Assigning work

`a` opens a field in the bottom half of the pane and whatever you type in it gets
typed into that agent and acted on. `A` does the same thing to everybody who is
free at once, which is the standup: one instruction, one keystroke, the whole
floor.

This is the only thing the office does that cannot be taken back, so it is the
most guarded part of it:

- **A broadcast confirms first.** Enter on a standup does not send it. It swaps the
  field for the list of people it is about to reach, by name, plus who it is
  skipping and why, and *that* enter sends. `esc` goes back to the text rather than
  throwing it away, so checking who gets it costs you nothing.
- **Nothing in the field is clickable.** Every other panel in the office has
  buttons; this one has none, on purpose. You had to reach the keyboard to type the
  text at all, so enter is already under your hand, and a click target reading
  "send this to six agents" is exactly the stray click there is no undoing. The
  mouse is ignored entirely while the field is open, because the floor underneath
  it still has `[y]` and `[n]` drawn on it.
- **Somebody with their hand up is refused up front.** Herdr rejects a prompt to a
  blocked agent before it sends anything, so the office says "Cass has a hand up:
  answer that first" when you press `a` rather than after you have written a
  paragraph.
- **Somebody mid-task is left alone.** A standup reaches the idle, the done and the
  ones herdr cannot classify. Barging in on an agent already doing what you asked
  is an interruption, not a standup, and it is not something one keystroke gets to
  do to five agents at once. The panel counts who it skipped either way.
- **Every key is a letter.** Nothing falls through to the floor while the field has
  the keyboard, or a `y` typed in the middle of a sentence would approve something
  for somebody.
- A blank prompt is refused, whitespace is collapsed, the field caps at 400
  characters, and a partial failure is reported as what it was: "sent to 4 of 5;
  not Dev (agent_blocked)".

## What they are working on

A working desk's monitor shows the actual foreground command, so `npm test`,
`cargo build` or `git rebase` is readable from across the floor with a bar
chugging underneath it. When herdr cannot name one, which is the normal case for
an agent that is thinking rather than shelling out, the monitor goes back to
scrolling code rather than making something up.

**Only a command name and at most one sub-command word ever reach the screen.**
That is a privacy rule rather than a display one. A real foreground process
carries API endpoints, tokens, whole JSON settings blobs and absolute paths under
your home directory in its arguments, and this thing is on screen while you are
screen-sharing. So both words go through an allowlist (a bare word, letters and
digits and a couple of punctuation marks, 16 characters at most), and anything
that is not obviously a plain word is dropped rather than trimmed, because a
truncated secret is still a secret. `rg 'password = ...'` reads as `rg`; `claude
--settings {...}` reads as nothing at all.

Finding the command means reading the process tree twice, and the second read is
worth knowing about. herdr's `pane.process_info` reports the pane's *foreground
process group*, and an agent does not run its tool commands there: Kiro CLI and
Claude Code both hand the command to a shell forked into its own process group
with no controlling terminal. So a desk running a full test suite showed nothing
at all, which looks exactly like a desk running nothing. The tree below the pane
is therefore walked with one `ps` per poll for the whole floor, and only
processes below that desk's own pids are ever described. `ps` reports arguments
already joined into one string, so unlike herdr's payload there is no structured
argv to prefer, and the allowlist above is what makes reading it survivable: a
token torn in half by a space fails it and is dropped. `src/ps.mjs` says all of
this at more length, including what it cost to get wrong.

Shells, the agents themselves, the wrappers and credential helpers a managed
machine adds, the MCP servers every agent permanently carries and the telemetry
daemons it accumulates are all filtered out, so a busy desk says what the job is
instead of saying `zsh` all day. The wrappers are matched on the shape of the
name rather than by product, so a machine this was never run on still gets a
clean monitor. Sidecars are caught by age as well as by name: a process older
than everything on the pane's own terminal came up with the machine rather than
with the work, so it is furniture no matter what it is called.

## News from a desk

When something notable comes out of an agent's terminal, a small slab appears over
that desk for twelve seconds: green for tests passing, a build going green, a
commit or a push; red for a failing suite, a broken build or a panic; purple for a
merge conflict. It is news rather than status, so it expires on its own clock
instead of waiting for the agent to change state, and **somebody with their hand up
keeps the wall**: an ask always outranks news, because a raised hand is the only
thing in the room you have to act on.

**The matched output line is never drawn.** Herdr matches one regex per pane and
hands back the line that fired, and the office uses it only to pick which of its
own seven fixed labels to show. The same patterns do the matching server-side and
the labelling locally, so the two cannot drift apart. A failing assertion full of
your file paths, a URL with a token in it, a stack trace out of a private
repository: none of it reaches the screen, all it can ever do is decide whether
the slab says "the build broke".

The suite that matters here asserts exactly that, by feeding the classifier lines
carrying paths, credentials and home directories and checking the label that comes
back is one of the fixed strings. One caveat worth knowing: `0 failed` is the happy
path, so the failure patterns require a non-zero count. An office that read every
green test run as a disaster would be worse than one that said nothing.

## Saying it again

A toast when somebody starts waiting on you is easy. The second toast is the hard
one, because a tool that nags gets muted and a muted tool might as well not have
shipped. So the office nudges on a ladder: a minute after a hand goes up
unanswered, then five, then fifteen, then every fifteen for as long as it stays up.
It does not give up, since the hand is not going down on its own, and it never gets
faster either.

Three things keep it civil:

- **One toast, however many hands are up.** A floor with six stuck agents gets the
  longest wait named and the rest as a count, not six notifications.
- **Nothing at all while you are looking at the floor.** If the office is the
  focused pane, the hand is already drawn on your screen. The rung is not spent
  either, so looking away with somebody still waiting nudges you then, which is
  when it is useful again. This costs nothing extra: `focused_pane_id` comes with
  the snapshot the office already polls, and `HERDR_PANE_ID` says which pane it is
  in itself.
- **An agent that was already stuck when the office opened is left alone.** The
  roster only knows when a state was entered if it watched it happen, so that
  duration is a floor rather than a fact, and a nudge quoting it would be a lie. It
  becomes real the moment they change state.

`--quiet` turns off the first toast and every nudge after it.

## On the window itself

The office also writes the headline count to the window title, so it is legible
from a tab bar or an alt-tab list with the office pane nowhere on screen: `2
waiting - 3 working - office`. The number you have to act on comes first, because
every window list in every OS truncates from the right. A room with people in it
but nothing happening reads `all quiet`, an empty one reads `nobody in`, and the
whole string is capped at 48 characters.

It is somebody else's window, so: the title only goes out when the string actually
changes, and **it is handed back with `client.window_title.clear` on the way out**,
including on ctrl-c and on a crash. A stale "2 waiting on you" outliving the
process that wrote it would be worse than no title at all. If herdr reports there
is no foreground window to title, nothing is remembered as set, so it goes out
again when a window comes back. `--no-title` switches the whole thing off.

## Pixels, in two places

A terminal cell holds a word, a colour and one of eight block glyphs. That is
enough to say `worked 3h40m - waiting 12m30s`, and not enough to show you that the
waiting was a fifth of the session without you doing the division. So where the
office has a proportion to show, and only there, it draws one in pixels through
`pane.graphics.set` and lets herdr worry about which escape sequence your terminal
speaks.

Two layers, and neither may cover a word. An image occludes the cells underneath it
instead of compositing with them, so a layer only ever lands on cells that were
already blank or already a picture:

- **The whiteboard's bar row** becomes a stacked bar of where the session's time
  actually went, with quarter marks over it. That row already holds the same bar
  drawn in whole cells, so the layer buys resolution rather than information, and
  the two lines of writing above and below it are untouched. The frame and the
  `open since 09:41` title stay in cells, because they are words.
- **The blank row under the header** becomes one tick per desk in the whole
  session, grouped by room, with a raised hand drawn taller. The floor plan pages,
  and until now the only thing saying the other two floors existed was the words
  "keep walking for the rest". This says which of them has somebody waiting.

Nothing in the graphics layer draws text. Words are cells, proportions are pixels,
which keeps every rule the office has about what may reach a screen in exactly one
place.

The first version of the whiteboard layer got this wrong in a way worth recording:
it covered both interior rows, so it deleted `worked 3h40m - waiting 12m30s` in
order to draw a picture of it, and what was left was five colours with nothing to
say which one meant waiting. A chart that costs you the legend explaining it is a
worse whiteboard. Hence the rule above, and hence the coarse cell bar underneath.

It is opt-out rather than opt-in because there is nothing here for a default to
break. The pane is asked once, with `pane.graphics.info`, whether it can draw at
all; a terminal that says no is never asked again and the text renderer is already
correct. An image occludes the cells under it, so the renderer volunteers the
rectangles it is willing to lose and graphics may not touch anything else. A
picture whose numbers moved but whose pixels would not is never sent, because the
floor repaints three times a second and the charts do not. Three failures in a row
switch the whole thing off for the rest of the run, and quitting takes the pixels
down with it. `--no-graphics` is for taste, not for safety: some people want a
terminal to be only text.

## Finding one desk in twenty

`/` opens a filter and the floor simply has fewer people on it: `2 of 20 desks` in
the header, everything else (paging, the compact list, clicking, the counts, `b`)
working exactly as before because it is all downstream of the same list. It is a
filter, not a search: there is no result list and no cursor jumping around.

It matches on names, agent kinds, tab and workspace names, what they are working
on, the command on the monitor, the last news off their wall, and the directory
they are in (the repo name on its own as well as the whole path, since "the desks
in that repo" and "the desks under that tree" are both things people mean).

Status words mean the status, and they include what is actually printed on the
nameplate: `waiting`, `stuck`, `blocked` and `hand` all find raised hands, so do
`needs` and `need you`; `working` and `busy`, `idle` and `quiet`, `done` and
`finished`, `unsure` and `unknown`. Half a word narrows too, so `/wai` is already
on its way there rather than telling you the office is empty. But a complete status
word is exact: typing `done` finds the finished desks and does *not* also drag in
somebody whose tab is called `done-migration`.

Two more rules worth knowing, both of them "it means what it looks like":

- **Every word has to match.** `waiting sso` is the raised hands in the sso tab,
  not the union of the two.
- **Nothing is a pattern.** No regex, no globs, no negation: `.*` finds nobody,
  and it says so. A filter box that quietly means something clever is one you have
  to run experiments against, and this one is for when you are in a hurry.

`enter` keeps the filter and gives the keyboard back to the floor. `esc` shows
everyone again, and while a filter is on that hint gets a high seat in the footer,
because a filtered office looks exactly like an office where everybody went home.
A filter matching nobody says so in as many words rather than falling through to
the empty-office state, and **it never offers you an empty desk to hire into** for
the same reason: a chair that appeared because you typed three letters reads as
somebody having left.

## Following the hands around

`F` turns on shepherd mode, and the office walks you to a hand as it goes up: the
selection is already standing at whoever got stuck, so `y` is live and the card is
theirs. The header says `» following hands` while it is on, because a highlight
that moves on its own is alarming when you do not know why, and this is the kind of
mode you leave on and forget about. `--follow` starts with it on.

Three things it deliberately does not do, which is most of the feature:

- **It moves on a hand going up, not on every poll.** The same hand still being up
  two seconds later is not an event. So if you walk away from somebody, you stay
  walked away; a mode that re-decided where you should be looking twice a second
  would be one you fight rather than use.
- **It never moves you off somebody who needs you.** Standing at a raised hand
  means you are dealing with that person, and the second one can wait as long as it
  takes to press `y`. Use `b` to cycle the rest deliberately.
- **It never touches your real terminal focus.** `f` yanks your foreground pane
  because you asked it to; a background mode doing the same would move your cursor
  out from under your hands while you were typing somewhere else. All shepherd mode
  moves is a highlight inside the office.

It also leaves you alone while a panel has the keyboard (assigning, hiring, a drag
in the air, the filter field), and it respects a filter: it will not walk you to a
desk the filter is hiding.

## How close you want to stand

`z` cycles three zoom levels, and the footer names the next one so a single key
cycling three states is still learnable:

| Level | What you get |
|---|---|
| floor plan | the default: desks, as many as fit, paged. It already drops to the list on its own when the pane is too small to draw a desk |
| list view | one line per agent, forced, even on a pane with room for desks. Everybody at once, which is what you want at twenty agents |
| one desk | the cubicle: the selected desk on its own, with the rest of the office behind it. `hjkl` walks person to person and the note under the desk counts people rather than floors |

The cubicle is not a fourth rendering path, it is the floor plan with room for
exactly one desk on it, which is why the paging, the walking, the walkway and the
furniture all keep working without knowing about it. Ask for one desk on a pane too
small to draw one and you get the list instead, because a zoom level that shows
nothing at all is not a zoom level.

The level is sticky and the header says which one you are in (nothing for the floor
plan, since that is not a mode you chose). `--zoom=list` or `--zoom=cubicle` opens
that way, and an unknown value is the floor plan rather than an error: this is a
wall display as often as it is a tool, and a typo in a plugin action's arguments
should not leave somebody staring at a blank pane.

## Which branch they are on

The bottom line of a desk is "what, and where": the job on the left and the branch
on the right, as `@feature/sso`. It is the other half of the question you have
looking at a floor of agents, because two desks in the same repo, one on `main` and
one on a throwaway, are otherwise identical. The `@` is there so a short branch
cannot be read as the tail of the job.

The branch gives up its space before the job does. On a line with room for only one
of them the job wins and the branch simply is not drawn, because half a branch name
next to half a sentence is two lies where there could have been one truth. Same rule
in the list view, where it takes only what is spare after the ask has its room, and
lands in a column you can read down.

It comes from `worktree.list`, asked per working directory (two desks in one
checkout are one question) and cached for thirty seconds, a couple of directories
per pass. **`trust_repository` is never sent**, the same rule as hiring into a
worktree: prompting somebody to trust a repository is a decision for them to make in
front of the repository, not one a wall display makes on their behalf. An untrusted
repo has no branch on its desks, and that is the right outcome rather than a prompt.

A detached HEAD gets nothing rather than a commit hash: a desk labelled `a3f19c2`
tells you less than a blank one, because at least the blank one does not look like a
branch. A ref name is author-controlled text, so it is put through the same wash as
tab names and terminal titles: one line, no control characters, thirty-two
characters at the outside.

## How much they have changed

The branch says where an agent is working. This says how much it has done there: the
number of things changed in that checkout and not yet committed. It is the question
you are left with once you can see who is busy, because "working for twenty minutes"
means two very different things depending on whether anything came of it. A desk with
nothing uncommitted has been reading; a desk with forty files changed has been busy
in a way somebody is going to have to review.

Three surfaces, one number, sized to the space each one has:

- **A pile of paper on the desk**, clear of the sticky note. One cell for a file or
  two, five for a large change, roughly doubling in between: the difference between one
  file and three is worth a cell, the difference between forty and forty-five is not.
  It grows wider and taller together, `▅▅ ▆▆▆ ▇▇▇▇ █████ ██████`, and that took two
  goes: the first version drew every size in the same glyph the mug and the sticky note
  are drawn in, so the commonest case read as more furniture, and the second made the
  smallest step a single `▁` that on a real floor was a speck nobody could see. The
  scale starts at two cells for that reason. The pile turns the colour of bad news if
  anything in that tree is conflicted.
- **A `+12` badge** next to the branch in the list view, which is the only place the
  actual number is visible without opening anything. Capped at three digits, because
  the branch and the badge share whatever the row has spare and a column that could
  be six digits wide would jump about while you read it.
- **A `changes` row on the card**, in words: `12 uncommitted`, or
  `7 uncommitted · 2 conflicted`, or `nothing uncommitted`, which is said out loud
  because a clean tree is a real answer and often the one you were hoping for.

There is no method for this. `worktree.list` knows a path and a branch and nothing
about the state of the tree, so this is the office's second and last subprocess after
the `ps`: one `git status --porcelain=v1` per checkout, cached against the directory
(two desks in one tree are one question) for fifteen seconds, a couple of directories
per pass. Only in directories `worktree.list` has already called checkouts, which is
not an optimisation but the rule that keeps it contained: the office never runs git
speculatively in a directory a pane happens to be sitting in.

Two guarantees come with running git in a repository somebody's agent is working in,
and `src/dirt.mjs` exists to hold both:

- **It cannot take a lock.** `git status` ordinarily refreshes the index and writes it
  back, which means taking `index.lock`. On a timer, in a checkout where an agent is
  committing, that makes somebody else's commit fail with a message about a lock file
  and the office is the last place anyone would look for the cause.
  `--no-optional-locks` is not optional here, and `core.fsmonitor=false` is the same
  rule one step out: a status in a repo configured for it can start a daemon, and a
  wall display has no business leaving a process behind in your repository.
- **No path ever leaves that file.** Same rule as the process table: what comes out is
  counts. Not a file name, not the first few entries. A repository's file names are as
  private as its contents and this pane gets screen-shared, so the office draws how
  many and the way to see which is the tool that was already going to tell you.

`--no-git` turns it off entirely: no subprocess, no pile, no row, everything else
unchanged. A checkout that will not answer, is not a repository, or is too slow gets
nothing rather than a guess, and that silence is remembered as an answer so the same
directory is not re-asked every couple of seconds for the rest of the afternoon.

## Rooms, one per workspace

A herdr session with three workspaces open is three separate bodies of work, and
the office used to draw them as one undifferentiated floor. The workspace is
already the first thing the seating order sorts by, so desks from the same one are
always next to each other; all that was missing was being able to see where one
group ends and the next begins. So each workspace is a room, and a room is a
colour: the cubicle walls in it are painted a shade of their own, the header names
the rooms in those same colours, the list view carries a stripe of it down the left
margin, and the `where` line on a desk's card is written in it.

It is colour and nothing else. No label rows, no dividers, not one extra cell
anywhere. The floor's geometry decides how many desks fit on a page and where the
walkway goes, and a room heading inserted between two rows of cubicles would have
moved every one of those numbers; a wall painted a different shade cannot wrap a
line. The same tests that prove no row got wider also prove the click map is
identical box for box, which is the version of that claim that matters given some
of those boxes are approve buttons.

There are six wall shades and then it wraps. Every one of them is a permutation of
the same three colour channels, so they all sit at the same brightness and no room
shouts louder than its neighbours. A raised hand still owns the eye in any room:
the wall is the last thing a cubicle's border consults, after the drag, the
selection and the status, so a desk waiting on you is drawn exactly the same in a
painted room as in a plain one. Past six workspaces a shade gets used twice, which
is better than inventing a seventh bright enough to be mistaken for a status.

One workspace gets no colours and no legend, which is the common case: an
explanation that the only room in the office is the room you are in would be noise
on every frame. The colours also come from the whole office rather than from the
desks currently on screen, so putting a filter on narrows who you can see without
repainting the walls behind them.

## What the day actually looked like

Everything else in the office is about right now. The punch clock is the one part
that remembers: how long a desk has been up, how much of that it spent working, and
how much of it it spent waiting on you.

Open a desk's card and there is a `clock` line under its status:

```
status   NEEDS YOU for 4m12s
clock    2h05m on shift · 1h48m working · 14m30s waiting on you · 3 hands
```

The office total goes on a whiteboard on the back wall, in among the plants:

```
┌ open since 09:41 ──────────────────────┐
│ worked 3h40m · waiting 12m30s          │
│ hands 6 · 4 from here · worst 6m20s    │
└────────────────────────────────────────┘
```

`4 from here` is answers this office sent, not prompts that resolved: if you walked
over to the pane and typed `y` yourself, that hand went up and came down without
the office taking any credit for it. `worst` is the longest any one desk sat waiting
on a human, including a wait still going, because the answer to "how bad has it
been" must never be smaller than what is on the screen in front of you.

None of it costs a request. Every number is derived from the status changes the
office was already polling for, and each interval is closed with herdr's own
timestamp for the change that ended it rather than by counting poll ticks, so the
totals come out the same whether the refresh was on time or late. Time belonging to
a desk that has since closed is kept, so the office totals only ever go up: a total
that dropped when somebody tidied up a tab would read as a bug rather than as a
closed tab.

The whiteboard survives a restart, but only until the end of the day. It is written
to one small JSON file in the state directory herdr hands the plugin, so closing the
pane and opening it again at 11:20 continues this morning rather than announcing that
the morning never happened. A file written on another day is thrown away rather than
added to: `open since 09:41` has to mean this morning, and a "today" that quietly
spanned midnight would be a worse lie than a smaller true number.

What never carries over is time nobody watched. The office is shut between a quit and
the next open, so that gap goes in no bucket, and no interval is ever counted from
before the office reopened. The consequence is deliberate and worth stating: the
buckets add up to less than `open since` says, because `open since` is wall clock from
when your day started and the buckets are only ever watched time. A hand that was
already up when you reopened is not counted twice either, since it is the same prompt
still waiting and it was counted before the office shut.

Desk cards do not survive, only the office total. A pane id means nothing after a
restart, so a desk's time is folded into the office numbers and its card starts again:
`on shift 2h` for a desk this office met ninety seconds ago would be the office
claiming to have watched something it did not.

Run outside herdr, with no state directory, nothing is written and the clock simply
starts when you do. That is also true of every way the file can go wrong. An
unreadable, truncated, or half-written file is treated as no file at all, so the worst
a bad state file can do is lose a morning's statistics, never the office.

The whiteboard is furniture, so it hangs there only when the floor has a strip of
wall to spare, and it is the first thing given up when there are more people than
room. That is the right priority: a desk you cannot see is a problem, a statistic
you cannot see is not, and nothing about the office's state is only written on the
wall.

## Moving people around

Desks are laid out in the order the panes really are: workspace, then tab, then
top to bottom and left to right within the tab. So the floor is a picture of your
session rather than an arbitrary list, and **dragging one desk onto another swaps
the two panes for real**. The desk you picked up goes pale, the one you are about
to drop it on lights up, and `esc` or a drop on empty carpet puts it back.

A press only selects. Opening a desk waits for the release, because a press that
turned into a drag was never a request to open anything, and the `[y]` and `[n]`
buttons answer on press and cannot be dragged at all: an approval is the one
irreversible thing on this screen, so it is not also a handle you can pick
somebody's desk up by. Dropping a desk *on* a colleague's `[y]` swaps the two
desks and does not answer for them.

Swapping panes is reversible and closes nothing, so it does not ask first. It
does keep both desks pale until the server confirms, so a swap in flight never
looks like a room that has finished moving.

## Answering from the office

Agents do not agree on what an approval prompt looks like, so the keys are read off
the agent's own screen rather than guessed: a literal `(y/n)` prompt gets a letter, a
numbered menu gets `1` (the plain yes, never the "and stop asking me" variant), and
anything unrecognised falls back to enter and esc. The panel spells out what it is
about to send, so a bad read is something you can see before you press the key rather
than after.

Opening a desk splits the room instead of taking it over: the panel takes the bottom
half and the floor keeps the top, so you can read one agent while watching the rest.
Arrow keys still walk the floor with the panel open, and it follows you.

The `[y]` and `[n]` are real buttons in all three places they appear: on the desk's
monitor, on the card, and now on a list row too. That last one was the gap that
mattered, since the list is what you are looking at when there are twenty agents and
one of them is waiting on you, and until now answering meant walking to the desk
first. They sit in their own right-hand column rather than trailing the question,
because a button that moved with the length of the ask would be a moving target for a
mouse, and on a row that is asking you something they take the column the branch
would have had. On a pane too narrow for them nothing is drawn and nothing is
clickable there: `y` and `n` still work, and a hitbox with no button under it would
be an approval sent from a blank patch of screen.

### When yes and no are not the answer

Plenty of questions are not approvals. "Which of these two approaches do you want" has
no key, and until `s` the only thing to do was press `f` and go and type it yourself,
which is the one thing the office exists to save you. `s` opens a field on the waiting
desk with the question above it, and what you type goes in as keystrokes.

It has to be keystrokes. `agent.prompt` is how `a` and `A` give somebody a job, and
herdr rejects it outright with `agent_blocked` when the agent is waiting on a prompt,
before any input is sent, which is exactly the case here. So an answer goes as one
`pane.send_input` carrying the words and the return key together. One call rather than
two on purpose: two would leave a window where half an answer sits in somebody's input
box waiting for a submit that already failed.

### Allowing it from now on

Some prompts offer a third option: yes, and stop asking. `y` never picks it, and that
is deliberate, because it is a different promise from yes. Yes answers one question.
That answers every question of the same kind from here on, sometimes past the end of
the session, and it is not the office's decision to make quietly.

So it has its own key. `Y` arms it and `enter` grants it, and while it is armed the
footer is down to those two keys and the mouse does nothing, because the `[y]` still
under the pointer would otherwise be a second answer to the same question. It is only
ever offered when that option is genuinely on the agent's screen, and the digit is read
off the menu rather than assumed to be `2`: on a menu that put "no, and tell me what to
do differently" at 2, a hardcoded digit would deny the command under a key labelled
"always allow". Both the digit and the option's own wording are checked again at the
moment you confirm, since the screen belongs to the agent and can change in the seconds
between arming and granting. The card and the footer both quote that wording, so the
sentence you are agreeing to is the agent's own. It is the one answer in the office
with no button, for the same reason the assign field has none.

## Why does it think that

The office asserts a state for every desk, and a state can be wrong. A desk reading
idle while its agent is plainly mid-sentence is not a rare case: detection is a pile
of rules matched against a scrape of a terminal, and rules go stale when an agent
ships a new prompt box. So the card carries herdr's own reasoning, off `agent
explain`, under **why herdr thinks so**: which rule fired, what priority it beat, what
part of the screen it was looking at, how many other rules also recognised that
screen, and which manifest the rules came from. When the answer is "detection was not
running", or "your local manifest is shadowing the published one", or "the manifest is
stale and the update failed", it says that instead, because those are the three ways a
state can be confidently wrong.

It is fetched per card, never for the floor. A single explain is a full rule
evaluation and runs to tens of kilobytes; multiplied by every desk on a poll it would
be the most expensive thing the office does, for a question you only ask about one
agent at a time.

**Every rule in that payload quotes the screen it was matched against, and none of it
is drawn.** The `evidence` blocks are never read at all. Everything that does get
drawn has to be shaped like one of herdr's own identifiers first: a state, a rule id,
a region, a manifest filename, a small integer. Anything longer or stranger is data
wearing an identifier's name and is dropped rather than trimmed, because a trimmed
secret is still a secret with the end cut off. herdr's warnings and fallback reasons
are free text by design, so they are acknowledged and not repeated: the card says a
warning was reported and points at the CLI, which can print the whole thing safely
because it is not on a wall. The manifest is named by basename and version, since
`manifest_source` is an absolute path under your home directory.

The section also yields. It is what you read when you doubt the office, which is never
the same moment as answering somebody, so on a short panel it takes what is left after
the answer keys are accounted for and its lines come out most-explanatory first. The
rule that fired survives the clip; which file the rules came from is what goes.

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
it was entered, so the first sighting of an agent starts the clock.

## How it works

- `agent.list` + `session.snapshot` + `tab.list` build the roster; a 2s poll is the
  floor, and subscriptions make it feel instant. The snapshot's `layouts` are where
  the seating comes from: `panes[].rect` is the real geometry, so the desks are in
  the same order as the panes and a swap is visible instead of being a change you
  have to take on faith.
- Hiring is `server.agent_manifests` for the menu, then `tab.create` and
  `agent.start` into the pane that tab came with (`agent.start` does not make one,
  and it wants a pane sitting at a shell prompt, which a fresh tab is). It runs on
  its own short-lived socket, because requests on the main one are queued and a
  90s start would otherwise stop the clock on the whole office. A worktree hire
  swaps `worktree.create` in for the `tab.create`, since it comes with a workspace,
  a tab and a pane of its own, and deliberately does not send `trust_repository`.
- Assigning work is one `agent.prompt` per recipient, sent one at a time on its own
  short-lived socket for the same reason a hire gets one: the main connection is
  queued, and a broadcast to seven desks would otherwise stop the clock on the whole
  office. One at a time rather than in parallel so a partial failure can be reported
  as "four of five" instead of a single rejected promise.
- Dragging is one `pane.swap` with an explicit source and target. Mouse mode is
  `1002` rather than `1000`, because press-and-release alone cannot tell you where
  a desk went on the way.
- Subscriptions: the global pane/workspace/tab events, plus one
  `pane.agent_status_changed` descriptor per pane (that event is per-pane only, so the
  subscription is rebuilt whenever the set of desks changes).
- News is one `pane.output_matched` descriptor per pane, carrying a single joined
  regex rather than one subscription per phrase, because the whole subscription list
  is rebuilt whenever the roster changes shape and seven phrases per pane would mean
  fifty descriptors on a small session. The pattern is written for Rust's `regex`
  crate, so no lookaround and no backreferences, which is why "a non-zero count of
  failures" is spelled `[1-9]\d*` instead of `(?!0)\d+`. The event's `matched_line`
  only selects a label; see "News from a desk".
- The command on a monitor is one `pane.process_info` per *working* desk, at most
  every 5s and at most four desks per pass. That response is the whole foreground
  process tree, which is about fifteen kilobytes a pane on a real machine, so a busy
  floor is read a few desks at a time rather than all of it every two seconds. Of
  herdr's payload only the process names and argv are looked at, never `cmdline`.
  It is also one `ps -Ao pid=,ppid=,etime=,ucomm=,args=` per pass, shared by every
  desk in that pass rather than run per desk, because the jobs an agent starts are
  not in the pane's foreground process group at all. That is 90ms and 270KB for a
  thousand processes. The name comes from `ucomm` rather than off the front of the
  arguments, which is not fussiness: splitting the arguments made every Kiro desk
  report `Kiro`, off a path with a space in it.
- Uncommitted work is not in the API at all: it is one
  `git --no-optional-locks -c core.fsmonitor=false status --porcelain=v1` per checkout,
  at most every 15s and at most two checkouts per pass, only in directories
  `worktree.list` has already called checkouts, bounded at 1.5s and a megabyte, and
  off entirely under `--no-git`. Counts come back; paths never do. See "How much they
  have changed" for why each of those flags is there.
- The window title is `client.window_title.set`, sent only when the string changes,
  and `client.window_title.clear` on the way out with a 500ms budget: an office that
  would not quit because a title would not clear is worse than a stale title. Note
  that this server returns `changed: true` on every call including a redundant one,
  so the deduplication has to happen on this side; `reason` is the field that means
  anything.
- Speech bubbles cost one `agent.read --source visible` per *stuck* desk, refreshed at
  most every 6s. Nobody else is read until you open their desk, so a quiet office is
  three calls every two seconds no matter how many agents you are running.
- Opening a desk reads `agent.read --source visible`: the current screen, which is
  exactly "what are you up to". For idle and done agents it also tries
  `recent_unwrapped` for more history.
- `agent.explain` supplies the detection reasoning, shelled out through the CLI.
- Answering is one `agent.send_keys`, then a refresh 400ms later because herdr has not
  noticed the prompt is gone yet and the hand would otherwise stay up.
- Whatever room is left under the desks becomes the back wall of the office, and the
  plants, water cooler, printer, whiteboard, sofa and filing cabinets stand against it.
  The layout is deterministic (the same office every time, not a new one every 320ms)
  and it only ever lands on floor the desks are not using, so scenery can never cover a
  raised hand. On a pane too short to leave any room, the furniture is simply not there.

## Hacking on it

```sh
node --test test/*.test.mjs      # the whole suite, no dependencies to install
node office.mjs --demo           # the office, with a fake roster and no server
node office.mjs --once --demo    # one frame to stdout, for diffing the art
./scripts/record-demo.sh         # re-record the README's GIF (needs vhs + ffmpeg)
```

The art is drawn on a fixed cell grid, and the invariant the whole renderer rests on
is that **every line is exactly as many cells wide as the pane and every frame is
exactly as many lines tall**. Frames are written straight to the terminal without
being measured, so one line a single cell too wide wraps and shoves every row below
it down by one, and the screen stays broken until something forces a full redraw.
`test/grid.test.mjs` asserts that invariant over every pane size from 200x60 down to
20x8, every animation frame, and every state the detail panel can be in. It is the
suite that matters most: when it fails, it has usually found a real corruption bug
rather than a changed expectation.

Two rules that are easy to break by accident:

- **Only unambiguous-width glyphs in the art.** Latin-1, box drawing (U+2500 to
  U+257F) and block elements (U+2580 to U+259F). Geometric Shapes start at U+25A0 and
  are off limits, because `▪` is one cell in some terminals and two in others, which
  is unfixable once it is on the grid. `test/sprites.test.mjs` enforces this.
- **`y`, `n`, `s`, `Y` and `a` send real input to real agents.** Never test approve,
  deny, answer, grant or assign against a live office; `--demo` prints what it would
  have sent instead, and `test/office.test.mjs` sends them for real down a socket no
  agent is listening on. `test/summary.test.mjs` covers the prompt reading, including
  the one case that matters most: the "yes, and don't ask again" menu option must
  never be the one `y` picks, and when `Y` does reach it the digit comes off the menu
  rather than from a guess.

One test in the suite talks to the world. `test/protocol.test.mjs` runs `herdr api
schema --json` and holds every request in the source to it: the method names, the
parameters, the event descriptors, the read sources. It exists because most of what
this office can say is only said when somebody presses a key, so a request the server
would reject and a request nobody ever sends look identical from inside a test suite,
and the news labels spent their whole life in exactly that gap. It is also the only
check that covers the paths a test cannot run, since sending `agent.prompt` or
`worktree.create` for real means typing into somebody's live agent and making a branch
in their repository. With no herdr installed those assertions skip rather than pass,
because a machine without herdr genuinely cannot answer the question. What it proves is
spelling and not meaning: conforming to the schema is no evidence that a feature works.

`test/socket.test.mjs` covers the other end of the same gap, and needs no herdr: it
stands up a fake one on a temp socket and holds the client to the wire's actual
manners, including a server that closes after every answer and a server that does not.
It exists because nothing tested the class every call goes through, so a wrong
description of the wire sat in three comments from the first commit until somebody
measured it. The assertion worth keeping is that a request reaches the server exactly
once: a read that is sent twice is waste, but `agent.send_keys` sent twice is two
keystrokes typed at somebody's agent.

`test/office.test.mjs` runs the office itself. It spawns `office.mjs` as a child
process pointed at a fake herdr, types keys on its stdin and reads frames off its
stdout, which works because the office only asks for raw mode when stdin is a tty and
honours `COLUMNS`/`LINES` when stdout is not. Every other test in the suite covers a
function in `src/`; this one covers the seam between the office and the wire, which was
the one place a bug could sit with everything else green, and did. It is also how the
write paths get exercised at all: a fake server can be sent `agent.prompt` and
`agent.send_keys` without a real agent receiving anything, so the tests can assert the
thing that actually matters, which is that a standup reaches each person exactly once
and `y` is one keystroke.

CI runs the suite plus a couple of live `--once` renders on macOS and Linux across
Node 18, 20 and 22. The Herdr marketplace indexes whatever is on the default branch
rather than a release tag, so `main` is what strangers install and it has to stay
green.

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
