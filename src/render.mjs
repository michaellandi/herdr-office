// Drawing the office. Pure functions: given a view model, return the screen as
// an array of lines plus the hitboxes needed for mouse clicks and arrow-key
// navigation. Nothing here talks to a socket or a terminal.
import { padEnd, truncate, width, formatDuration } from './text.mjs';
import { P, STATUS, paint, fill, status, identity, eventTint } from './theme.mjs';
import { wrapField, describeTargets } from './compose.mjs';
import { terms } from './filter.mjs';
import { roomWall, roomOf, roomsShown } from './rooms.mjs';
// Shared with the pixel chart that covers the bar row, so the coarse bar and the fine
// one divide the same numbers the same way and cannot disagree about which slice won a
// rounding contest.
import { allot } from './charts.mjs';
import {
  pose,
  screen,
  SCREENS,
  PROPS,
  VACANT_CHAIR,
  VACANT_SCREEN,
  runningScreen,
  POSE_W,
  SCREEN_W,
  MON_W,
  ART_ROWS,
  HAIR_FROM,
  HAIR_TO,
} from './sprites.mjs';

// A cubicle. Two cells of wall between the border and anything written on it,
// and one cell of desk between a person and their monitor: a card packed to its
// own edges reads as cramped, and the whole point of drawing an office instead
// of printing a table is that it should not.
const GUTTER = 2;
const MON_X = POSE_W + 1; // where the monitor starts on an art row
const INNER = MON_X + MON_W; // 27: person, elbow room, monitor
export const TILE_W = INNER + GUTTER * 2 + 2; // 33: plus both borders
export const TILE_H = 16;
const GAP_X = 1; // carpet showing between cubicles
const GAP_Y = 1;
const CHROME_ROWS = 4; // header bar + spacer, spacer + key bar

// The empty desk stands where a pane id would, so walking the floor and clicking
// reach it with no special case. It cannot collide with a real pane id: herdr
// pane ids are `<workspace>:<pane>`, and none of them start with a plus.
export const HIRE_ID = '+hire';

const PHRASE = { blocked: 'need you', working: 'working', done: 'done', idle: 'idle', unknown: 'unsure' };
const ORDER = ['blocked', 'working', 'done', 'idle', 'unknown'];

/* ------------------------------------------------------------ tiny builders */

// Accumulates a row of text plus the colour spans over it. Spans are indexed by
// code point; display width is tracked separately so padding stays cell-exact
// even when a pane title drags in a double-width glyph.
function cells() {
  let text = '';
  let n = 0;
  let w = 0;
  const spans = [];
  return {
    add(str, style) {
      const s = String(str);
      const len = [...s].length;
      if (!len) return this;
      if (style) spans.push({ from: n, to: n + len, ...style });
      text += s;
      n += len;
      w += width(s);
      return this;
    },
    gap(to) {
      return this.add(' '.repeat(Math.max(0, to - w)));
    },
    get w() {
      return w;
    },
    out() {
      return { text, spans };
    },
    // Exactly `max` display cells, whatever was added. The repaint in office.mjs
    // diffs whole lines against the terminal width, so a row that overshoots
    // wraps and corrupts every line under it: this is the backstop that stops a
    // long title or a 40-column terminal from doing that.
    fit(max) {
      if (w === max) return { text, spans };
      if (w < max) return { text: text + ' '.repeat(max - w), spans };
      const chars = [...text];
      let cut = 0;
      let acc = 0;
      for (; cut < chars.length; cut += 1) {
        const cw = width(chars[cut]);
        if (acc + cw > max) break;
        acc += cw;
      }
      return {
        // A double-width glyph on the boundary leaves one cell short; pad it.
        text: chars.slice(0, cut).join('') + ' '.repeat(max - acc),
        spans: spans.filter((s) => s.from < cut).map((s) => ({ ...s, to: Math.min(s.to, cut) })),
      };
    },
  };
}

const over = (base, str, col) => {
  const chars = [...base];
  const put = [...str];
  for (let i = 0; i < put.length; i += 1) if (col + i < chars.length) chars[col + i] = put[i];
  return chars.join('');
};

// One bordered row of a card: `│ <inner> │`, with inner's spans shifted past the
// border and gutter. Works out the right-hand border from inner's code-point
// length so a wide glyph inside cannot push the frame off the grid.
function framed(inner, spans, { rowBg, borderFg, bold, borderBg = P.cubicle, gutter = 1 }) {
  const n = [...inner].length;
  const pad = ' '.repeat(gutter);
  const shift = 1 + gutter;
  const right = n + shift + gutter;
  return paint(
    `│${pad}${inner}${pad}│`,
    [
      { from: 0, to: 1, fg: borderFg, bg: borderBg, bold },
      { from: 1, to: right, bg: rowBg },
      ...spans.map((s) => ({ ...s, from: s.from + shift, to: s.to + shift })),
      { from: right, to: right + 1, fg: borderFg, bg: borderBg, bold },
    ],
    { fg: P.ink, bg: rowBg },
  );
}

const edge = (left, right, w, { borderFg, bold }) =>
  paint(left + '─'.repeat(Math.max(0, w - 2)) + right, [], { fg: borderFg, bg: P.cubicle, bold });

/* --------------------------------------------------------------------- desks */

const BEZEL_TOP = '┌' + '─'.repeat(SCREEN_W) + '┐';
const BEZEL_BOT = '└' + '─'.repeat(5) + '┬' + '─'.repeat(MON_W - 8) + '┘';

// Desk surface: a keyboard under the monitor, a mug, and a sticky note nobody
// has read. Everything on the desk is placed relative to the monitor so the
// keyboard stays under the screen when the layout shifts.
const KEYS_X = MON_X + 1;
const MUG_X = MON_X + 12;
const NOTE_X = 1;
const DESK_TOP = over(over(over(' '.repeat(INNER), '▃'.repeat(10), KEYS_X), '▄', MUG_X), '▄', NOTE_X);
const DESK_FRONT = over(' '.repeat(INNER), '───', MON_X + 5);

// Both slabs stuck on the cubicle wall, the tab card and the speech bubble, hang
// from this column. They are drawn one above the other, so a different left edge
// each would read as a mistake.
const SLAB_X = 1;

// The [y] and [n] already drawn on a stuck person's monitor are real buttons you
// can click. Their columns are read back out of the sprite so redrawing the screen
// art moves the buttons with it, and the row is checked against the tile's own
// height in tile() below.
const SCREEN_X = 1 + GUTTER + MON_X + 1; // tile-local column of the screen's first cell
const ART_Y = 6; // the first of the four art rows tile() returns
const BUTTON_Y = ART_Y + 2; // the second of the monitor's two screen lines
const BUTTONS = [
  ['approve', '[y]'],
  ['deny', '[n]'],
].map(([action, glyph]) => ({
  action,
  x: SCREEN_X + SCREENS.blocked[0][1].indexOf(glyph),
  y: BUTTON_Y,
  w: glyph.length,
  h: 1,
}));

// The card pinned to the cubicle wall: which tab this desk is working on. Its
// slab shares a left edge with the speech bubble and its label starts in the same
// column as the nameplate and the status line, so nothing on the wall is indented
// past anything else.
//
// No tack is drawn. The permitted glyph sets have no mark that sits on a text
// baseline: `▄` fills the bottom half of its cell and sagged next to the label,
// and moved up a row it just hung in the air. The slab of paper already reads as
// pinned to the wall, so the tack was decoration that could only look broken.
const CARD_X = SLAB_X;
const CARD_TEXT_X = CARD_X + 1;
const CARD_W = INNER - CARD_X; // 26

function wallCard(label) {
  if (!label) return null;
  return {
    // One cell of paper is left bare at the end so a label that fills the card
    // does not run into its own edge.
    text: ' '.repeat(CARD_TEXT_X) + padEnd(truncate(label, CARD_W - 2), CARD_W - 1),
    spans: [
      { from: CARD_X, to: INNER, bg: P.paper },
      { from: CARD_TEXT_X, to: INNER, fg: P.soft },
    ],
  };
}

// What a stuck person is saying, as a slab of colour over their head. A tail is
// dropped onto the hair row underneath so it reads as speech, not as signage.
// The branch gets at most twelve of the twenty-seven cells on a desk's bottom line,
// and the job keeps at least ten. Both numbers are the same kind of judgement: a
// name longer than twelve is nearly always a ticket id with a slug hanging off it,
// and a job cut below ten words is not a job any more.
const BRANCH_W = 12;

// `[y] [n]`: the answer buttons as they appear on a one-line row.
const ANSWER = '[y] [n]';
const TASK_MIN = 10;

const BUBBLE_X = SLAB_X;
const BUBBLE_W = INNER - BUBBLE_X;
const TAIL_X = 3;
function speechBubble(text) {
  return {
    text: ' '.repeat(BUBBLE_X) + ' ' + padEnd(truncate(text, BUBBLE_W - 2), BUBBLE_W - 2) + ' ',
    spans: [
      { from: BUBBLE_X, to: INNER, bg: P.bubble },
      { from: BUBBLE_X + 1, to: INNER - 1, fg: P.bubbleInk, bold: true },
    ],
  };
}

// News, on the same wall and in the same columns as the speech bubble, because it
// is the same idea: something this desk wants you to know. A different tint and
// no tail, so it reads as a notice rather than as the person talking, and it can
// never appear at the same time as an ask (a raised hand owns that row).
function eventSlab(label, kind) {
  const tint = eventTint(kind);
  return {
    text: ' '.repeat(BUBBLE_X) + ' ' + padEnd(truncate(label, BUBBLE_W - 2), BUBBLE_W - 2) + ' ',
    spans: [
      { from: BUBBLE_X, to: INNER, bg: tint.bg },
      { from: BUBBLE_X + 1, to: INNER - 1, fg: tint.ink, bold: true },
    ],
  };
}

