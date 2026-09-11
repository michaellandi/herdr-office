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

export const pose = (statusName, frame) => {
  const p = POSES[statusName] || POSES.unknown;
  return { rows: p.frames[frame % p.frames.length], emote: p.emote };
};

export const screen = (statusName, frame) => {
  const s = SCREENS[statusName] || SCREENS.unknown;
  return s[frame % s.length];
};

// The hair sits at these columns on the top row; everything else up there is an
// emote and gets the emote colour.
export const HAIR_FROM = 4;
export const HAIR_TO = 9;

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
for (const [name, frames] of Object.entries(SCREENS)) {
  frames.forEach((rows, i) =>
    rows.forEach((r, j) => {
      if ([...r].length !== SCREEN_W) throw new Error(`screen ${name}[${i}] row ${j} is ${[...r].length} wide, want ${SCREEN_W}`);
    }),
  );
}
