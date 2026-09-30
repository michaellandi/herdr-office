# Design notes

Why the office is the way it is, surface by surface.  
Two conventions worth knowing before you start:

- Where a rule belongs to one file, the file's own header comment is the source of
  truth and this document does not repeat it. `src/head.mjs`, `src/dirt.mjs` and
  `src/ps.mjs` are each about half comment by line, and that is deliberate: a
  comment next to the code it explains gets updated when the code changes, and a
  design document does not. What lives here is the reasoning that spans files, or
  that is about the product rather than the implementation.
- Several sections record a first attempt that did not work. Those are the most
  useful paragraphs in the file and they are not tidied away, because the failed
  version is usually the one somebody will independently reinvent.

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

## The office manager

Everything else the office draws is a fact about one desk. The interesting things
about a floor are mostly not: two agents in the same checkout, two hands up on the
identical question, a context window about to be emptied mid-task. The office already
knew every one of those and had never said any of them, and the reason was structural
rather than an oversight. A fact about a pair of desks has no field on anybody's card,
so it had nowhere to go.

`src/notices.mjs` is where they go. It takes the roster the office has just built and
returns sentences, ranked. `src/manager.mjs` decides how a desk says one of them, and
`src/briefing.mjs` turns them back into an account of each desk they are about. The footer
draws the most urgent, a desk on the floor plan draws the same one under a monitor counting
the desks that need somebody, a card briefs every one of those desks in turn ([what
happened at each desk](#what-happened-at-each-desk)), and `m` walks you to the desk each
one is about.

Four notices, and the order between them is an argument about what can still be saved:

| Notice | The claim |
|---|---|
| two desks in one checkout, both moving | work that already exists can be destroyed. Also the cheapest to be sure of: the same cwd is the same checkout, so there is no inference in it |
| a head over 90% and still working | reasoning that exists in exactly one place is about to be compacted away |
| two raised hands asking the same thing | somebody is waiting, and one keystroke could unblock them twice over |
| idle a quarter of an hour with uncommitted files | already happened, and it will keep |

### It reports, and that is a design constraint rather than a first version

The obvious next step from here is a coordinator that acts: notices a collision and
moves somebody, notices a stall and prods it. That version is not this one, and the
first one deliberately cannot become it by accident. `src/notices.mjs`, `src/manager.mjs`,
`src/briefing.mjs` and `src/chief.mjs` have no socket, no clock, no writes and no state
between calls. A thing that cannot do anything is much easier to believe, and the argument
for shipping a manager at all is that the part of it that decides what is true is provably
incapable of managing.

That claim is about those four modules and not about the whole system, and the difference
matters now that a manager can be [hired](#hiring-somebody-to-read-the-floor-for-you). A
hired manager is a real agent session with the same tool access as every desk on the floor,
so the office cannot promise anything about what it does in its own worktree. What it can
promise is narrower and is the half that was ever load-bearing: the reply is not parsed,
matched, dispatched or forwarded, so the worst a wrong answer does is read wrong on a card.
The card says so in as many words, and says something different depending on whether
anybody is hired, because a standing promise that has quietly stopped being true is worse
than no promise.

The same constraint shapes the wording. A notice states a fact and does not give an
instruction: "Ada and Bo are both in herdr-office" is the whole of what the office
knows, where "Ada and Bo are about to clobber each other" is a guess about two agents'
intentions, and two agents deliberately sharing a checkout is a thing people do on
purpose. The reader knows which it is. The office does not, and a warning that is wrong
a third of the time gets ignored the other two thirds.

### The footer, rather than a row of its own

The notice shares the message slot, and loses to anything already in it. A message is
the answer to a key you pressed a second ago and it lasts four seconds; a notice was
true before you touched anything and will still be true afterwards. So a keystroke's
receipt is never buried under a standing fact, and the fact comes back on its own once
the receipt has been read.

A row of its own was the first idea and it was worse in four places at once: the frame
budgets rows through `CHROME_ROWS`, the graphics strip is pinned at `y:1`, `tile()` is
the most grid-sensitive function in the renderer, and the footer is the one row where a
single extra cell wraps the whole screen. The message slot already had the right
properties: right-aligned, painted amber, room reserved before the key hints fill the
row, and it already carried the office's own words rather than anybody's screen text.

### Three things that had to be got right to keep it quiet

A notice that fires when it should not is worse than a missing feature, because the
entire value of the line is that a sentence on it means something is true.

- **A desk with no working directory is not in a collision with every other one.** A
  server that reports no cwd hands every desk the empty string, and grouping on that
  announces a twelve-way collision in a directory it cannot name. Which is what most
  of a floor looks like when `worktree.list` is unavailable.
- **An empty ask is "not read yet", not "asking nothing".** Grouping on it would pair
  every freshly blocked desk with every other one. Two asks count as the same question
  when they differ only in case, spacing or a trailing full stop, because they come off
  two different screens and a prompt rendered two cells narrower is the same prompt.
- **Neither half of a stall means anything alone.** An idle agent has usually just
  finished, and uncommitted files are what a working agent looks like from outside.
- **Several desks parked in one checkout are one stall, not one each.** Found on a real
  floor rather than reasoned about: six agents living in one repository, four of them
  idle, ten uncommitted files. Reported per desk that was four lines each claiming ten
  uncommitted files, which reads as forty, and it was permanent, because `dirt` is keyed
  by directory and several agents sharing a checkout is the ordinary case rather than the
  exception. Four reports of one fact is the noise this whole section is about. The group
  line drops the duration the single line carries, since the threshold already claims it
  has been a while and each desk's real clock is on the card `m` walks you to.

One rule is relaxed on purpose. A `statusMs` the office is only guessing at is barred
from the escalation ladder but allowed here, because an assumed duration is a *lower*
bound: a desk that crosses fifteen minutes on a guess has genuinely been idle at least
that long. The guess can make this notice late. It cannot make it wrong.

A working directory is an absolute path under somebody's home, and this pane gets
screen-shared, so only the last segment is ever drawn. It is also the one string in a
notice that arrives unsanitized, since the roster only cleans titles, so it is cleaned
and truncated here rather than trusted.

### Why `m` goes to the notice before it goes past it

The key is a cursor into a list that is rebuilt from scratch every frame, and there is
nothing stable in it to hold on to: two desks sharing a checkout stop sharing it the
moment one of them finishes, and that notice does not become a different notice, it
stops existing. So the office keeps an index and the renderer clamps it.

Pressing `m` takes you to the notice already on the footer, and only advances once you
are standing there. Advancing first was the obvious implementation and it means the
notice on screen when you reached for the key is the one notice the key never shows
you.

### A desk, because correct and invisible reads as broken

The first version of this only spoke on the footer, and only when it had something to
say. On a floor where nothing was wrong it drew nothing at all, which is the correct
behaviour and was indistinguishable, to the person who had asked for it, from a feature
that had never been built. The report was accurate and the product was broken.

So the manager sits at a desk, drawn like everybody else, calm when there is nothing to
report. `WATCHING` and "nothing needs you right now" is a worse use of a tile than a
sentence about a real problem, and a better one than an empty chair, because it answers
the question a reader actually has, which is not "what is wrong" but "is this thing
running".

It costs a desk. Floor one holds one fewer person and everybody after them moves along
one, which is why the desk stands down in three cases where the cost is not worth paying:
under a filter, because its notices are about the whole office and a filtered view is
not the whole office; in the cubicle, where taking the only desk would mean a floor to
itself; and on an empty floor, where the screen already has exactly one useful thing to
say and it is how to hire somebody.

Nothing behind it. The id is `+manager`, which no real pane can collide with because
herdr pane ids are `workspace:pane`, and `src/manager.mjs` is a pure function from a list
of sentences to strings with no callable on the object it returns. The desk is drawn in
the middle of the grid and still cannot reach an agent: `y`, `n`, `s` and `f` all
refuse there and say which desk this is rather than swallowing the key. `a` refuses too
until somebody is hired, and then means "ask it something" rather than "give it a job",
which is the one key on this desk that changed meaning. Fixing that
turned up the same bug one keystroke smaller at the empty desk, where those keys had been
returning silently.

### Why a desk stopped

"Dev stopped 16m02s ago with 7 files uncommitted" says a desk has a problem and nothing
whatever about what it is, so the only use for it was to go and read the pane, which is
what you were doing before the office had a manager. The answer was already on the wire:
the office reads every desk's visible screen on a rotation for the context gauge, and
threw the text away for everybody who was not blocked.

Two answers, in the order of how much the office owns them. A conflicted tree is the
office's own fact, read out of git by the same pass that counted the files, and it is the
most common reason an agent gives up mid-task. Failing that, the last line that desk was
seen saying, quoted and attributed. Never rewritten into a cause: `said "3 tests failed"`
is a fact about a screen, where "it stopped because the tests failed" is a guess about an
agent's reasoning, and the first rule of this whole feature is that the office does not
make those.

Quoting screen text here is a deliberate exception to the rule that keeps it off the
same-ask line. There, the question is already drawn in full in both bubbles, so repeating
it spends the one row on nothing. Here there is no bubble at all: an idle desk's monitor
says `ALL DONE`, which is the office agreeing it has stopped and saying nothing about
why. The sentence is the only place the answer can go.

The reason rides alongside the sentence rather than inside it, as its own field on the
notice, because the surfaces that draw it have four different amounts of room and a
reason appended to the text would be the first thing truncated away, which would mean the
new information is exactly the information nobody sees. Each surface spends its own room:

| Where | What it does with a reason |
|---|---|
| the card | no longer prints the notice's reason at all, because the card stopped being a list of notices. It draws a desk's own words as the last clause of that desk's account, so the reason is per desk rather than per notice. See [what happened at each desk](#what-happened-at-each-desk) |
| the compact list row | appends it, with the whole pane width to spend |
| the footer | appends it when the whole of it fits in the message slot |
| the tile's status bar | 27 cells, so it keeps the fact and drops the reason. The chip already counts and the monitor already says what kind, so on a tile the fact is stated three times over while the reason needs a full sentence or none |

Printed whole or not at all, everywhere. Half a quote is the office putting somebody
else's words in its mouth and cutting them off mid-sentence, which is worse than the line
it replaced. The bug that rule exists to catch was found by a test sweeping every pane
size: the compact row asked for its sentence at the pane's full width and then cut the
row down to fit, which is precisely the failure being forbidden, so the row now asks for
the sentence at the width it is about to be drawn in.

The quote is capped at 36 cells, which is a number chosen against a pane rather than
rounded. At 44 a stall line plus `said "..."` came to 106 cells, and since every surface
prints a reason whole or not at all, that meant an ordinary 110 column pane showed the
reason nowhere but the card. The cap decides how wide a pane has to be before the feature
exists at all.

A quote belongs to the turn it was read in, so a change of state drops it. Carrying it
across makes it the last thing the agent said *before this task*, which is not what any
sentence built on it claims. A screen with nothing quotable on it is recorded as an
answer rather than skipped, the same way a null context reading is, because the only
other thing that ever overwrites a quote is another quote, and a desk would otherwise
keep citing a sentence it read twenty minutes and three tasks ago.

### What happened at each desk

The reason above fixed the wrong half of the problem, and the complaint that said so is
worth quoting because it is the whole brief for what replaced it: the point of a chief of
staff is to get the details without visiting each agent, and what the office actually gave
was one ambiguous line about one agent while three were stuck.

It was worse than that on inspection. Three desks stopped in one checkout produced one
notice, a chip saying `1 THING`, a tile line truncated to `Ada, Bo and Cass stopped i…`,
and Bo's and Cass's own words read off their screens and thrown away. Every fact needed to
explain all three was already in the roster.

The cause was a grouping that is right about one thing and wrong about another. Several
desks parked in one checkout are one notice, because four reports of one directory's file
count read as four times the work, and that is genuinely the directory's single fact. The
reasons are not: each agent's last words belong to that agent. So the count and the
sentence were grouped together when only the count should have been.

What the card draws when nobody is summarising for it is one short account per desk, with the
notice it came from as the account's first line:

```
├─ what happened at each desk ──────────────────────────────────────────────┤
│   Ada · stopped 30m00s ago                                                │
│      was doing "apply the security patch" · on a-manager-who-notices …    │
│      tests failed 24m20s ago · 7 uncommitted · said "I cannot apply the…" │
│   Bo · stopped 40m00s ago                                                 │
│      was doing "rewrite the auth guard" · merge conflict 5m20s ago        │
│      7 uncommitted · 3 conflicted · said "Should I delete the old migra…" │
├─ what to do about it ─────────────────────────────────────────────────────┤
│   m walks to the desk each one is about                                   │
```

Nothing here is written by a model. It is a digest of structured facts the office already
holds, assembled in a fixed order, which is what makes it free and what keeps it inside
the first rule of the feature. `was doing X · tests failed 24m ago · 7 uncommitted · said
Y` is four things that are true; "gave up because the tests failed" would be a guess about
an agent's reasoning. The order of the clauses is the nearest thing to a narrative and it
is only an order. Whoever reads it draws the conclusion, which is the right way round,
because they know things about this work that the office does not. A summary in the sense
of prose written about the desk would need the manager to be a real hired agent with real
tokens, which is a different and much larger question.

It is also a question that has since been answered, which moved these accounts. They are no
longer the card's normal content: a manager is hired when the card opens, and its points are
what the card draws. The accounts are what it falls back to when there is no summary, and
they are one keystroke away the rest of the time. Nothing in this section changed except when
it is reached, and the reason it is worth keeping is in [Hiring somebody to read the floor for
you](#hiring-somebody-to-read-the-floor-for-you): fourteen accounts under a summary of
fourteen accounts is the complaint at the top of this chapter with a paragraph in front of
it, but a card with neither is worse than either.

Five decisions inside it, each of which was a bug first:

- **The chip counts desks, not notices.** `deskCount` is a set of every id every notice
  mentions, so three agents stuck in one checkout is `3 DESKS`. One is the number of
  sentences the office has to say and three is the number of people who need somebody, and
  nobody has ever wanted the first number. A set rather than a list because a desk can be
  in two notices at once, and `2 DESKS` for one person is the same lie the other way.
- **A desk appears once and says both its reasons.** The commonest pair on a real floor is
  a full head in a shared checkout. The more urgent notice is the headline and the other
  joins the front of the account, rather than two blocks under one name repeating the same
  four facts.
- **There are no numbers on the list.** Numbers were the only handle the notice list had,
  and a desk has a name. Once desks rather than notices are the unit, a number beside a
  desk can only be the index of the notice it was filed under, which skips whenever two
  notices are about one desk, and a list jumping from 2 to 4 is a reader hunting for the
  missing one.
- **News outlives the slab it was drawn on.** `tests failed 24m ago` over a desk stopped
  for half an hour is most of the answer, and it used to be deleted twelve seconds after
  it arrived because the only surface that drew it was the slab over the desk. The roster
  now fades the entry instead of dropping it and reports whether anything changed, so a
  card can ask what last happened here without repainting the office twice a second. The
  pane going away is what clears it, otherwise a reused pane id would inherit the previous
  agent's failing test run as its own history.
- **The accounts outrank the hint.** The rows held back for `what to do about it` were two
  rows of chrome naming a key that is in the README, on the footer, and that you pressed
  to get here. On a 110 column pane they are a whole desk's account. Only the closing
  border is reserved now, the hint draws whenever the desks leave room for it, and the
  rule and the line under it are drawn together or not at all, since a section heading
  with nothing beneath it reads as the office having lost the answer.

Clipping is where a card like this usually goes wrong, so the order it gives things up in
is deliberate. A desk's facts are atomic and its headline is not: a desk showing a name
and a headline is the old card, which was worth something, whereas a desk showing two of
its four facts is the office looking like it does not know the other two. When one row is
needed for `and 2 more desks` it comes off the last desk shown rather than by planning the
list again one row shorter, because re-planning made every desk give up its detail to pay
for the overflow line, turning three accounts and a name into four names.

The quote cap here is 44 rather than the 36 a notice gets, and the difference is about room
and not about caution: a notice shares one status line with a whole sentence, while a
clause here gets a panel row to itself. 44 is what a screen is already quoted at on the
detail card, so a desk's own words are the same length wherever you read them.

One consequence worth stating rather than discovering: the panel still takes half the room
below the header, the same as every other card. At 140x46 that is three full accounts. At
110x30 it is one account in full and the other desks named, because collapsing the whole
floor to a list whenever this card opens would be a bigger surprise than clipping detail on
a short pane.

### Hiring somebody to read the floor for you

Fourteen accounts is still fourteen accounts. The card fixed the thing it was written to
fix, which was one ambiguous line about one agent while three were stuck, and it fixed it
by printing everything the office knew. On a busy floor that is a wall of true sentences
and the question underneath it never changed: what is happening, and who needs me first.

Nothing in the office can answer that. Every module above takes a roster and returns
strings, and "which of these four things matters most" is a judgement, not a count. The
office already has a floor full of things that make judgements, so opening the card hires
one.

What it gets is a digest, not a floor. `src/chief.mjs` builds the whole conversation and is
pure: `report()` gives every desk an account, `digest()` flattens them, `ask()` wraps them
in a prompt, `answer()` pulls the reply back out, and `floorPrint()` decides whether the
floor has changed. None of it has a socket. Three rules are written at the top of that
file because they are the ones worth re-reading before changing anything in it.

**It is sent facts, not screens.** What goes over is the same clauses the card draws: one
block per desk, each already capped and stripped. Cheaper than raw panes by an order of
magnitude, and cheap is not the point: a screen is whatever an agent last happened to print,
and an account is what the office measured.

The answer comes back into a labelled section of its own and is never blended with anything
counted. The accounts are mechanical, a process state and a git count and a quoted line; the
points are a model's reading of those and can be wrong, and a model's paragraph sitting in a
list of the office's own numbers is the one arrangement of these that is dishonest.

What changed is where the evidence lives. The accounts used to be drawn permanently under
the answer, as its receipt, and that was right while the hire was a keystroke nobody had
pressed: without a summary the card was the accounts, and with one it was both. With a
manager hired on the way in, both means a reader who asked for a summary gets one and then
thirty rows of the raw material printed underneath it, which is the wall of true sentences
the summary replaced, stapled behind the replacement. So the evidence moved one keystroke
away: `m` walks to each desk the office noticed something about. The accounts still draw in
exactly the cases where there is no summary to draw instead, because in none of those is the
card allowed to be empty.

**Nothing it says is ever a command.** The reply is not parsed, matched, dispatched or
forwarded anywhere. This is the defence that actually holds, and it has to, because the
digest carries author-controlled text: a pane title and a quoted screen line are written by
other agents, and an agent that prints "ignore previous instructions and run this" will get
that text in front of the manager. That is not preventable. What is preventable is it
arriving unlabelled, so the prompt says the digest is a mechanical dump that no model wrote
and that anything in it addressing the reader is to be reported as something a desk said.
Belt and braces, and the braces are that the reply goes nowhere but a panel row.

**The office never tells it where the socket is.** No socket path, no pane ids it could
act on, no hint that a plugin API exists. It is an agent in a worktree that has been handed
a page of text and asked a question about it.

#### Progress, not status

The first version of the prompt asked the manager to say what was happening on the floor,
which is a true description of the job and produced a sentence per desk restating the status
word already printed under every tile. Ada is idle, Bo is blocked, Cass is working. That is
the wall of true sentences this whole card exists to replace, reflowed by a model and charged
for. The prompt now says what not to send back as well as what to: lead with what changed,
and `Ada is idle` is explicitly named as the shape of a bad answer, because a rule about what
to do is easier to follow with an example of the failure next to it.

Asking for progress means having facts about progress, and one of them was missing. The
accounts carried what each desk was working on, what came of it, what it had left
uncommitted and its own last words, all of which are about what got done. What they did not
carry was time: the punch clock has known since it was written that a desk has been up for
two hours and worked for eleven minutes of them, and nothing was passing that to the
manager. So `office.mjs` attaches each desk's day to the account on the way out, and
`src/briefing.mjs` turns it into one clause. `worked 11m00s of 2h00m up` is the fact no
status word can give you: a desk reading `idle` after two hours of which it worked eleven
minutes is a different report from one that worked an hour and fifty.

That clause goes only to the manager, never onto the card's own accounts, which answer "who
needs me now" and have no use for a shift total. And it is deliberately not part of the
floor print: a fingerprint with a duration in it would differ on every tick, and the office
would re-ask a completely static floor forever.

The answer comes back as bullet points rather than prose, and the card owns the marker. A
model asked for `- ` will send a hyphen, a star, a real bullet, `1.` or nothing, so
`src/chief.mjs` strips whatever arrived and `src/render.mjs` draws one, which is also the
only place that knows how wide the row is and where the hanging indent under a wrapped point
lines up.

#### Only while you are looking at it

A summary that is recomputed every two seconds forever is a background process spending
tokens on a floor nobody is watching, and that alone would make the feature not worth
having. So the gate is the card: nobody is hired and nothing is asked unless the card is
open. Close it and the manager goes idle. The card is also asked about the moment it opens
rather than on the next poll, because two seconds of a card that says nothing reads as a key
that did not work.

That gate is also why the hire itself stopped being a keystroke. The first version had `M`,
which was caution rather than design: starting an agent without being asked to felt like
something the office should not do. But the gate it was guarding is the card, and somebody
opening a card whose entire job is to hold a summary is somebody asking for the summary. A
key between them and it is a question with one answer, and the second half of that answer,
which kind, is a choice that does not matter for a job that is reading a page of text and
writing a short list. So it is made from the floor: whichever kind you already have the
most of, which is the one you are logged into and have already paid for, ties broken by the
sorted manifest list so the same floor picks the same manager twice.

`M` stays, for the two cases the automatic path cannot serve: wanting a specific kind, and
wanting the manager in a worktree. `--no-manager` turns the automatic path off entirely.

One hire per run, win or lose, and that is one flag rather than a check on whether anybody
is currently hired, because three different things all mean do not hire again. A hire that
failed must not be retried on every card open, or looking at the card twice starts two
panes. A manager fired with `X` is the clearest possible statement that you do not want one.
A manager whose tab you closed is the same statement, made less deliberately. Restarting the
office is how you change your mind, which is a cheap enough way to say it.

Three more brakes on top of that:

- **Never faster than twenty seconds**, whatever the poll does.
- **Never twice about a floor that has not changed.** `floorPrint()` is the fingerprint,
  and what it deliberately leaves out is the whole cost control. Durations are excluded:
  a fingerprint over the rendered accounts differs every second, because `idle for 30m00s`
  becomes `30m01s`, and the office would re-ask forever. A context percentage is excluded
  for the same reason and replaced by its bucket. The clock only enters where crossing a
  line is itself the news, which it does twice: a stall becoming a notice changes which
  desks have a `kind`, and a head going from hot to brimming changes the bucket. Notice
  *wording* is excluded too and only the kind is kept, since a sentence that renames the
  same fact is not new information.
- **Skipped rather than queued** while the manager is mid-turn. A queue here would mean a
  manager permanently one floor behind, answering about a floor that has moved on.

The ask is fire-and-forget. `agent.prompt` takes an optional `wait` and the office has
never set it, so this needed no new primitive: the prompt goes out on its own connection
and the reply is collected by polling the manager's pane like any other desk.

#### Finding the answer on a screen full of prompt

The reply comes back by reading the manager's pane, which contains the echoed prompt above
it, and both copies contain the markers. So the manager is asked to wrap its whole reply
between two lines carrying a random three-byte nonce, and the office takes the *last*
opening marker before looking for a close. A fixed marker would match the prompt's own copy
and the office would read its own question back as an answer.

The nonce does a second job that matters more. `[[END office]]` is a thing an agent could
plausibly print while describing this very feature, and a desk's screen text is quoted into
the digest, which is drawn on the manager's own pane. A fixed marker pair would let a desk
hand the office a block of text that reads as a summary of the floor. A per-ask nonce turns
that from something that happens by accident into something that has to be guessed right
first time. It is in both markers, not just the closer, because the manager echoes the real
pair and a forger only has to supply the other end.

The pane is read as `recent_unwrapped` at 200 lines rather than `visible`. On a short pane
the opening marker scrolls off while the closing one is still on screen, and an answer whose
front is missing is not an answer. A reply with no close marker yet is a manager still
typing, so the office waits; past two minutes it writes the ask off and says so on the card,
because a card that looks identical whether the answer is coming or gone is the failure that
made the first footer-only manager feel broken.

#### It is not on its own floor

One predicate, `notChief`, and four places that go through it: the digest, the notices in
the view, the `A` broadcast, and by extension the desk `m` walks to. Without the notices
exclusion a manager sitting idle crosses the stall threshold in fifteen minutes, becomes a
notice, and then reads about itself in its own next digest, which is both funny and a bug.

Where it sits is the other half of that. This is the one agent on the floor that is handed
text written by other agents, so if a prompt injection ever does land, what it can reach
matters. `M` defaults into a worktree for that reason and `t` still switches it back: a
throwaway branch is a much smaller answer than the checkout everybody else is working in.

Hiring under the hood goes further and uses neither. A manager never reads code, so the
smallest thing that will hold one is an empty directory, and it gets one fixed path under
the system temp directory. That is a smaller blast radius than the worktree it replaced,
because a worktree is a real checkout with real history and this is a directory with nothing
in it at all. It is also the tidier answer to a hire that now happens on every office run
that opens the card: a fresh worktree each time would leave a pile of `office/` branches to
clean up, which is a different flavour of the annoyance this was meant to remove. The office
never writes there, and never sends `trust_repository`, either here or from `M`.

The cost of that choice is honest and is written down in the README: an agent CLI that
refuses to take a prompt outside a trusted repository will sit in that directory saying
nothing, and the card will say it is waiting. `M` and a worktree is the way out.

What it costs to give up is the last piece. `X` forgets the manager and touches nothing
else: the pane, the tab and the worktree are left exactly as they are, still running, for
somebody to look at or close by hand. The office started an agent, so it says where it is
and stops there. Closing panes on somebody's behalf is a different feature with a different
argument behind it.


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

## How full their head is

Uncommitted work is how much an agent has done. This is how much room it has left to do
any more in. A context window fills up all afternoon and then compacts, and a compaction
is the moment an agent stops being the thing you briefed: it keeps a summary and loses
the details, so the careful instruction you gave it two hours ago is now a sentence
somebody paraphrased. The tell is always the same afterwards, and it is always noticed
too late. An agent at ninety per cent is one you want to catch before it turns over, by
letting it finish, by asking for the commit now, or by writing down the part of the brief
you would hate to lose.

The number is the message and the colour is the alarm. That split is the second attempt:
the first version let the bands govern everything and drew nothing at all below fifty per
cent, on the reasoning that there is nothing to do about thirty and a gauge on every desk
would be furniture within a day. Run against a real floor of four desks, that came to one
tinted frame two shades of dim apart from its neighbours and no number anywhere. It was a
feature you had to be told was there in order to see it. The reasoning was right about
noise and wrong about where noise comes from: a number written into a line that was
already being drawn adds no cell and no colour, and reading it is optional in a way a
coloured frame is not.

So:

- **The monitor's top edge carries the number**, `┌─ 73% ──────┐` in place of
  `┌────────────┐`. That edge is the only surface on a desk that was being drawn and
  saying nothing: the desk row is a sticky note, a pile of paper, a keyboard and a mug,
  and the wall above it is a tab card and a speech bubble. Writing into it costs no cell
  and leaves the desk the width it was, which is asserted rather than assumed because that
  frame is load bearing for every desk to its right.
- **A bare edge means nobody has looked yet**, which is the one thing worth keeping in the
  shape rather than the colour. Under the old rule an unread desk and a desk with plenty of
  room were identical on screen.
- **The frame changes colour** at fifty, through rust to burnt orange, gaining lightness as
  well as saturation at each step. The frame and not the glass, because the glass is
  already what they are doing and the two facts have to stay separable. Under the raised
  hand's amber at every band, which is the constraint that actually matters.
- **A heavier edge**, `┏━ 93% ━━━━━┓`, above ninety, so the band where being able to see it
  matters most does not depend on colour at all.
- **A `76%` chip** next to the branch in the list view, dropped when the row needs the
  space for somebody's raised hand instead. That is a decision about space, not about
  whether the number was worth saying.
- **A `context` row on the card**, in words, with the advice attached where there is any:
  `65% full`, `81% full · not much room left`, `93% full · about to compact`. Plus a
  `model` row, because which model is in that window is the other half of what the number
  means, and it is on the same line of the same screen.
- **`compacted` on the wall** when a window empties: news, in the same place as tests
  passing and a commit landing, because it happened rather than being the case.

There is no method for this either. `agent.list` carries a `tokens` field and on every
live agent tested it was `undefined`, so the gauge is read where a human reads it: off the
agent's own status line, on its own screen. Two families print one, `Context: 65%` in
words and `◑ 58%` as a moon that fills up, and the number in both means used and not left
(which is worth stating, because getting it backwards draws a fresh desk as a full one).
It is one `agent.read --source visible` per desk, at most every 10s, four desks per pass,
and it shares the read with the speech bubbles rather than asking twice.

Two rules come with reading a screen nobody wrote for you, and `src/head.mjs` exists to
hold both:

- **Nothing but a number and a model name ever leaves that file.** A real status line is
  whatever that agent felt like telling its owner, and on the machine this was built on
  that included an auth countdown; elsewhere it is a spend figure, a branch, an absolute
  path. The office draws two fields off it and the test for that asserts against the
  parser's entire output rather than the fields it is known to have.
- Only an anchored shape counts. A bare `94%` on a line is test coverage, a download, a
  similarity index, and a gauge that read any of those would be a desk reporting somebody
  else's number as the truth about an agent.

`--no-context` turns it off entirely: no read, no colour, no chip, no row. It is the one
feature that looks at every desk rather than only the ones with a hand up, which is
exactly why it has an opt-out. An open card still quotes the screen back, because that is
a read you asked for by opening it.

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

Punch clock desk cards do not survive, only the office total. A pane id means nothing
after a restart, so a desk's watched time is folded into the office numbers and its card
starts again: `on shift 2h` for a desk this office met ninety seconds ago would be the
office claiming to have watched something it did not.

### The day book

One thing about a desk does survive, and it is the number most likely to make somebody
get up: how long it has been in the state it is in. Reopening the office used to draw an
agent that had been stuck since breakfast as stuck for one second, which is wrong in the
direction that matters, because a one-second wait is the one you leave alone.

So each desk's clock goes into the same file, and what makes keeping it honest possible
is `state_change_seq`. Herdr moves that number every time it changes a desk's state, so
the number written down before the office shut is proof of a negative: nothing happened
to this desk while nobody was looking, and the clock saved beside it is still running on
the very interval it was running on. A different number is proof of a transition the
office missed. A missing number is proof of nothing.

Only the first of those three is believed. The other two get exactly what a desk the
office has never met gets, which is a clock starting now and a `~` admitting it, and
they do not count as a newly raised hand either, since nobody can say whether that hand
went up once or four times while the pane was shut. A clock that was already a guess
stays a guess: keeping a duration makes it survive, not makes it true. And a line with no
sequence number is never written down in the first place, because it could never be
confirmed, so keeping it would buy precisely what leaving it out buys, one poll later.

The punch clock's clamp still applies, so the two numbers on one card can now disagree on
purpose. A desk can say `NEEDS YOU for 2h` while its clock line says twenty minutes of
waiting: the first is how long the state has been held, which herdr has just proved, and
the second is how much of that the office was open for. They answer different questions,
and each gets the answer that inflates neither.

On the first poll after reopening, the office says what it missed, on the message line:

```
shut for 41m: 2 of 4 moved, 1 gone
```

The denominator is the desks the book had that are still on the floor rather than
everything it had, because "2 of 5 moved" about a book with two desks left in it invites
the reading that three of them are fine. `nothing moved` is the other half of the same
sentence rather than the absence of news, since it says every duration on the floor is
real. The point of the line is less the gossip than which clocks can be trusted, because
a `~` on a desk that was plainly here this morning is otherwise unexplained.

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

Workspace and tab come from where each one sits in its bar, which is not the same
thing as the number it answers to. Tabs and workspaces can both be dragged to a new
position (`tab.move` and `workspace.move`, each taking an `insert_index`) and
neither renumbers when that happens: the number is a stable shortcut baked into the
id, so a tab created fourteenth is still 14 after it moves to the front. The office
originally seated desks by that number, which looked correct because the two agree
until the first time anything is moved, and then drew the office in creation order
forever after. The position in the list is the thing that matches the bar, so that
is what seats a desk. An empty tab list is not an order but a missing answer, and it
leaves the last known positions alone rather than flattening every tab onto one rank.

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
  most every 6s. A quiet office is three calls every two seconds no matter how many
  agents you are running.
- The context gauge is the same call on desks that are not stuck, at most every 10s and
  at most four desks per pass, stalest first, and off entirely under `--no-context`. The
  two share one read: a desk with its hand up is already being looked at, and the
  four-desk budget counts only the desks that would not have been read anyway. Two fields
  come back off that screen and nothing else does. See "How full their head is".
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


## The test suite

The art is drawn on a fixed cell grid, and the invariant the whole renderer rests on
is that **every line is exactly as many cells wide as the pane and every frame is
exactly as many lines tall**. Frames are written straight to the terminal without
being measured, so one line a single cell too wide wraps and shoves every row below
it down by one, and the screen stays broken until something forces a full redraw.
`test/grid.test.mjs` asserts that invariant over every pane size from 200x60 down to
20x8, every animation frame, and every state the detail panel can be in. It is the
suite that matters most: when it fails, it has usually found a real corruption bug
rather than a changed expectation.

`test/sprites.test.mjs` enforces the glyph rule the README states: Latin-1, box
drawing and block elements only, because an ambiguous-width glyph is unfixable once
it is on the grid.

`test/summary.test.mjs` covers the prompt reading, including the one case that matters
most: the "yes, and don't ask again" menu option must never be the one `y` picks, and
when `Y` does reach it the digit comes off the menu rather than from a guess.

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

A separate job installs herdr itself and runs the protocol suite against it with
`HERDR_REQUIRED=1`, which turns the skip into a failure. Without that, the one suite
that checks the wire contributed nothing to CI while looking exactly like a suite that
passed, and the gap it was written to close is the gap it was falling through. It runs
against two versions: the oldest herdr the README promises, which catches a request
that needs a newer server than we claim to support, and the current stable one, which
catches the wire moving underneath us. Neither needs a running session, because `api
schema` prints the schema the binary was built with.