function tile(person, { selected, frame, now, lifted = false, dropTarget = false, wall = P.wall }) {
  const st = status(person.status);
  const who = identity(person.id);
  const body = pose(person.status, frame);
  // A working desk whose foreground command herdr could name shows the command
  // instead of the generic scrolling code: same two rows, same twelve cells, but
  // now the monitor says `npm test` and the bar underneath chugs.
  const scr = person.status === 'working' && person.command
    ? runningScreen(person.command, frame)
    : screen(person.status, frame);
  // Amber pulse so a raised hand catches the eye from across the room.
  const alert = person.status === 'blocked' && frame % 4 < 2;
  // Drag feedback is colour only, never a different glyph or an extra cell: the
  // desk being carried goes pale, the desk it would land on lights up. Anything
  // that changed a line's width here would wrap the whole floor.
  const borderFg = dropTarget
    ? P.accent
    : lifted
      ? P.faint
      : selected
        ? P.accent
        : person.status === 'blocked'
          ? (alert && st.hot) || st.fg
          // The cubicle wall is the room, so this is where a workspace tint lands: it
          // is the last thing consulted, after the drag, the selection and the status,
          // which is what guarantees a room colour can never paint over a raised hand.
          : wall;
  const chrome = { borderFg, bold: dropTarget || (!lifted && (selected || alert)) };
  const row = (inner, spans, rowBg = P.cubicle) => framed(inner, spans, { ...chrome, rowBg, gutter: GUTTER });
  const blank = (rowBg) => row(' '.repeat(INNER), [], rowBg);
  // A person, a cell of desk, then their monitor.
  const art = (figure, monitor) => figure + ' '.repeat(MON_X - POSE_W) + monitor;

  const emoteFg = body.emote === 'skin' ? who.skin : st.fg;
  const mon = [
    { from: MON_X, to: INNER, fg: P.faint },
    { from: MON_X + 1, to: INNER - 1, fg: st.screen, bg: P.screen },
    { from: INNER - 1, to: INNER, fg: P.faint },
  ];

  const plate = cells();
  plate.add('▌', { fg: who.shirt });
  plate.add(' ');
  plate.add(truncate(person.name, 12), { fg: P.ink, bold: true });
  if (person.focused) plate.add(' *', { fg: P.accent, bold: true });
  const kind = truncate(person.kind, 10);
  plate.gap(INNER - width(kind));
  plate.add(kind, { fg: P.dim });
  plate.gap(INNER);

  const bar = cells();
  const dur = (person.assumedSince ? '~' : '') + formatDuration(now - person.since);
  bar.add('▌ ', { fg: st.fg });
  bar.add(st.label, { fg: st.fg, bold: alert || person.status === 'blocked' });
  bar.gap(INNER - width(dur));
  bar.add(dur, { fg: P.dim });
  bar.gap(INNER);

  const task = person.title || person.cwd.split('/').pop() || person.id;
  // The bottom line of a desk is "what, and where": the job on the left and the
  // branch on the right. Which branch a desk is on is the other half of the question
  // you have looking at a floor of agents, because two desks in the same repo, one on
  // main and one on a throwaway, are otherwise identical. The `@` is there so a short
  // branch cannot be mistaken for the tail of the job.
  //
  // The job gets whatever the branch does not need, and the branch is dropped
  // entirely rather than squeezed when that would leave the job unreadable: on a
  // twenty-seven cell line, half a branch name and half a sentence is two lies where
  // there could have been one truth.
  const foot = cells();
  const ref = person.branch ? `@${truncate(person.branch, BRANCH_W - 1)}` : '';
  const roomForRef = ref && INNER - width(ref) - 1 >= TASK_MIN;
  foot.add(truncate(task, roomForRef ? INNER - width(ref) - 1 : INNER), { fg: P.dim });
  if (roomForRef) {
    foot.gap(INNER - width(ref));
    foot.add(ref, { fg: P.soft });
  }
  foot.gap(INNER);
  const card = wallCard(person.tabName);
  // The bubble only exists while they are stuck, and its tail lands on the row
  // below, which is the hair row.
  const bubble = person.status === 'blocked' ? speechBubble(person.ask || 'needs your OK') : null;
  // The same row carries news when nobody has their hand up. An ask always wins
  // it: whatever just happened at this desk matters less than the fact that this
  // desk is waiting on you.
  const slab = !bubble && person.event?.label ? eventSlab(person.event.label, person.event.kind) : null;
  const hair = bubble ? over(body.rows[0], '▘', TAIL_X) : body.rows[0];

  // Rows, top to bottom, with a blank line wherever two things that mean
  // different things would otherwise touch: under the nameplate, under the
  // desk, and inside both borders.
  const rows = [
    edge('╭', '╮', TILE_W, chrome),
    blank(),
    row(plate.out().text, plate.out().spans),
    blank(),
    card ? row(card.text, card.spans) : blank(),
    bubble ? row(bubble.text, bubble.spans) : slab ? row(slab.text, slab.spans) : blank(),
    row(art(hair, BEZEL_TOP), [
      { from: 0, to: POSE_W, fg: emoteFg },
      { from: HAIR_FROM, to: HAIR_TO, fg: who.hair },
      ...(bubble ? [{ from: TAIL_X, to: TAIL_X + 1, fg: P.bubble }] : []),
      { from: MON_X, to: INNER, fg: P.faint },
    ]),
    row(art(body.rows[1], '│' + scr[0] + '│'), [{ from: 0, to: POSE_W, fg: who.skin }, ...mon]),
    row(art(body.rows[2], '│' + scr[1] + '│'), [{ from: 0, to: POSE_W, fg: who.shirt }, ...mon]),
    row(art(body.rows[ART_ROWS - 1], BEZEL_BOT), [
      { from: 0, to: POSE_W, fg: who.shirt },
      { from: MON_X, to: INNER, fg: P.faint },
    ]),
    row(
      DESK_TOP,
      [
        { from: NOTE_X, to: NOTE_X + 1, fg: '#f2d98a' },
        { from: KEYS_X, to: KEYS_X + 10, fg: P.keys },
        { from: MUG_X, to: MUG_X + 1, fg: '#e9e4d9' },
      ],
      P.deskTop,
    ),
    row(DESK_FRONT, [{ from: MON_X + 5, to: MON_X + 8, fg: '#40301f' }], P.deskFront),
    blank(),
    row(bar.out().text, bar.out().spans),
    row(foot.out().text, foot.out().spans),
    edge('╰', '╯', TILE_W, chrome),
  ];
  // ART_Y and BUTTON_Y are indexes into the list above, so a row added or removed
  // without moving them would leave the monitor's buttons somewhere else entirely.
  if (rows.length !== TILE_H) throw new Error(`tile is ${rows.length} rows, want TILE_H ${TILE_H}`);
  return rows;
}

// The empty desk at the end of the row. Same frame, same footprint, nobody in
// the chair: an office with a spare desk in it invites you to fill it, which is
// a better affordance than a key nobody knows about.
function vacantTile({ selected, pending, kind }) {
  const borderFg = pending ? P.faint : selected ? P.accent : P.wall;
  const chrome = { borderFg, bold: selected && !pending };
  const row = (inner, spans, rowBg = P.cubicleAlt) => framed(inner, spans, { ...chrome, rowBg, gutter: GUTTER });
  const blank = (rowBg) => row(' '.repeat(INNER), [], rowBg);
  const art = (figure, monitor) => figure + ' '.repeat(MON_X - POSE_W) + monitor;
  // An off monitor rather than a dark screen with nothing on it: the bezel is
  // there, the glass is not lit.
  const mon = [
    { from: MON_X, to: INNER, fg: P.faint },
    { from: MON_X + 1, to: INNER - 1, fg: P.faint, bg: P.screenOff },
    { from: INNER - 1, to: INNER, fg: P.faint },
  ];

  const plate = cells();
  plate.add('▌ ', { fg: P.wall });
  plate.add(pending ? 'HIRING' : 'EMPTY DESK', { fg: P.dim, bold: false });
  plate.gap(INNER);

  const bar = cells();
  bar.add('▌ ', { fg: P.accent });
  bar.add(pending ? `starting ${truncate(kind || 'an agent', 14)}` : 'nobody here yet', { fg: pending ? P.accent : P.dim });
  bar.gap(INNER);

  const hint = pending ? 'give it a moment' : 'enter or click to hire';
  const rows = [
    edge('╭', '╮', TILE_W, chrome),
    blank(),
    row(plate.out().text, plate.out().spans),
    blank(),
    blank(),
    blank(),
    row(art(VACANT_CHAIR[0], BEZEL_TOP), [{ from: MON_X, to: INNER, fg: P.faint }]),
    row(art(VACANT_CHAIR[1], '│' + VACANT_SCREEN[0] + '│'), [{ from: 0, to: POSE_W, fg: P.wall }, ...mon]),
    row(art(VACANT_CHAIR[2], '│' + VACANT_SCREEN[1] + '│'), [{ from: 0, to: POSE_W, fg: P.wall }, ...mon]),
    row(art(VACANT_CHAIR[ART_ROWS - 1], BEZEL_BOT), [
      { from: 0, to: POSE_W, fg: P.wall },
      { from: MON_X, to: INNER, fg: P.faint },
    ]),
    row(DESK_TOP, [{ from: KEYS_X, to: KEYS_X + 10, fg: P.keys }], P.deskTop),
    row(DESK_FRONT, [{ from: MON_X + 5, to: MON_X + 8, fg: '#40301f' }], P.deskFront),
    blank(),
    row(bar.out().text, bar.out().spans),
    row(padEnd(hint, INNER), [{ from: 0, to: Infinity, fg: selected && !pending ? P.soft : P.faint }]),
    edge('╰', '╯', TILE_W, chrome),
  ];
  if (rows.length !== TILE_H) throw new Error(`the empty desk is ${rows.length} rows, want TILE_H ${TILE_H}`);
  return rows;
}

/* -------------------------------------------------------------------- chrome */

