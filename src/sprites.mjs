// The people and their monitors.
//
// A person is POSE_W cells wide and four rows tall: hair-and-emote, head,
// shoulders, torso. A monitor is MON_W wide and four rows tall: bezel, two
// screen lines, stand. Both sit on the desk rows the tile draws underneath.
//
// Every string below MUST be exactly the declared width, because the whole
// floor is one fixed cell grid. The check at the bottom of this file shouts if
// a row drifts, which is much nicer than a skewed office.
export const POSE_W = 12;
export const SCREEN_W = 12;
export const MON_W = SCREEN_W + 2;
export const ART_ROWS = 4;

// `emote` says what colour the top row's non-hair glyphs are: a hand and the
// celebration sparkles are skin, sleepy z's and a shrugged "?" are not.
export const POSES = {
  working: {
    emote: 'skin',
    frames: [
      ['    ▄▄▄▄▄   ', '    (·_·)   ', '   ╭──┴──╮  ', '  ╱│ ███ │╲ '],
      ['    ▄▄▄▄▄   ', '    (·_·)   ', '   ╭──┴──╮  ', '  ╲│ ███ │╱ '],
      ['    ▄▄▄▄▄   ', '    (·_·)   ', '   ╭──┴──╮  ', '  ╱│ ███ │╲ '],
      ['    ▄▄▄▄▄   ', '    (·_·)   ', '   ╭──┴──╮  ', '  ╲│ ███ │╱ '],
      ['    ▄▄▄▄▄   ', '    (·_·)   ', '   ╭──┴──╮  ', '  ╱│ ███ │╲ '],
      ['    ▄▄▄▄▄   ', '    (·_·)   ', '   ╭──┴──╮  ', '  ╲│ ███ │╱ '],
      ['    ▄▄▄▄▄   ', '    (-_-)   ', '   ╭──┴──╮  ', '  ╱│ ███ │╲ '], // a blink
      ['    ▄▄▄▄▄   ', '    (·_·)   ', '   ╭──┴──╮  ', '  ╲│ ███ │╱ '],
    ],
  },
  // Hand up and waving: forearm straight, then leaning as the hand swings.
  blocked: {
    emote: 'skin',
    frames: [
      ['    ▄▄▄▄▄ o ', '    (°o°) │ ', '   ╭──┴───┘ ', '   │ ███ │  '],
      ['    ▄▄▄▄▄  o', '    (°o°) ╱ ', '   ╭──┴───┘ ', '   │ ███ │  '],
    ],
  },
  idle: {
    emote: 'status',
    frames: [
      ['    ▄▄▄▄▄ z ', '    (-_-)   ', '   ╭──┴──╮  ', '   │ ███ │  '],
      ['    ▄▄▄▄▄ zZ', '    (-_-)   ', '   ╭──┴──╮  ', '   │ ███ │  '],
    ],
  },
  // Both arms up. Worth it.
  done: {
    emote: 'skin',
    frames: [
      ['  o ▄▄▄▄▄ o ', '  │ (^_^) │ ', '  └───┬───┘ ', '   │ ███ │  '],
      ['  · ▄▄▄▄▄ · ', '  │ (^_^) │ ', '  └───┬───┘ ', '   │ ███ │  '],
    ],
  },
  unknown: {
    emote: 'status',
    frames: [
      ['    ▄▄▄▄▄ ? ', '    (o_O)   ', '  ╱╭──┴──╮╲ ', '   │ ███ │  '],
      ['    ▄▄▄▄▄  ?', '    (o_O)   ', '  ╱╭──┴──╮╲ ', '   │ ███ │  '],
    ],
  },
};

// Two screen lines per frame. Working scrolls "code"; blocked puts the ask up
// where you can see it from across the room.
export const SCREENS = {
  working: [
    ['━━━━  ━━━   ', ' ━━  ━━━━━  '],
    [' ━━  ━━━━━  ', '━━━  ━━  ━━ '],
    ['━━━  ━━  ━━ ', '━━━━  ━━━   '],
    [' ━━━━  ━━   ', ' ━━  ━━━━   '],
  ],
  blocked: [
    ['  APPROVE?  ', ' [y]    [n] '],
    ['  APPROVE?  ', ' [y]    [n] '],
  ],
  idle: [
    ['    ·       ', '            '],
    ['       ·    ', '            '],
  ],
  done: [
    ['  ALL DONE  ', '            '],
    ['  ALL DONE  ', '            '],
  ],
  unknown: [
    ['   ? ? ?    ', '            '],
    ['    ? ? ?   ', '            '],
  ],
};