function headerLines(view) {
  const { counts, people, size } = view;
  const clock = new Date(view.now).toTimeString().slice(0, 8);
  const b = cells();
  b.add('  ');
  b.add('HERDR OFFICE', { fg: P.accent, bold: true });
  b.add('   ');
  // With a filter on, the count says what it is a count *of*. "3 desks" while
  // twelve people are in the room is the single most misleading thing this header
  // could say, and the whole floor below it is filtered too.
  const on = terms(view.filter).length > 0;
  b.add(on ? `${people.length} of ${view.total ?? people.length} desks` : `${people.length} ${people.length === 1 ? 'desk' : 'desks'}`, { fg: P.dim });
  if (on || view.filtering) {
    b.add('   ');
    b.add('/', { fg: P.accent, bold: true });
    // The field is live, so the text is shown as typed rather than as parsed. A
    // cursor only while it has the keyboard: an accepted filter is a state the
    // office is in, not something you are in the middle of.
    b.add(truncate(String(view.filter || ''), 24), { fg: P.soft, bold: true });
    if (view.filtering) b.add('_', { fg: P.accent, bold: true });
  }
  // Shepherd mode moves the selection on its own, so it has to be visible from the
  // header: a highlight that walks by itself is alarming when you do not know why,
  // and it is exactly the kind of mode you leave on and forget. Amber, because it is
  // about raised hands and it should read as the same concern as the count is.
  if (view.following) {
    b.add('   ');
    b.add('» following hands', { fg: status('blocked').fg, bold: true });
  }
  // A zoom level is sticky and it changes what the whole pane looks like, so it says
  // which one you are in. Nothing at all for `auto`, because that is not a mode you
  // chose and a badge reading "automatic" on every normal frame is just noise.
  if (view.zoom === 'cubicle' || view.zoom === 'list') {
    b.add('   ');
    b.add(view.zoom === 'cubicle' ? 'one desk' : 'list view', { fg: P.faint });
  }
  const budget = size.cols - width(clock) - 4;
  for (const key of ORDER) {
    if (!counts[key]) continue;
    const st = status(key);
    const chunk = `   ${counts[key]} ${PHRASE[key]}`;
    if (b.w + width(chunk) + 1 > budget) break;
    b.add('   ');
    b.add('▌', { fg: st.fg });
    b.add(` ${counts[key]} `, { fg: P.soft, bold: key === 'blocked' });
    b.add(PHRASE[key], { fg: P.dim });
  }
  // The legend for the rooms, which is what turns the wall colours from decoration
  // into information. After the counts, because a count of raised hands outranks a
  // note about which workspace they are in, and it drops off a narrow pane the same
  // way the counts do rather than shoving the clock off the end.
  for (const room of roomsShown(view.rooms, people)) {
    const name = truncate(room.name || `room ${room.number}`, 10);
    if (b.w + width(name) + 5 > budget) break;
    b.add('   ');
    b.add('▌', { fg: room.wall });
    b.add(' ');
    b.add(name, { fg: room.ink });
  }
  b.gap(size.cols - width(clock) - 2);
  if (b.w + width(clock) + 2 <= size.cols) b.add(clock, { fg: P.dim });
  const { text, spans } = b.fit(size.cols);
  return [paint(text, spans, { bg: P.bar, fg: P.soft }), fill(size.cols, P.carpet)];
}

// The zoom levels, ordered the way the key walks them: in, normal, out. `auto` is
// the middle because it IS the floor plan, it just decides for itself when the floor
// plan has stopped being readable.
export const ZOOMS = ['cubicle', 'auto', 'list'];
const zoomOf = (view) => (ZOOMS.includes(view?.zoom) ? view.zoom : 'auto');
export const nextZoom = (zoom) => ZOOMS[(Math.max(0, ZOOMS.indexOf(zoom)) + 1) % ZOOMS.length];
// What the key does next, by where you are now, so the footer can say it.
const ZOOM_HINT = { auto: 'list view', list: 'one desk', cubicle: 'the floor plan' };

// One key list, because the panel no longer replaces the floor: everything that
// worked on the floor still works with a desk open. Answering only shows up when
// the selected desk is actually waiting on you, so the hint is never a lie.
function keyHints(view) {
  const selected = view.people.find((p) => p.id === view.selectedId);
  // Mid-drag the only two things that can happen are the drop and the cancel, so
  // the footer says that and nothing else rather than listing keys that are on
  // hold until the mouse button comes back up.
  if (view.drag?.active) return [['drop', 'on a desk to swap the panes'], ['esc', 'put it back']];
  // An armed grant says what it will grant, in the menu's own words, because that is
  // the sentence the user is agreeing to and the footer is the one row always on
  // screen. Truncated by the footer if it has to be, which is why the card carries
  // it in full as well.
  if (view.trust) {
    return [['enter', `allow "${view.trust.label}" from now on`], ['esc', 'never mind']];
  }
  // With the assign field open every key is a letter in it, so the footer must not
  // go on advertising the floor. The confirm step is the one place enter reaches
  // more than one agent, and it says so in as many words.
  if (view.compose) {
    if (view.compose.sending) return [['', 'sending']];
    if (view.compose.confirm) {
      const n = (view.compose.to || []).length;
      return [['enter', `send it to ${n} ${n === 1 ? 'person' : 'people'}`], ['esc', 'back to the text']];
    }
    return [
      ['type', view.compose.scope === 'reply' ? 'your answer' : 'what they should do'],
      ['enter', view.compose.scope === 'all' ? 'review who gets it' : 'send it'],
      ['^w', 'last word'],
      ['^u', 'clear'],
      ['esc', 'drop it'],
    ];
  }
  // Same reasoning while the hire menu is open: the arrows are picking an agent,
  // not walking the floor, and saying otherwise would be a lie.
  if (view.hire) {
    // And while the branch field has the keyboard, every letter is a letter. The
    // footer has to say so, because otherwise j and k look like they still walk.
    if (view.hire.editing) return [['type', 'a branch name'], ['enter', 'done'], ['esc', 'undo it']];
    if (view.hire.pending) return [['esc', 'stop watching']];
    return [
      ['hjkl', 'pick an agent'],
      ['enter', view.hire.worktree ? 'hire into a worktree' : 'hire them'],
      ...(view.hire.worktree ? [['e', 'name the branch'], ['t', 'no worktree']] : [['w', 'in a new worktree']]),
      ['esc', 'never mind'],
    ];
  }
  // While the filter field has the keyboard every printable key is a letter in it,
  // the same as the assign field, so the footer must stop advertising the floor.
  if (view.filtering) {
    return [
      ['type', 'to narrow the floor'],
      ['enter', 'keep it'],
      ['^u', 'clear'],
      ['esc', 'show everyone'],
    ];
  }
  // Standing at the empty desk, enter means hire, so the footer says that and
  // does not also offer the two hints it would have meant at anybody else's desk.
  const vacant = view.selectedId === HIRE_ID;
  // A standing filter earns a high seat in the footer, because it is the one piece
  // of state you can forget you switched on: the floor looks like an office where
  // everybody went home, and the way out has to be visible rather than crowded off
  // the end of the row by the walking hints. Not while the card is open, though,
  // since esc closes that first and the footer would be promising the wrong thing.
  const filtered = terms(view.filter).length > 0 && !view.detail;
  return [
    ...(vacant ? [['enter', 'hire somebody for this desk']] : []),
    // `s` sits with y and n because it is the third way to answer, and it is the one
    // that works when the question is not a yes or a no. The standing grant is only
    // advertised when the screen genuinely offers it, so the footer never promises a
    // key that would send a digit into a menu with no such option.
    ...(selected?.status === 'blocked' ? [['y', 'approve'], ['n', 'deny'], ['s', 'answer in words']] : []),
    ...(selected?.status === 'blocked' && selected?.choice?.always ? [['Y', 'always allow']] : []),
    ...(filtered ? [['esc', 'show everyone']] : []),
    ['hjkl', 'walk'],
    ...(view.detail ? [['esc', 'close']] : vacant ? [] : [['enter', 'what are you up to?']]),
    ...(vacant ? [] : [['a', 'give them a job'], ['A', 'standup']]),
    ...(vacant ? [] : [['+', 'hire']]),
    ['b', 'next raised hand'],
    ...(view.following ? [['F', 'stop following']] : [['F', 'follow hands']]),
    // The hint names what the key will do next rather than where you are, because
    // one key cycling three states is only learnable if it tells you the next one.
    ['z', ZOOM_HINT[zoomOf(view)]],
    ...(terms(view.filter).length ? [] : [['/', 'filter']]),
    ['f', 'jump to pane'],
    ['r', 'refresh'],
    ['q', 'leave'],
  ];
}

function footerLines(view) {
  const { size } = view;
  const b = cells();
  b.add(' ');
  // The message is right-aligned in the footer bar, so it has to have its room set
  // aside BEFORE the hints fill the row. A footer that ran out of space used to
  // truncate the message to nothing, which meant a refusal ("Cass has a hand up:
  // answer that first") was a keystroke that visibly did nothing at all.
  const msg = view.message ? truncate(view.message, Math.max(0, size.cols - 8)) : '';
  const room = size.cols - 2 - (msg ? width(msg) + 2 : 0);
  for (const [key, label] of keyHints(view)) {
    if (b.w + width(key) + width(label) + 4 > room) break;
    b.add('  ');
    b.add(key, { fg: P.accent });
    b.add(' ');
    b.add(label, { fg: P.dim });
  }
  if (msg) {
    b.gap(size.cols - width(msg) - 2);
    b.add(msg, { fg: status('blocked').fg });
  }
  const { text, spans } = b.fit(size.cols);
  return [fill(size.cols, P.carpet), paint(text, spans, { bg: P.bar, fg: P.soft })];
}

/* ----------------------------------------------------------------- furniture */

// An office with nothing but desks in it reads as a spreadsheet, so the carpet
// under the desks gets furnished. The layout is deterministic (the same office
// every time, not a new one every 320ms) and it only ever lands on carpet the
// desks are not using, so scenery can never cover a raised hand.
// No clock down here: it lives on a wall, not on the carpet.
//
// Order is priority: the list is walked until the room runs out, so the pieces
// that make it read as an office come before the ones that just fill space, and
// nothing appears twice until everything has appeared once.
const PROP_ORDER = ['plant', 'cooler', 'printer', 'board', 'palm', 'sofa', 'cabinet', 'bin', 'plant'];
const PROP_GAP = 3;

// Everything stands on one baseline, like it is against the back wall. A band
// deeper than this would march the furniture away from the people and leave a
// hole in the middle of the room.
const BAND_H = 6;
const MARGIN = 2;