// The monitor when herdr can tell us what the pane is actually running. The top
// row is the command, centred, and the bottom row chugs: a bar graph of block
// elements rotating one cell a frame, which reads as work happening without
// pretending to be a progress bar for something whose progress nobody knows.
//
// Every glyph here is U+2581 to U+2587, inside the block-elements range the grid
// allows. The light/medium/dark shades everybody reaches for first (U+2591 to
// U+2593) are just outside it and are ambiguous width in some terminals.
const CHUG = '▁▂▃▄▅▆▇▆▅▄▃▂';

export function runningScreen(label, frame) {
  const text = String(label ?? '').slice(0, SCREEN_W);
  const pad = SCREEN_W - text.length;
  const left = Math.floor(pad / 2);
  const shift = (frame * 3) % CHUG.length;
  return [
    ' '.repeat(left) + text + ' '.repeat(pad - left),
    CHUG.slice(shift) + CHUG.slice(0, shift),
  ];
}

// Which frame of a loop to draw. `frames[frame % frames.length]` is not it, for two
// reasons that both hand the renderer `undefined` and throw inside the repaint, taking
// the whole office down rather than dropping a frame: a negative frame indexes past the
// start of the array, and a fractional one is not an index at all. The counter in
// office.mjs only ever goes up in whole steps, so this is a guard on the contract.
const at = (frames, frame) => {
  const n = frames.length;
  const i = Math.floor(Number(frame)) || 0;
  return frames[((i % n) + n) % n];
};

export const pose = (statusName, frame) => {
  const p = POSES[statusName] || POSES.unknown;
  return { rows: at(p.frames, frame), emote: p.emote };
};

export const screen = (statusName, frame) => {
  const s = SCREENS[statusName] || SCREENS.unknown;
  return at(s, frame);
};

// The hair sits at these columns on the top row; everything else up there is an
// emote and gets the emote colour.
export const HAIR_FROM = 4;
export const HAIR_TO = 9;

// The empty desk: a chair with nobody in it, and a monitor that is off. Same
// footprint as a pose and a screen, because it is drawn into the same tile.
// Deliberately NOT in POSES: it has no hair, no emote and no animation, and
// putting it there would mean teaching every pose rule about the exception.
export const VACANT_CHAIR = ['            ', '    ╭───╮   ', '    │   │   ', '    ╰─┬─╯   '];
export const VACANT_SCREEN = ['            ', '            '];

// The office manager, who is not an agent and does not get an agent's poses.
//
// Two states rather than five, because there are only two things true of it: it has
// something to tell you or it does not. The clipboard in its right hand is in both, and
// it is the whole reason this is a separate set: it is the one prop on the floor that
// says at a glance which desk is the manager's, and a passer-by should not have to read
// the nameplate to work that out.
//
// What has deliberately *not* been reused is the blocked pose. A raised arm already
// means "this agent is waiting on you" everywhere else in the office, and the manager
// is never waiting on anything. So the news state keeps both hands where they were and
// puts a `!` up top, which is the same marker the footer uses for the same sentence.
//
// Outside POSES for the reason VACANT_CHAIR is: `pose()` looks its argument up by agent
// status, and there is no status these belong to. Its own self-check is at the bottom.
export const MANAGER_POSES = {
  watching: {
    emote: 'status',
    frames: [
      ['    ▄▄▄▄▄   ', '    (·_·)   ', '   ╭──┴──╮┌┐', '   │ ███ │└┘'],
      ['    ▄▄▄▄▄   ', '    (·_·)   ', '   ╭──┴──╮┌┐', '   │ ███ │└┘'],
      ['    ▄▄▄▄▄   ', '    (-_-)   ', '   ╭──┴──╮┌┐', '   │ ███ │└┘'], // a blink
      ['    ▄▄▄▄▄   ', '    (·_·)   ', '   ╭──┴──╮┌┐', '   │ ███ │└┘'],
    ],
  },
  // The marker blinks and nothing else moves. Enough to catch an eye crossing the
  // floor, and not enough to compete with a hand actually going up two desks over.
  news: {
    emote: 'status',
    frames: [
      ['    ▄▄▄▄▄ ! ', '    (o_o)   ', '   ╭──┴──╮┌┐', '   │ ███ │└┘'],
      ['    ▄▄▄▄▄   ', '    (o_o)   ', '   ╭──┴──╮┌┐', '   │ ███ │└┘'],
    ],
  },
};

export const managerPose = (name, frame) => {
  const p = MANAGER_POSES[name] || MANAGER_POSES.watching;
  return { rows: at(p.frames, frame), emote: p.emote };
};