// The whiteboard on the back wall, and what somebody wrote on it.
//
// The office already tells you what is happening right now. This is the only thing
// in it that tells you what happened: how much of the morning was actually spent
// working, how much of it was spent waiting on a human, how many hands went up and
// how many of them you answered from here. Every number comes off the punch clock
// (src/punchclock.mjs), which is derived from status changes the office was polling
// for anyway, so a wall of statistics costs nothing on the wire.
//
// It is furniture, which is the right status for it: it hangs on the back wall in
// the strip under the desks, it appears when the room has a wall to hang it on, and
// it is the first thing the band gives up when the pane gets small. Nothing about
// the office's state is ONLY on the whiteboard.
// Five rows: a frame, two lines of writing, and one bar between them. Two lines is
// about as much as anybody reads off a wall in passing, and the fifth row is the
// most the wall band can give without the board crowding out the plants.
//
// The bar row is drawn in cells like everything else, as whole blocks in the status
// colours, and it is the one row of this board a pixel layer is allowed to take
// (see the regions list in renderFrame). That ordering is deliberate: the coarse bar
// is the real fallback rather than an empty row waiting for a picture, so a terminal
// with no graphics is not missing anything, it just gets the proportion to the
// nearest thirty-sixth instead of the nearest pixel.
const WB_W = 40; // the whole board, borders included
const WB_TEXT = WB_W - 4;
// The order the header already counts statuses in, so the bar and the counts above
// it read left to right the same way.
const WB_ORDER = ['working', 'blocked', 'idle', 'done', 'unknown'];
// A prop row's colour is named rather than given as a hex, so the names have to
// resolve to both palette entries and status colours. `status.blocked` is the amber a
// blocked desk is drawn in, so the bar matches the desks it is summarising.
const colour = (name) =>
  name.startsWith('status.') ? (STATUS[name.slice(7)] || STATUS.unknown).fg : P[name];
// Where the bar sits inside `rows`, so the caller can hand exactly that row to a
// pixel layer without counting lines here and there separately.
const WB_BAR_ROW = 2;

export function whiteboard(stats, now) {
  if (!stats) return null;
  // A blank board until there is something true to write on it. A fresh office
  // reading "worked 0s, hands 0" would be furniture pretending to be information.
  // A second is the floor for the same reason it is on the card: a millisecond of
  // anything is the poll interval, not a morning's work.
  if (!(stats.worked >= 1000 || stats.waiting >= 1000 || stats.hands > 0)) return null;
  const line = (text) => `\u2502 ${padEnd(truncate(text, WB_TEXT), WB_TEXT)} \u2502`;
  // When the session started, as a wall-clock time, because "open since 09:41" is
  // what says these numbers are of a morning rather than of all time. Elapsed would
  // have read as one more statistic.
  const since = new Date(Math.max(0, now - stats.open)).toTimeString().slice(0, 5);
  const title = `open since ${since}`;
  // Time first, because the split between working and waiting on a human is the one
  // number here that says something about how the office is being run rather than
  // about how the agents are doing.
  const spent = `worked ${formatDuration(stats.worked)} \u00b7 waiting ${formatDuration(stats.waiting)}`;
  const hands = [`hands ${stats.hands}`];
  if (stats.answers > 0) hands.push(`${stats.answers} from here`);
  // A second, not a millisecond: on the first frame of a session the worst wait is
  // however long ago the last poll was, and "worst 0s" is not a statistic.
  if (stats.longest >= 1000) hands.push(`worst ${formatDuration(stats.longest)}`);
  // The coarse bar: whole cells in the status colours, in the same left-to-right
  // order the header counts them. A cell is the smallest thing this can be wrong by,
  // which is the whole argument for the pixel layer that covers it, and is also why
  // the bar is here at all rather than the row being left blank for one.
  const split = allot(WB_ORDER.map((k) => Math.max(0, (stats.spent || {})[k] || 0)), WB_TEXT);
  const barFg = [];
  let bar = '';
  WB_ORDER.forEach((key, i) => {
    for (let n = 0; n < split[i]; n += 1) {
      bar += '\u2588';
      barFg.push(key);
    }
  });
  // A session with no time in it yet gets the empty track rather than a bar of
  // nothing, for the same reason the board refuses to hang at all until there is a
  // number on it: an empty picture reads as broken, an empty track reads as early.
  const barRow = bar ? line(padEnd(bar, WB_TEXT)) : line('');
  // Two cells of frame and padding on the left before the bar starts, so the colours
  // line up under the words they belong to.
  const barStyle = bar ? ['plastic', 'plastic', ...barFg.map((k) => `status.${k}`)] : 'soft';
  const rows = [
    `\u250c ${title} ` + '\u2500'.repeat(Math.max(0, WB_W - 4 - width(title))) + '\u2510',
    line(spent),
    barRow,
    line(hands.join(' \u00b7 ')),
    '\u2514' + '\u2500'.repeat(WB_W - 2) + '\u2518',
  ];
  // Every row is one prop-shaped box, and a box whose rows disagree about their
  // width would shear the wall. The numbers in here are formatted at runtime, so
  // this is a check rather than a comment.
  for (const row of rows) if (width(row) !== WB_W) throw new Error(`whiteboard row is ${width(row)} cells, want ${WB_W}`);
  return {
    w: WB_W,
    h: rows.length,
    rows,
    barRow: WB_BAR_ROW,
    rowFg: ['plastic', 'soft', barStyle, 'soft', 'plastic'],
    // A surface, rather than writing directly on the wall: the spaces inside the
    // frame are part of the board, which is what makes it read as one.
    bg: 'paper',
  };
}

function furnish(cols, y0, rowsLeft, board = null) {
  const bandH = Math.min(rowsLeft, BAND_H);
  const room = cols - MARGIN * 2;
  if (bandH < 3 || room < 12) return [];

  // Pick what fits at the minimum spacing...
  const fits = [];
  let used = 0;
  // The whiteboard goes up first, but only if it can hang there without crowding
  // out the whole rest of the room: on a wall with no space for anything else, an
  // office of statistics and no plants is not the office this is.
  const hung = board && board.h <= bandH && board.w + 10 <= room;
  if (hung) {
    fits.push(board);
    used += board.w;
  }
  for (const name of PROP_ORDER) {
    // One board on the wall is plenty, and the small one is the stand-in for this.
    if (hung && name === 'board') continue;
    const p = PROPS[name];
    if (p.h > bandH) continue;
    if (used + p.w + fits.length * PROP_GAP > room) break;
    fits.push(p);
    used += p.w;
  }
  if (!fits.length) return [];

  // ...then spread it across the whole wall, rather than stacking it all up by
  // the door and leaving two thirds of the room bare.
  const gap = Math.floor((room - used) / (fits.length + 1));
  let x = MARGIN + gap;
  return fits.map((p) => {
    const at = { p, x, y: y0 + bandH - p.h };
    x += p.w + gap;
    return at;
  });
}

// One row of the furnished band. Every prop glyph is a single cell wide, so
// columns map straight onto array indices here.
function propRow(placed, y, cols) {
  const chars = new Array(cols).fill(' ');
  const colours = new Array(cols).fill(null);
  const backs = new Array(cols).fill(null);
  for (const { p, x, y: py } of placed) {
    const r = y - py;
    if (r < 0 || r >= p.h) continue;
    // A row's colour is normally one name for the whole row. The whiteboard's bar row
    // needs a name per cell, because a stacked bar in five colours is the one thing
    // on a prop that cannot be a single colour and still mean anything.
    const style = p.rowFg[r];
    const perCell = Array.isArray(style);
    const rowHex = perCell ? null : P[style];
    // A prop with a surface (the whiteboard) owns every cell of its box, spaces
    // included, or the wall would show through between its words.
    const back = p.bg ? P[p.bg] : null;
    [...p.rows[r]].forEach((ch, i) => {
      if (x + i >= cols) return;
      if (back) backs[x + i] = back;
      if (ch === ' ') return;
      chars[x + i] = ch;
      // Past the end of a per-cell list the row falls back to its last colour, so a
      // bar shorter than its row cannot leave uncoloured cells behind it.
      colours[x + i] = perCell ? colour(style[i] ?? style[style.length - 1]) : rowHex;
    });
  }
  const spans = [];
  const key = (i) => `${colours[i] || ''}|${backs[i] || ''}`;
  for (let i = 0; i < cols; i += 1) {
    if (!colours[i] && !backs[i]) continue;
    let j = i;
    while (j < cols && key(j) === key(i)) j += 1;
    spans.push({ from: i, to: j, ...(colours[i] ? { fg: colours[i] } : {}), ...(backs[i] ? { bg: backs[i] } : {}) });
    i = j - 1;
  }
  return paint(chars.join(''), spans, { bg: P.backWall });
}

// Drops the band into a floor that has already been filled with carpet. It sits
// as low as it can without running into whatever is above it (`minY`), which
// reads as the far wall of the room and stops a tall pane from trailing off into
// empty carpet.
//
// The whole band is wall, not carpet, so the change of shade at `bandTop` is the
// join between the two and the furniture has something to stand against. The top
// row of the band is the trim along that join, which is why the furniture starts
// one row lower.
// Returns where the whiteboard ended up, in floor-local cells, or null when it did
// not go up at all. Only the whiteboard, because it is the only piece of furniture
// with numbers on it: src/graphics.mjs draws a real chart inside its frame when the
// terminal can take one, and it can only do that if something tells it which
// rectangle the frame is currently occupying. Nobody else needs to know, so this
// stays a return value rather than becoming state.
function decorate(lines, cols, floorRows, minY, board = null) {
  const bandTop = Math.max(minY, floorRows - BAND_H);
  const bandH = Math.min(floorRows - bandTop, BAND_H);
  const placed = furnish(cols, bandTop + 1, bandH - 1, board);
  if (!placed.length) return null;
  const trim = paint('▔'.repeat(cols), [], { fg: P.trim, bg: P.backWall });
  for (let y = bandTop; y < floorRows; y += 1) lines[y] = y === bandTop ? trim : propRow(placed, y, cols);
  return board ? placed.find((at) => at.p === board) || null : null;
}

/* --------------------------------------------------------------------- floor */

function emptyFloor(view, floorRows) {
  const { cols } = view.size;
  const lines = new Array(floorRows).fill(fill(cols, P.carpet));
  const mid = Math.floor(floorRows / 2) - 1;
  const say = (raw, style, y) => {
    if (y < 0 || y >= floorRows) return;
    // Cut to the pane first. A row wider than the terminal wraps and drags every
    // line under it out of place, and the second line here is long enough to do
    // that on a narrow pane.
    const text = truncate(raw, cols);
    const left = Math.max(0, Math.floor((cols - width(text)) / 2));
    lines[y] = fill(left, P.carpet) + paint(text, [{ from: 0, to: Infinity, ...style }], { bg: P.carpet }) + fill(cols - left - width(text), P.carpet);
  };
  say('An empty office. Eerie.', { fg: P.soft }, mid);
  // This is the pane too small to draw a single desk in, so there is no empty
  // desk to click: the key is the only way in, and it has to be said out loud.
  say('Press + to hire, or start an agent in a Herdr pane.', { fg: P.dim }, mid + 2);
  // The plants keep working even when nobody else does. No whiteboard: an empty
  // office has nothing to report, and a board reading all zeros in a room with
  // nobody in it would be rubbing it in.
  decorate(lines, cols, floorRows, mid + 4);
  return lines;
}