// Furniture. None of it means anything, which is the point: an office with only
// desks in it reads as a spreadsheet. Each piece is a small block of rows plus
// the colour of its parts, and the floor drops them into leftover carpet where
// they cannot collide with a desk.
//
// `tint` names a palette entry for a run of rows, so a plant's leaves and its pot
// are not the same green. Rows are ragged in source and padded on the way out,
// which keeps trailing whitespace out of the file.
const PROP_ART = {
  plant: {
    rows: ['  ╱╲', ' ╱╲╱╲', '  ││', ' ╰──╯'],
    tint: [
      { to: 1, fg: 'leaf' },
      { to: 3, fg: 'pot' },
    ],
  },
  palm: {
    rows: ['╲ │ ╱', ' ╲│╱', '  │', ' ╰─╯'],
    tint: [
      { to: 2, fg: 'leaf' },
      { to: 3, fg: 'pot' },
    ],
  },
  cooler: {
    rows: ['╭──╮', '│▃▃│', '├──┤', '│  │', '╰──╯'],
    tint: [
      { to: 1, fg: 'water' },
      { to: 4, fg: 'plastic' },
    ],
  },
  board: {
    rows: ['┌─────┐', '│ ─── │', '│ ──  │', '└─────┘'],
    tint: [{ to: 3, fg: 'plastic' }],
  },
  cabinet: {
    rows: ['╭─────╮', '│ ─── │', '│ ─── │', '╰─────╯'],
    tint: [{ to: 3, fg: 'wood' }],
  },
  // A printer with a tray of paper sticking out of it, which is the most office
  // thing there is.
  printer: {
    rows: ['╭────╮', '│ ▁▁ │', '╰────╯'],
    tint: [
      { to: 0, fg: 'plastic' },
      { to: 1, fg: 'soft' },
      { to: 2, fg: 'plastic' },
    ],
  },
  sofa: {
    rows: ['╭─────╮', '│▃▃▃▃▃│', '╰┬───┬╯'],
    tint: [
      { to: 0, fg: 'plastic' },
      { to: 1, fg: 'fabric' },
      { to: 2, fg: 'plastic' },
    ],
  },
  bin: {
    rows: ['╭╮', '││', '╰╯'],
    tint: [{ to: 2, fg: 'plastic' }],
  },
};

export const PROPS = Object.fromEntries(
  Object.entries(PROP_ART).map(([name, art]) => {
    const w = Math.max(...art.rows.map((r) => [...r].length));
    return [
      name,
      {
        w,
        h: art.rows.length,
        rows: art.rows.map((r) => r + ' '.repeat(w - [...r].length)),
        // Flatten the row ranges into one colour name per row: the caller wants
        // to ask "what colour is row 2", not to search a range list.
        rowFg: art.rows.map((_, i) => art.tint.find((t) => i <= t.to)?.fg || 'pot'),
      },
    ];
  }),
);

for (const [name, p] of Object.entries(POSES)) {
  p.frames.forEach((rows, i) => {
    if (rows.length !== ART_ROWS) throw new Error(`pose ${name}[${i}] has ${rows.length} rows`);
    rows.forEach((r, j) => {
      if ([...r].length !== POSE_W) throw new Error(`pose ${name}[${i}] row ${j} is ${[...r].length} wide, want ${POSE_W}`);
    });
  });
}
for (const [name, p] of Object.entries(MANAGER_POSES)) {
  p.frames.forEach((rows, i) => {
    if (rows.length !== ART_ROWS) throw new Error(`manager pose ${name}[${i}] has ${rows.length} rows`);
    rows.forEach((r, j) => {
      if ([...r].length !== POSE_W) throw new Error(`manager pose ${name}[${i}] row ${j} is ${[...r].length} wide, want ${POSE_W}`);
    });
  });
}
for (const [name, frames] of Object.entries(SCREENS)) {
  frames.forEach((rows, i) =>
    rows.forEach((r, j) => {
      if ([...r].length !== SCREEN_W) throw new Error(`screen ${name}[${i}] row ${j} is ${[...r].length} wide, want ${SCREEN_W}`);
    }),
  );
}
if (VACANT_CHAIR.length !== ART_ROWS) throw new Error(`the vacant chair has ${VACANT_CHAIR.length} rows, want ${ART_ROWS}`);
VACANT_CHAIR.forEach((r, j) => {
  if ([...r].length !== POSE_W) throw new Error(`the vacant chair row ${j} is ${[...r].length} wide, want ${POSE_W}`);
});
VACANT_SCREEN.forEach((r, j) => {
  if ([...r].length !== SCREEN_W) throw new Error(`the vacant screen row ${j} is ${[...r].length} wide, want ${SCREEN_W}`);
});