// A filter that matched nobody. Says what it filtered on, because the alternative
// is an empty room and a moment of thinking every agent has crashed.
function noMatchFloor(view, floorRows) {
  const { cols } = view.size;
  const lines = new Array(floorRows).fill(fill(cols, P.carpet));
  const mid = Math.max(0, Math.floor(floorRows / 2) - 1);
  const say = (raw, style, y) => {
    if (y < 0 || y >= floorRows) return;
    const text = truncate(raw, cols);
    const left = Math.max(0, Math.floor((cols - width(text)) / 2));
    lines[y] = fill(left, P.carpet) + paint(text, [{ from: 0, to: Infinity, ...style }], { bg: P.carpet }) + fill(cols - left - width(text), P.carpet);
  };
  say(`Nobody here matches "${String(view.filter || '').trim()}".`, { fg: P.soft }, mid);
  say('esc shows everyone again.', { fg: P.dim }, mid + 2);
  return lines;
}

// Too many people, or too small a pane, for desks: one line each, faces kept.
function compactFloor(view, floorRows, hitboxes, startRow) {
  const { cols } = view.size;
  const lines = [];
  // One tab column width for the whole list, so the column to its right lines up
  // and the eye can run down it. Sized to the longest tab actually on screen, but
  // it gives ground before it gives up: on a narrow terminal a truncated tab name
  // still beats losing the column, and below ten cells it is not worth the space.
  const FIXED = 38; // face, status, name and duration, all fixed width
  const longest = Math.max(0, ...view.people.slice(0, floorRows).map((p) => width(p.tabName || '')));
  const tabW = Math.min(longest, 18, Math.max(0, cols - 1 - FIXED - 16 - 2));
  const tabCol = tabW < 10 ? 0 : tabW;
  for (let i = 0; i < floorRows; i += 1) {
    const person = view.people[i];
    if (!person) {
      lines.push(fill(cols, i % 2 ? P.carpetEdge : P.carpet));
      continue;
    }
    const st = status(person.status);
    const who = identity(person.id);
    const face = [...pose(person.status, view.frame).rows[1]].slice(HAIR_FROM, HAIR_TO).join('');
    const selected = person.id === view.selectedId;
    const dur = (person.assumedSince ? '~' : '') + formatDuration(view.now - person.since);
    const b = cells();
    // Narrow terminals drop columns from the right rather than wrapping: state
    // and face first, then who they are, then what they are doing.
    const room = (n) => b.w + n <= cols - 1;
    // The room, as a painted cell in the margin. The list is sorted by workspace, so
    // a stripe down the left edge is the group boundary, and it fits in a column that
    // was already a space: the one place a room can be shown in a one-line row
    // without taking a cell off anything that has words in it.
    const tint = roomOf(view.rooms, person);
    b.add(' ', tint ? { bg: tint.wall } : null);
    b.add(selected ? '▌' : ' ', { fg: P.accent });
    b.add(' ');
    b.add(face, { fg: who.skin });
    b.add('  ');
    b.add(padEnd(st.label, 11), { fg: st.fg, bold: person.status === 'blocked' });
    if (room(9)) b.add(padEnd(truncate(person.name, 8), 9), { fg: P.ink, bold: selected });
    if (room(8)) b.add(padEnd(dur, 8), { fg: P.faint });
    // Room for the answer buttons is claimed here, before the agent name and the tab
    // are given theirs, so that on a narrow pane a row which is asking you something
    // keeps the two things you need (the question and the buttons) and gives up the
    // two you can read off the card (which agent, which tab). It makes a blocked row
    // look different from the rows around it, which is not a defect: it is the row
    // that wants something from you.
    const answerRoom = person.status === 'blocked' && cols - b.w - 2 >= 16 + width(ANSWER) + 2 ? width(ANSWER) + 2 : 0;
    // Stuck people say what they need here; everyone else gets their pane title.
    // Whichever it is, it outranks the tab and the agent name for space: a row
    // that has squeezed out the ask has squeezed out the only thing you needed.
    // News takes the tail from the pane title while it lasts, for the same reason
    // it takes the wall on a desk: for the next few seconds it is the most
    // informative thing about this row, and it puts itself away again afterwards.
    const news = person.status !== 'blocked' && person.event?.label ? person.event : null;
    const tail = person.status === 'blocked' ? person.ask || 'needs your OK' : news ? news.label : person.title || person.id;
    // The tab name says which job this is, so it beats the agent's brand name to
    // the remaining space even though it is drawn after it. Both tests reserve a
    // fixed 16 cells for the tail rather than measuring this row's, so every row
    // makes the same choice and the columns stay square.
    let showTab = tabCol > 0 && room(tabCol + 2 + 16 + answerRoom);
    let showKind = room(10 + 16 + answerRoom + (showTab ? tabCol + 2 : 0));
    // On a row carrying buttons those two middle columns go together. Keeping the tab
    // while the agent name is squeezed out leaves the tab sitting in the agent's
    // column, which reads as a misprint rather than as a narrow pane, so the row is
    // either the same shape as its neighbours or the short shape: the question and
    // the buttons, and nothing in between.
    if (answerRoom && !(showKind && (showTab || tabCol === 0))) {
      showKind = false;
      showTab = false;
    }
    if (showKind) b.add(padEnd(truncate(person.kind, 9), 10), { fg: P.dim });
    if (showTab) {
      b.add(padEnd(truncate(person.tabName, tabCol), tabCol), { fg: P.ink });
      b.add('  ');
    }
    // The branch is last in the queue for space and it takes only what is spare:
    // the tail keeps the same sixteen cells it is promised above, and the branch
    // appears on a wide pane and quietly does not on a narrow one. Right-aligned so
    // that with twenty rows on the screen it forms a column you can read down, which
    // is the whole reason to want it in the list.
    // A raised hand can be answered from here, which is the one thing this view
    // could not do and needed most: the compact list exists for the floor with
    // twenty people on it, and the whole reason to be looking at twenty people is
    // that one of them is waiting on you.
    //
    // Its own right-hand column rather than trailing the ask, because a button that
    // moved with the length of the question would be a moving target for a mouse.
    // On a blocked row it takes the column the branch would have had: the branch is
    // on the card as well, and this is the only place in the list you can answer
    // from. The gap in the branch column reads as "this row is asking you something",
    // which is the right thing for it to say.
    const ref = !answerRoom && person.branch ? `@${truncate(person.branch, BRANCH_W - 1)}` : '';
    const refRoom = ref && cols - b.w - 2 >= 16 + width(ref) + 2 ? width(ref) + 2 : 0;
    b.add(truncate(tail, Math.max(0, cols - b.w - 2 - refRoom - answerRoom)), {
      fg: person.status === 'blocked' ? st.fg : news ? eventTint(news.kind).ink : P.soft,
      bold: Boolean(news),
    });
    if (refRoom) {
      b.gap(cols - 1 - width(ref));
      b.add(ref, { fg: P.faint });
    }
    // Bracketed and accent-coloured like the buttons on a monitor and the ones on
    // the card, so the same thing looks the same in all three places.
    const answers = [];
    if (answerRoom && b.w <= cols - 1 - width(ANSWER)) {
      b.gap(cols - 1 - width(ANSWER));
      const from = b.w;
      b.add('[y]', { fg: P.accent, bold: true });
      b.add(' ');
      b.add('[n]', { fg: P.accent, bold: true });
      answers.push({ action: 'approve', x: from, w: 3 }, { action: 'deny', x: from + 4, w: 3 });
    }
    const { text, spans } = b.fit(cols);
    // Drag feedback in the list is the row background only, for the same reason
    // it is border colour only on a desk: it cannot change how wide the row is.
    const dragging = Boolean(view.drag?.active);
    const rowBg = (dragging && person.id === view.drag.id) || view.busy?.has(person.id)
      ? P.lift
      : dragging && person.id === view.drag.overId
        ? P.drop
        : selected
          ? P.cubicle
          : i % 2
            ? P.carpetEdge
            : P.carpet;
    lines.push(paint(text, spans, { bg: rowBg }));
    hitboxes.push({ id: person.id, x: 0, y: startRow + i, w: cols, h: 1 });
    // After the row's own box, which is fine: hitTest prefers a box with an action
    // over the one it is drawn on, and deskAt ignores actions outright, so dropping
    // a dragged desk on somebody's [y] still means their row and not their prompt.
    for (const btn of answers) hitboxes.push({ id: person.id, action: btn.action, x: btn.x, y: startRow + i, w: btn.w, h: 1 });
  }
  return lines;
}

/* ---------------------------------------------------------------- hire panel */

// How wide one name in the menu gets. The longest kind herdr ships is nine
// characters, and a fixed cell means the grid the arrow keys walk is the grid you
// can see, which is the whole trick to making a menu navigable.
const MENU_CELL = 12;

// Who you can hire. One cell per agent kind, laid out in as many columns as fit,
// so the arrow keys move through it the same way they move through the floor.
// Returns the menu's own shape (columns, and how many cells actually fit) so the
// caller can walk exactly the grid that is on the screen and no further.
function hirePanel(view, panelRows, hitboxes, startRow) {
  const { hire, size } = view;
  const PW = Math.min(size.cols, Math.max(24, size.cols - 4));
  const TEXT = PW - 4;
  const left = Math.max(0, Math.floor((size.cols - PW) / 2));
  const chrome = { borderFg: hire.error ? STATUS.blocked.fg : P.accent, bold: false };
  const row = (inner, spans = []) => framed(padEnd(inner, TEXT), spans, { ...chrome, rowBg: P.cubicle });
  const body = [];

  // The title carries the destination, because it is the one row that is drawn at
  // every pane size: a worktree is a directory and a branch on disk, and nobody
  // should be able to create one without the screen having said so.
  const subtitle = hire.pending
    ? ` · starting ${hire.pending}`
    : hire.worktree
      ? ' · into a new worktree'
      : ' · who do you want at that desk?';
  const head = cells();
  head.add('╭─ ');
  head.add('hire', { fg: P.ink, bold: true });
  head.add(truncate(subtitle, Math.max(0, PW - head.w - 2)), { fg: P.dim });
  head.add(' ');
  head.add('─'.repeat(Math.max(0, PW - head.w - 1)));
  head.add('╮');
  body.push(paint(head.out().text, [{ from: 0, to: Infinity, fg: chrome.borderFg }, ...head.out().spans], { bg: P.cubicle, fg: chrome.borderFg }));

  // Where the hire lands, and the branch it lands on. Dropped on a pane with no
  // room for it rather than eating the only row the menu has; the title still says
  // which of the two it is.
  // Drawn over a failed hire too, because "not a trusted repository" and "that
  // branch already exists" are both fixed from this row, and hiding it would mean
  // starting the whole hire again to change one word.
  if (!hire.pending && panelRows >= 6) {
    const b = cells();
    const button = (label, action, style) => {
      const from = b.w;
      b.add(label, style);
      // A narrow pane truncates this row, and a hitbox over a label that got cut
      // off is a click on nothing. So a button is only clickable once it is
      // entirely on the screen; the keys still work either way.
      if (b.w <= TEXT) {
        hitboxes.push({ id: HIRE_ID, action, x: left + 2 + from, y: startRow + body.length, w: Math.max(1, b.w - from), h: 1 });
      }
    };
    if (!hire.worktree) {
      b.add('where', { fg: P.faint });
      b.add('  ');
      button('▌ this project', 'hire:where:here', { fg: P.ink });
      b.add('  ');
      button('w  a new worktree', 'hire:where:worktree', { fg: P.soft });
    } else {
      b.add('branch', { fg: P.faint });
      b.add('  ');
      // The field, with a block for a cursor while it is being typed into. Not a
      // real terminal cursor: the office keeps that hidden, and one that only
      // exists in the art cannot end up left behind in somebody's shell.
      const room = Math.max(8, TEXT - (hire.editing ? 26 : 34));
      // Mid-rename the field starts empty, so an empty one is a cursor and not a
      // problem. Empty with nobody typing into it would be, hence the placeholder.
      const shown = hire.branch || (hire.editing ? '' : '(unnamed)');
      button(truncate(shown, room) + (hire.editing ? '▏' : ''), 'hire:branch', {
        fg: hire.editing ? P.ink : P.soft,
        bold: hire.editing,
      });
      b.add('  ');
      if (hire.editing) b.add('enter when done', { fg: P.faint });
      else {
        button('e  rename', 'hire:branch', { fg: P.faint });
        b.add('  ');
        button('t  no worktree', 'hire:where:here', { fg: P.faint });
      }
    }
    body.push(row(b.out().text, b.out().spans));
  }

  const menuCols = Math.max(1, Math.floor(TEXT / MENU_CELL));
  let menuVisible = 0;
  if (hire.error) {
    body.push(row(truncate(hire.error, TEXT), [{ from: 0, to: Infinity, fg: STATUS.blocked.fg }]));
  } else if (hire.pending) {
    const opening = hire.worktree ? 'making a worktree' : 'opening a tab';
    body.push(row(truncate(`${opening} and waiting for ${hire.pending} to come up`, TEXT), [{ from: 0, to: Infinity, fg: P.soft }]));
  } else if (!hire.kinds.length) {
    // No manifests means herdr has not been told about any agent it can start,
    // which is worth saying out loud rather than drawing an empty grid.
    body.push(row('no agent kinds available on this machine', [{ from: 0, to: Infinity, fg: P.dim }]));
  } else {
    // Every row of the menu, clipped to whatever the panel has left after the
    // title and the footer hint.
    // Whatever the panel has left after what is already drawn (title, and the
    // where row if it fit), the footer hint and the bottom edge.
    const menuRows = Math.max(1, Math.min(Math.ceil(hire.kinds.length / menuCols), panelRows - body.length - 2));
    menuVisible = Math.min(hire.kinds.length, menuRows * menuCols);
    for (let r = 0; r < menuRows; r += 1) {
      const b = cells();
      for (let c = 0; c < menuCols; c += 1) {
        const i = r * menuCols + c;
        const kind = hire.kinds[i];
        if (!kind) break;
        const on = i === hire.index;
        const from = b.w;
        b.add(on ? '▌' : ' ', { fg: P.accent });
        b.add(padEnd(truncate(kind, MENU_CELL - 2), MENU_CELL - 1), { fg: on ? P.ink : P.soft, bold: on });
        // Every cell is clickable, so the menu does not need the keyboard.
        hitboxes.push({ id: HIRE_ID, action: `hire:start:${kind}`, x: left + 2 + from, y: startRow + body.length, w: MENU_CELL, h: 1 });
      }
      body.push(row(b.out().text, b.out().spans));
    }
    const more = hire.kinds.length - menuRows * menuCols;
    if (more > 0 && body.length < panelRows - 2) {
      body.push(row(`and ${more} more, if you make the pane taller`, [{ from: 0, to: Infinity, fg: P.faint }]));
    }
  }

  if (body.length < panelRows - 1) {
    const hint = hire.pending
      ? 'esc to stop watching (the agent keeps starting)'
      : hire.editing
        ? 'typing a branch name · enter when done · esc to undo it'
        : hire.worktree
          ? 'enter to hire into a new worktree · esc to change your mind'
          : 'enter to hire · esc to change your mind';
    body.push(row(truncate(hint, TEXT), [{ from: 0, to: Infinity, fg: P.faint }]));
  }
  body.push(edge('╰', '╯', PW, chrome));

  const lines = [];
  for (let i = 0; i < panelRows; i += 1) {
    if (i >= body.length) {
      lines.push(fill(size.cols, P.carpet));
      continue;
    }
    lines.push(fill(left, P.carpet) + body[i] + fill(size.cols - left - PW, P.carpet));
  }
  return { lines, menuCols, menuVisible };
}

/* -------------------------------------------------------------- detail panel */

// Assigning work. The most consequential panel in the office: what is in this
// field gets typed into a real agent and acted on, so the panel's whole job is to
// show, before enter, exactly what will be sent and exactly who will get it.
//
// It draws no buttons on purpose. Every other panel in the office is clickable,
// but you had to reach the keyboard to type the text at all, so enter is already
// under your hand, and a click target labelled "send this to six agents" is
// exactly the stray click there is no undoing.
function composePanel(view, panelRows) {
  const { compose, size } = view;
  const PW = Math.min(size.cols, Math.max(24, size.cols - 4));
  const TEXT = PW - 4;
  const left = Math.max(0, Math.floor((size.cols - PW) / 2));
  const to = compose.to || [];
  // Amber while it is asking you to confirm a broadcast, because that is the one
  // state in here where enter reaches more than one person.
  const chrome = {
    borderFg: compose.error ? STATUS.blocked.fg : compose.confirm ? STATUS.blocked.fg : P.accent,
    bold: false,
  };
  const row = (inner, spans = []) => framed(padEnd(inner, TEXT), spans, { ...chrome, rowBg: P.cubicle });
  const body = [];

  const who = compose.scope === 'all'
    ? `standup · ${to.length} ${to.length === 1 ? 'person' : 'people'}`
    : `${compose.scope === 'reply' ? 'answer' : 'assign'} · ${compose.name || compose.id}`;
  const head = cells();
  head.add('╭─ ');
  head.add(truncate(who, Math.max(0, PW - 6)), { fg: P.ink, bold: true });
  head.add(' ');
  head.add('─'.repeat(Math.max(0, PW - head.w - 1)));
  head.add('╮');
  body.push(paint(head.out().text, [{ from: 0, to: Infinity, fg: chrome.borderFg }, ...head.out().spans], { bg: P.cubicle, fg: chrome.borderFg }));

  // The question, above the answer, and above the field so it reads in that order.
  // An answer typed from memory is how you end up replying "the second one" to a
  // menu that has since redrawn itself. Dropped on a panel with no room, because the
  // field it belongs to matters more than the label on it.
  const asking = compose.ask && panelRows >= 6;
  if (asking) {
    const b = cells();
    b.add('re', { fg: P.faint });
    b.add('  ');
    b.add(truncate(compose.ask, Math.max(0, TEXT - b.w)), { fg: P.soft });
    body.push(row(b.out().text, b.out().spans));
  }

  // The field. Three rows at most, and only as many as the panel can spare, with
  // the end of what you typed always visible because that is where the cursor is.
  const fieldRows = Math.max(1, Math.min(3, panelRows - 4 - (asking ? 1 : 0)));
  const lines = wrapField(compose.text, TEXT - 2, fieldRows);
  lines.forEach((text, i) => {
    const b = cells();
    b.add(' ');
    b.add(text, { fg: P.ink });
    // The cursor lives on the last row, and only while the field has the keyboard.
    if (i === lines.length - 1 && !compose.sending && !compose.confirm) b.add('▏', { fg: P.accent });
    body.push(row(b.out().text, b.out().spans));
  });

  if (compose.error) {
    body.push(row(truncate(compose.error, TEXT), [{ from: 0, to: Infinity, fg: STATUS.blocked.fg }]));
  } else if (compose.sending) {
    body.push(row(truncate(`sending to ${describeTargets(to, Math.max(8, TEXT - 12))}`, TEXT), [{ from: 0, to: Infinity, fg: P.soft }]));
  } else if (compose.scope === 'all' || to.length !== 1) {
    // Who it reaches, by name, and who it does not. A broadcast that quietly went
    // to four of your seven agents would be worse than one that failed.
    const b = cells();
    b.add('to', { fg: P.faint });
    b.add('  ');
    b.add(truncate(describeTargets(to, Math.max(8, TEXT - 4 - (compose.skipped?.blocked || compose.skipped?.working ? 22 : 0))), Math.max(0, TEXT - b.w)), { fg: to.length ? P.ink : P.dim });
    const skips = [];
    if (compose.skipped?.blocked) skips.push(`${compose.skipped.blocked} with a hand up`);
    if (compose.skipped?.working) skips.push(`${compose.skipped.working} mid-task`);
    if (skips.length) {
      b.add('  ');
      b.add(truncate(`not ${skips.join(', ')}`, Math.max(0, TEXT - b.w)), { fg: P.faint });
    }
    body.push(row(b.out().text, b.out().spans));
  }

  if (body.length < panelRows - 1) {
    const hint = compose.sending
      ? 'sending'
      : compose.confirm
        ? `enter to send this to ${to.length} ${to.length === 1 ? 'person' : 'people'} · esc to go back`
        : compose.scope === 'all'
          ? 'type it out · enter to review who gets it · esc to drop it'
          : compose.scope === 'reply'
            ? 'type your answer · enter sends it and the return key · esc to drop it'
            : 'type it out · enter to send it · esc to drop it';
    body.push(row(truncate(hint, TEXT), [{ from: 0, to: Infinity, fg: compose.confirm ? STATUS.blocked.fg : P.faint }]));
  }
  body.push(edge('╰', '╯', PW, chrome));

  const out = [];
  for (let i = 0; i < panelRows; i += 1) {
    if (i >= body.length) {
      out.push(fill(size.cols, P.carpet));
      continue;
    }
    out.push(fill(left, P.carpet) + body[i] + fill(size.cols - left - PW, P.carpet));
  }
  return out;
}

function detailPanel(view, floorRows, hitboxes, startRow) {
  const { detail, size } = view;
  const person = view.people.find((p) => p.id === detail.id);
  // Four cells of carpet either side, but never wider than the pane: the floor of
  // 24 keeps the panel readable on a narrow terminal and would otherwise hang off
  // the right-hand edge of one narrower than that.
  const PW = Math.min(size.cols, Math.max(24, size.cols - 4));
  const TEXT = PW - 4;
  // Where the panel floats on the carpet. Needed up here, not just at the end,
  // because the answer buttons have to report screen coordinates.
  const left = Math.max(0, Math.floor((size.cols - PW) / 2));
  const st = person ? status(person.status) : status('unknown');
  const chrome = { borderFg: person ? st.fg : P.wall, bold: false };
  const row = (inner, spans = []) => framed(padEnd(inner, TEXT), spans, { ...chrome, rowBg: P.cubicle });
  const body = [];

  // The title row. Both halves are cut to what is left rather than trusting them
  // to be short, so that the `─` filler and the closing `╮` still land inside the
  // panel: "Ada · claude · w1:p1" is already wider than a 20-column pane.
  const head = cells();
  head.add('╭─ ');
  head.add(truncate(person ? person.name : detail.id, Math.max(0, PW - 6)), { fg: P.ink, bold: true });
  head.add(truncate(person ? ` · ${person.kind} · ${person.id}` : ' · gone', Math.max(0, PW - head.w - 2)), { fg: P.dim });
  head.add(' ');
  head.add('─'.repeat(Math.max(0, PW - head.w - 1)));
  head.add('╮');
  body.push(paint(head.out().text, [{ from: 0, to: Infinity, fg: chrome.borderFg }, ...head.out().spans], { bg: P.cubicle, fg: chrome.borderFg }));

  // The person, drawn again, big enough to see. Fields sit to their right.
  const art = person ? pose(person.status, view.frame) : null;
  const who = person ? identity(person.id) : null;
  const fields = [];
  if (person) {
    // "for at least 0s" is just noise on someone we only just laid eyes on.
    const held = view.now - person.since;
    const dwell = person.assumedSince && held < 2000 ? '' : ` for ${person.assumedSince ? 'at least ' : ''}${formatDuration(held)}`;
    fields.push(['status', st.label + dwell, st.fg]);
    // The punch clock. The status line above says what is true right now; this says
    // where the shift went, which is the question you actually have about a desk
    // that has been up since this morning.
    //
    // Every clause is worth a second before it is worth saying. A desk the office
    // met on this frame would otherwise read "0s on shift · 0s working", which is
    // three zeros where a real number is about to be, and the first thing anybody
    // opening a card would see.
    if (view.shift && view.shift.onShift >= 1000) {
      const shift = view.shift;
      const parts = [`${formatDuration(shift.onShift)} on shift`];
      if (shift.worked >= 1000) parts.push(`${formatDuration(shift.worked)} working`);
      if (shift.waiting >= 1000) parts.push(`${formatDuration(shift.waiting)} waiting on you`);
      // One hand is the hand you are looking at. Two is a pattern.
      if (shift.hands > 1) parts.push(`${shift.hands} hands`);
      fields.push(['clock', parts.join(' · '), P.soft]);
    }
    fields.push(['tab', person.tabName || '(unnamed tab)', P.ink]);
    fields.push(['doing', person.title || '(no pane title)', P.soft]);
    // No workspace/tab/pane row. The card's own title already says the pane id, the
    // tab has a row of its own two lines up, and a tab id is not a thing anybody
    // reads: it was three identifiers spending a row to repeat what was on screen.
    fields.push(['cwd', person.cwd, P.soft]);
    // Only when there is one. A `branch: (none)` row on every desk in an untrusted
    // repo would be a permanent apology for a thing nobody asked about.
    if (person.branch) fields.push(['branch', person.repo ? `${person.branch} · ${person.repo}` : person.branch, P.ink]);
    if (person.sessionId) fields.push(['session', person.sessionId, P.soft]);
  }

  const artRows = Math.max(art ? ART_ROWS : 0, fields.length);
  for (let i = 0; i < artRows; i += 1) {
    const b = cells();
    if (art && i < ART_ROWS) {
      const artRow = art.rows[i];
      const artFg = i === 0 ? (art.emote === 'skin' ? who.skin : st.fg) : i === 1 ? who.skin : who.shirt;
      b.add(artRow, { fg: artFg });
      if (i === 0) {
        const { spans } = b.out();
        spans.push({ from: HAIR_FROM, to: HAIR_TO, fg: who.hair });
      }
    } else {
      b.add(' '.repeat(POSE_W));
    }
    b.add('   ');
    const field = fields[i];
    if (field) {
      b.add(padEnd(field[0], 9), { fg: P.dim });
      b.add(truncate(field[1], Math.max(0, TEXT - b.w - 9)), { fg: field[2] });
    }
    b.gap(TEXT);
    body.push(row(b.out().text, b.out().spans));
  }

  const rule = (label) => {
    // Cut the label to fit, allowing five cells for `├─ `, the space after it and
    // the `┤`. Unclipped, "what are they up to (reading…)" is wider than a narrow
    // panel on its own, and a row wider than the pane wraps the entire screen.
    const text = truncate(label, Math.max(0, PW - 5));
    const tag = `├─ ${text} `;
    return paint(tag + '─'.repeat(Math.max(0, PW - width(tag) - 1)) + '┤', [{ from: 3, to: 3 + [...text].length, fg: P.soft }], {
      fg: chrome.borderFg,
      bg: P.cubicle,
    });
  };

  const section = (label, lines, style) => {
    body.push(rule(label));
    for (const line of lines) body.push(row(truncate(line, TEXT), [{ from: 0, to: Infinity, ...style }]));
  };

  section(detail.loading ? 'what are they up to (reading…)' : 'what are they up to', detail.summary?.length ? detail.summary : ['(nothing yet)'], {
    fg: P.ink,
  });
  // The explanation is the part you read when you doubt the office, which is never
  // the same moment as answering somebody. So it yields, the same way the screen
  // dump does: it takes what is left after the answer keys and a line of screen are
  // accounted for, and describeDetection returns its lines most-explanatory first
  // so what gets clipped is the least useful end.
  if (detail.detection?.length) {
    // Two rows for the rule and the keys, three when the prompt also offers a
    // standing grant, so the explanation yields to it rather than pushing it off.
    const answerRows = person?.status === 'blocked' && detail.choice ? (detail.choice.always ? 3 : 2) : 0;
    const budget = floorRows - body.length - answerRows - 4;
    if (budget > 0) section('why herdr thinks so', detail.detection.slice(0, budget), { fg: P.dim });
  }

  // Answer from here rather than walking over to the pane. The exact keys are
  // spelled out because they are inferred from the screen above: if the guess
  // looks wrong, that is the moment to notice, not after sending it. Each choice
  // is bracketed like the buttons on the monitor art and is clickable over
  // exactly that much of the row.
  if (person?.status === 'blocked' && detail.choice) {
    body.push(rule('answer them'));
    const b = cells();
    const y = startRow + body.length; // the row this is about to become
    const key = (k, label, keys, fgHex, action) => {
      b.add('  ');
      const from = b.w;
      b.add(`[${k}]`, { fg: P.accent, bold: true });
      b.add(' ');
      b.add(label, { fg: fgHex, bold: true });
      // +2 for the panel's own border and gutter. A short pane can clip this row
      // off the bottom of the panel, and a button nobody can see must not still be
      // sitting there taking clicks.
      if (body.length < floorRows) hitboxes.push({ id: person.id, action, x: left + 2 + from, y, w: b.w - from, h: 1 });
      b.add(` sends ${keys.join(' ')}`, { fg: P.dim });
    };
    key('y', 'approve', detail.choice.approve, STATUS.working.fg, 'approve');
    key('n', 'deny', detail.choice.deny, STATUS.blocked.fg, 'deny');
    if (detail.choice.shape === 'unknown') b.add('   (no prompt recognised)', { fg: P.faint });
    b.gap(TEXT);
    body.push(row(b.out().text, b.out().spans));

    // The standing grant gets its own row and no hitbox. Every other answer in the
    // office is clickable; this one is the sentence you cannot take back, and a
    // click target for it is exactly the stray click there is no undoing. It is only
    // drawn when the menu on the screen above actually offers it.
    const always = detail.choice.always;
    const armed = view.trust?.id === person.id;
    if (always && body.length < floorRows) {
      const t = cells();
      t.add('  ');
      t.add('[Y]', { fg: armed ? STATUS.blocked.fg : P.accent, bold: true });
      t.add(' ');
      t.add(armed ? 'enter to allow' : 'always allow', { fg: STATUS.blocked.fg, bold: true });
      t.add(`  ${always.label}`, { fg: armed ? P.ink : P.dim });
      t.gap(TEXT);
      body.push(row(t.out().text, t.out().spans));
    }
  }

  // The screen dump is the one part worth losing. In the split layout the panel
  // only gets half the pane, and clipping from the bottom would take the answer
  // keys with it, so the dump is sized to what is actually left over and skipped
  // outright when that is nothing.
  const budget = floorRows - body.length - 2;
  if (budget > 0) {
    body.push(rule('on their screen'));
    const shown = (detail.output || []).slice(-budget);
    for (const line of shown.length ? shown : ['(nothing on screen)']) {
      body.push(row(truncate(line, TEXT), [{ from: 0, to: Infinity, fg: P.faint }]));
    }
  }
  body.push(edge('╰', '╯', PW, chrome));

  const lines = [];
  for (let i = 0; i < floorRows; i += 1) {
    if (i >= body.length) {
      lines.push(fill(size.cols, P.carpet));
      continue;
    }
    lines.push(fill(left, P.carpet) + body[i] + fill(size.cols - left - PW, P.carpet));
  }
  return lines;
}

/* --------------------------------------------------------------------- frame */

export function renderFrame(view) {
  const { cols, rows } = view.size;
  const out = [...headerLines(view)];
  const roomBelowHeader = Math.max(1, rows - CHROME_ROWS);
  // Opening a desk splits the room rather than replacing it: the panel takes the
  // bottom half and the floor keeps the top, so the desk you are reading about
  // stays in sight next to everyone else. A short pane gives the panel a floor
  // of eight rows, which is the least that still shows the answer keys.
  // The hire menu, the assign field and a desk's detail are all the same slot: you
  // are either reading about somebody, deciding who to hire, or writing down what
  // somebody should do, never two of the three. Assign outranks the others because
  // it is the one holding half-typed text somebody would lose.
  const panel = view.compose ? 'compose' : view.hire ? 'hire' : view.detail ? 'detail' : null;
  const detailRows = panel ? Math.min(roomBelowHeader - 1, Math.max(8, Math.floor(roomBelowHeader / 2))) : 0;
  const floorRows = Math.max(1, roomBelowHeader - detailRows);
  const startRow = out.length;
  const hitboxes = [];
  const grid = { cols: 0, rows: 0, ids: [], menuCols: 1, menuVisible: 0 };
  // Rectangles of cells the office is willing to give up to a pixel layer, in
  // screen coordinates, the same way hitboxes are. An image occludes whatever text
  // is under it, so this list is the whole permission system: a region is only in
  // here if what it currently holds is decoration, or is a picture of a number that
  // a chart says better. Everything else on the screen is words, and words stay
  // cells. See src/graphics.mjs.
  const regions = [];
  // The spacer under the header bar. It is a row of carpet and nothing else, it is
  // always there, and it is directly beneath the counts, which is exactly where a
  // strip about who needs you belongs.
  if (rows >= 2) regions.push({ kind: 'strip', x: 0, y: 1, w: cols, h: 1 });

  const stepX = TILE_W + GAP_X;
  const stepY = TILE_H + GAP_Y;
  // Zoom is a preference, not a layout: `auto` is the old behaviour untouched, and
  // the other two only override the one decision the office was making for you.
  // `cubicle` is a floor with room for exactly one desk on it, which means the
  // paging, the walking, the walkway and the furniture all keep working as they are
  // rather than needing a third rendering path invented for them.
  const zoom = view.zoom === 'list' || view.zoom === 'cubicle' ? view.zoom : 'auto';
  const fits = cols >= TILE_W + 2 && floorRows >= TILE_H;
  const perPage =
    zoom === 'cubicle'
      ? 1
      : Math.max(1, Math.floor((cols - 1 + GAP_X) / stepX)) * Math.max(1, Math.floor((floorRows + GAP_Y) / stepY));
  // Desks are the point, but past a couple of floors the paging turns into a
  // slideshow, and then the dense list tells you more per keystroke. Asking for one
  // desk on a pane too small to draw one still gets you the list: the alternative is
  // a zoom level that shows nothing at all.
  const roomForDesks = zoom === 'list' ? false : zoom === 'cubicle' ? fits : fits && view.people.length <= perPage * 2;

  // An office with nobody in it still gets a desk drawn, so "hire somebody" is a
  // thing on the screen rather than a key you have to already know about. Only
  // when there is room for a desk at all; below that it is the old prose.
  const filtered = terms(view.filter).length > 0;
  if (!view.people.length && filtered) {
    // Not an empty office: a filter with nothing behind it. Offering to hire
    // somebody here would be answering a question nobody asked.
    out.push(...noMatchFloor(view, floorRows));
  } else if (!view.people.length && !roomForDesks) {
    out.push(...emptyFloor(view, floorRows));
  } else if (!roomForDesks) {
    out.push(...compactFloor(view, floorRows, hitboxes, startRow));
  } else {
    grid.cols = zoom === 'cubicle' ? 1 : Math.max(1, Math.floor((cols - 1 + GAP_X) / stepX));
    grid.rows = Math.max(1, Math.floor((floorRows + GAP_Y) / stepY));
    const lastPage = Math.max(0, Math.ceil(view.people.length / perPage) - 1);
    // Standing at the empty desk means standing on the last floor, where it is;
    // it is not in `people`, so findIndex would otherwise send you to floor one.
    const page =
      view.selectedId === HIRE_ID
        ? lastPage
        : Math.floor(Math.max(0, view.people.findIndex((p) => p.id === view.selectedId)) / perPage);
    const shown = view.people.slice(page * perPage, page * perPage + perPage);
    // One spare desk, on the last floor, only when there is a slot going free.
    // Paging for a desk nobody sits at would be worse than not offering it.
    // No spare desk while a filter is on: an empty chair that appeared because you
    // typed three letters reads as somebody having left.
    const vacancy = page === lastPage && shown.length < perPage && !filtered;
    const slots = [...shown.map((person) => ({ person })), ...(vacancy ? [{ vacancy: true }] : [])];
    grid.ids = slots.map((s) => (s.vacancy ? HIRE_ID : s.person.id));

    const usedRows = Math.ceil(slots.length / grid.cols);
    const blockW = grid.cols * TILE_W + (grid.cols - 1) * GAP_X;
    const left = Math.max(1, Math.floor((cols - blockW) / 2));
    // Desks start at the top of the floor. Centering them vertically looks tidy
    // when the grid nearly fills the pane and absurd when it does not: in a
    // 75-row pane one row of desks lands thirty rows down, below the fold, and
    // the office reads as completely empty.
    const top = 0;

    const lines = new Array(floorRows).fill(fill(cols, P.carpet));
    // The row between two rows of cubicles is the walkway, a shade off the carpet
    // under the desks. Barely there on purpose: it only has to stop two blocks of
    // desks from reading as one solid slab.
    for (let r = 1; r < usedRows; r += 1) {
      const y = top + r * stepY - 1;
      if (y >= 0 && y < floorRows) lines[y] = fill(cols, P.aisle);
    }
    for (let r = 0; r < usedRows; r += 1) {
      const rowTiles = slots.slice(r * grid.cols, r * grid.cols + grid.cols);
      const rendered = rowTiles.map((slot, c) => {
        const x = left + c * stepX;
        const y = startRow + top + r * stepY;
        if (slot.vacancy) {
          hitboxes.push({ id: HIRE_ID, action: 'hire', x, y, w: TILE_W, h: TILE_H });
          return vacantTile({ selected: view.selectedId === HIRE_ID, pending: Boolean(view.hire?.pending), kind: view.hire?.pending });
        }
        const person = slot.person;
        hitboxes.push({ id: person.id, x, y, w: TILE_W, h: TILE_H });
        // The [y] and [n] on their monitor take clicks in their own right, so a
        // raised hand can be dealt with without opening anything.
        if (person.status === 'blocked') {
          for (const btn of BUTTONS) hitboxes.push({ id: person.id, action: btn.action, x: x + btn.x, y: y + btn.y, w: btn.w, h: btn.h });
        }
        return tile(person, {
          selected: person.id === view.selectedId,
          frame: view.frame,
          now: view.now,
          // A desk with a swap in flight stays pale until the server confirms
          // it, so the room never looks settled while it is still moving.
          lifted: (Boolean(view.drag?.active) && person.id === view.drag.id) || Boolean(view.busy?.has(person.id)),
          dropTarget: Boolean(view.drag?.active) && person.id === view.drag.overId && person.id !== view.drag.id,
          wall: roomWall(view.rooms, person),
        });
      });
      const span = rendered.length * TILE_W + (rendered.length - 1) * GAP_X;
      for (let k = 0; k < TILE_H; k += 1) {
        const y = top + r * stepY + k;
        if (y < 0 || y >= floorRows) continue;
        let line = fill(left, P.carpet);
        rendered.forEach((t, c) => {
          if (c) line += fill(GAP_X, P.carpet);
          line += t[k];
        });
        lines[y] = line + fill(cols - left - span, P.carpet);
      }
    }

    const pages = Math.ceil(view.people.length / perPage);
    // Furnish the strip under the desks, keeping clear of the paging note.
    const deskBottom = top + (usedRows - 1) * stepY + TILE_H + 1;
    const board = whiteboard(view.stats, view.now);
    const hung = decorate(lines, cols, floorRows - (pages > 1 ? 1 : 0), deskBottom, board);
    // Only the bar row, not the writing. The first version of this took both interior
    // rows and so deleted `worked 12m · waiting 3m` to draw a picture of it, which
    // left proportions with nothing to say which colour meant "waiting". The board now
    // carries its own coarse bar in cells, and this region is that bar: a layer may
    // only take cells that were already a picture, never cells that were words.
    if (hung) regions.push({ kind: 'board', x: hung.x + 1, y: startRow + hung.y + board.barRow, w: WB_W - 2, h: 1 });
    if (pages > 1 && floorRows > 0) {
      // One desk to a floor is a desk, not a floor, and saying "floor 3 of 7" while
      // exactly one person is on the screen reads as six missing colleagues.
      const note = zoom === 'cubicle'
        ? `desk ${page + 1} of ${pages} · keep walking for the rest`
        : `floor ${page + 1} of ${pages} · keep walking for the rest`;
      const l = Math.max(0, Math.floor((cols - width(note)) / 2));
      lines[floorRows - 1] =
        fill(l, P.carpet) + paint(note, [{ from: 0, to: Infinity, fg: P.faint }], { bg: P.carpet }) + fill(cols - l - width(note), P.carpet);
    }
    out.push(...lines);
  }

  if (panel === 'hire') {
    const drawn = hirePanel(view, detailRows, hitboxes, out.length);
    grid.menuCols = drawn.menuCols;
    grid.menuVisible = drawn.menuVisible;
    out.push(...drawn.lines);
  } else if (panel === 'compose') out.push(...composePanel(view, detailRows));
  else if (panel === 'detail') out.push(...detailPanel(view, detailRows, hitboxes, out.length));
  out.push(...footerLines(view));
  return { lines: out.slice(0, rows), hitboxes, grid, regions };
}
