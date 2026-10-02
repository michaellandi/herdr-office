// Pixels, when the terminal can take them.
//
// The office writes standard Kitty graphics to its own stdout and herdr renders them.
// It did not always work this way. Until 0.9.2 there was a `pane.graphics.set` method
// on the socket and the office asked herdr to place an image into a rectangle of cells
// for it; 0.9.2 deleted those methods and moved the contract to the terminal, where it
// belongs: "Apps show images by writing standard Kitty graphics to their terminal,
// which Herdr renders natively."
//
// Which is the better arrangement, and not only because it is the supported one. The
// reason the old method was worth using was that herdr owned the awkward parts, and it
// still owns them: it parses the images an app emits inside a pane, tracks the cell
// rectangle each placement covers, clips to the pane viewport, and re-emits to the host
// terminal. So a chart that scrolls, or sits in a pane nobody is looking at, is herdr's
// problem rather than this file's, exactly as before. The office still never sniffs
// `$TERM` and never negotiates a protocol. It just writes the one protocol herdr reads.
//
// Three rules run this file, and all three are about not being a problem:
//
// 1. **An image occludes the cells it covers.** There is no compositing with the
//    text underneath, so a layer may only be placed over a rectangle the office is
//    willing to lose. That is why the two things drawn here are a decorative
//    spacer row and the inside of the whiteboard, and why the renderer has to
//    volunteer those rectangles rather than this file guessing at them.
//
// 2. **Nothing goes on the wire unless it would look different.** The office
//    repaints every 320ms; the numbers behind a chart move every few seconds. So
//    each frame arrives with a signature, and a layer whose signature and
//    placement are unchanged is skipped entirely. This mattered when a frame was an
//    RPC and it matters more now that it is 25KB of base64 going down the same pipe
//    as the text: without it the feature is a steady stream of identical PNGs, which
//    is how a wall display becomes the reason the terminal is busy.
//
// 3. **Graphics never break the office.** Every write is wrapped, failures are
//    counted rather than reported, and enough of them turn the whole thing off for
//    the rest of the run. The text floor is the product; this is a coat of paint on
//    it, and a coat of paint does not get to take the building down.
const MAX_LAYERS = 4;

// A terminal that takes bytes and then fails is worse than one that takes none, because
// the failures arrive one a frame. A few in a row is taken as a no.
const GIVE_UP_AFTER = 3;

// The first herdr that renders app-written Kitty graphics. Below this the office must
// write no image bytes at all, and the gate is the whole reason probe() still exists.
// An older herdr does not ignore an APC sequence it has no renderer for; it has no
// renderer for it because it passes pane output through, so a few kilobytes of base64
// lands on the screen as text. Garbage on the floor is worse than a plain floor.
const NEEDS = '0.9.2';

// Kitty wants the payload split, and 4096 is the chunk size the protocol documents.
const CHUNK = 4096;

// Image ids are a small integer namespace shared with anything else drawing in this
// pane. Nothing else is, in practice, but starting well away from 1 costs nothing.
const ID_BASE = 7311;

// What a cell is, in pixels, when nothing has said otherwise.
//
// The old socket method answered this exactly, with `cell_width_px`. Nothing in the
// 0.9.3 schema does: there are no pixel metrics in it anywhere. So this is assumed,
// and assuming is survivable for one reason worth being clear about. The placement
// is given to herdr in *cells* (`c=` and `r=`), so the rectangle an image lands on is
// correct whatever this number says. All it decides is how many pixels the office
// paints into that rectangle, which is sharpness, not position. Guess low and a chart
// is soft; guess high and it is slightly oversampled. Neither is a bug you can point
// at. HERDR_OFFICE_CELL=WxH for anybody who wants it exact.
const CELL_DEFAULT = { w: 8, h: 17 };

// What `#drawn` holds for a layer the office has sent but can no longer vouch for.
// A symbol rather than a string so it can never collide with a real key, which is
// what makes the comparison at the top of sync() always want a redraw. See `#forget`
// for why this exists at all, and why the alternative was a bug.
const UNSURE = Symbol('drawn, placement unknown');

// Rule 3 above says failures are counted rather than reported, which is right in a
// running office and useless the moment you are trying to find out why nothing is on
// the screen. So: set HERDR_OFFICE_GRAPHICS_LOG to a path and every decision this
// file makes is appended to it. Off by default, and the office never writes to its
// own stdout about this, because stdout is the floor.
const LOG = process.env.HERDR_OFFICE_GRAPHICS_LOG || '';
let appendFileSync = null;
if (LOG) {
  // Imported only when asked for, so the ordinary path does not pull in node:fs
  // for a feature nobody switched on.
  ({ appendFileSync } = await import('node:fs'));
}
// Exported so office.mjs can put its own side of the decision in the same file,
// in order. Half a trace is worse than none: knowing sync was skipped does not tell
// you whether the office had anything to send it.
export function graphicsLog(...parts) {
  log(...parts);
}

function log(...parts) {
  if (!appendFileSync) return;
  try {
    appendFileSync(LOG, `${new Date().toISOString().slice(11, 23)} ${parts.join(' ')}\n`);
  } catch {
    // A debug log that breaks the thing it is debugging would be worse than no log.
  }
}

// `have >= need`, on version strings that may carry a suffix this does not care about.
// Deliberately refuses an unparseable version rather than assuming the best: the cost
// of a wrong yes is base64 on somebody's screen, and the cost of a wrong no is no
// pictures.
export function atLeast(have, need) {
  const parts = (s) => (String(s ?? '').match(/\d+/g) || []).slice(0, 3).map(Number);
  const a = parts(have);
  const b = parts(need);
  if (!a.length) return false;
  for (let i = 0; i < 3; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

function cellSize() {
  const m = /^(\d+)\s*[x:,]\s*(\d+)$/.exec((process.env.HERDR_OFFICE_CELL || '').trim());
  if (m) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (w > 0 && h > 0) return { w, h };
  }
  return CELL_DEFAULT;
}

// `q=2` on everything, and it is not a nicety. It tells the terminal to send no reply,
// success or failure. A reply would arrive on stdin, where the only reader is the key
// handler, and the office would read somebody's confirmation as a burst of keystrokes.
const del = (n) => `\x1b_Ga=d,d=I,i=${n},q=2\x1b\\`;

export class Graphics {
  #api;
  #paneId;
  #out;
  // layer_id -> the key it was last drawn with, or UNSURE. Membership and value
  // answer two different questions and must not be confused: being *in* this map
  // means "there may be pixels of mine in that pane", and the value means "and this
  // is what they look like". The key covers the placement as well as the picture, so
  // the same chart moving one row down is a redraw.
  #drawn = new Map();
  #ids = new Map();
  #failures = 0;

  constructor(api, paneId, out = process.stdout) {
    this.#api = api;
    this.#paneId = paneId || '';
    this.#out = out;
    this.caps = null;
    // A pane id is how the office knows it is running inside herdr at all. It is no
    // longer sent anywhere, because the pixels go to our own stdout, which is our own
    // pane by construction, but without one this is a program in somebody's plain
    // terminal, and a plain terminal gets text.
    this.off = !api || !this.#paneId;
    log(`new pane=${this.#paneId || '(none)'} api=${Boolean(api)} off=${this.off}`);
  }

  // Asks whether this herdr renders what the office is about to write, once, before
  // the first frame. There is nothing to re-ask later: the answer is a version number,
  // and the version of the server on the other end of the socket does not change while
  // the office is running.
  //
  // It reads that version off `session.snapshot`, which the office already calls, so
  // this is one extra request at boot and no new method on the wire. Worth saying why
  // the version string and not the protocol number, since the protocol number is right
  // there beside it and looks like the tidier gate: it is not one. A 0.9.0 server and
  // a 0.9.3 server both report protocol 22, across the release that deleted the
  // graphics methods. The version string is the only field that tells them apart, and
  // it is honest about the case that actually bites: a herdr binary upgraded under a
  // session that is still running the old server.
  async probe() {
    if (this.off) return null;
    try {
      const snap = await this.#api.request('session.snapshot', {}, 3000);
      const version = String(snap?.snapshot?.version ?? snap?.version ?? '');
      if (!atLeast(version, NEEDS)) {
        log(`probe: herdr ${version || '(unknown)'} does not render app graphics, needs ${NEEDS}: text only`);
        this.caps = null;
        this.off = true;
        return null;
      }
      const cell = cellSize();
      this.caps = {
        cellW: cell.w,
        cellH: cell.h,
        // herdr clips placements to the pane viewport itself, so a pane nobody is
        // looking at needs nothing from here. This stays in caps because the office
        // reads it before building a frame, and because the honest value is now simply
        // true: there is no longer any way to ask, and no longer any need to.
        visible: true,
        maxLayers: MAX_LAYERS,
        version,
      };
      log(`probe: herdr ${version}, cell ${cell.w}x${cell.h}px, up to ${MAX_LAYERS} layers`);
      return this.caps;
    } catch {
      // No snapshot means no version, and no version means no permission to write
      // bytes that an older herdr would print.
      log('probe: could not read the herdr version, text only from here');
      this.caps = null;
      this.off = true;
      return null;
    }
  }

  // `frames` is the complete set of layers the office wants on screen right now:
  // `[{ id, canvas, signature, region }]`. Anything drawn last time and missing
  // now is cleared, so a whiteboard that scrolled off a short pane takes its
  // pixels with it instead of leaving them over the carpet.
  //
  // Synchronous, and that is a change worth noticing. While a frame was an RPC this
  // had to be fire-and-forget, with an #inflight guard, so a slow socket slowed the
  // pixels and never the floor. Writing to our own stdout has no round trip to wait
  // for, which removes the guard and removes a hazard that came with it: the old
  // version's reply handling could not have interleaved with a text frame, but bytes
  // written from a promise continuation absolutely could, landing a picture in the
  // middle of the next repaint. So the pixels go out here, in order, immediately after
  // the text they sit on top of.
  sync(frames) {
    if (this.off || !this.caps) {
      log(`sync skipped: off=${this.off} caps=${Boolean(this.caps)} frames=${frames?.length ?? 0}`);
      return;
    }
    const want = new Map();
    for (const f of (frames || []).slice(0, MAX_LAYERS)) {
      if (f?.canvas && f.region) want.set(f.id, f);
    }
    const jobs = [];
    for (const [id, f] of want) {
      const { x, y, w, h } = f.region;
      const key = `${f.signature}@${w}x${h}+${x},${y}`;
      if (this.#drawn.get(id) === key) continue;
      jobs.push({ kind: 'set', id, key, frame: f });
    }
    for (const id of this.#drawn.keys()) if (!want.has(id)) jobs.push({ kind: 'clear', id });
    if (!jobs.length) {
      log(`sync: nothing to do, ${want.size} layer(s) already correct`);
      return;
    }
    log(`sync: ${jobs.map((j) => `${j.kind} ${j.id}`).join(', ')}`);
    for (const job of jobs) {
      try {
        if (job.kind === 'clear') {
          this.#out.write(del(this.#num(job.id)));
          this.#drawn.delete(job.id);
          continue;
        }
        this.#out.write(this.#place(job.id, job.frame));
        const { canvas, region } = job.frame;
        log(`set ok: ${job.id} ${canvas.w}x${canvas.h}px at ${region.x},${region.y} ${region.w}x${region.h} cells`);
        this.#drawn.set(job.id, job.key);
        this.#failures = 0;
      } catch (err) {
        log(`FAILED ${job.kind} ${job.id}: ${err?.message ?? err}`);
        this.#failures += 1;
        this.#forget(job.id);
        if (this.#failures >= GIVE_UP_AFTER) {
          log(`giving up after ${this.#failures} failures: graphics off for the rest of this run`);
          this.off = true;
          this.caps = null;
          return;
        }
      }
    }
  }

  // Layer ids are names like `office.board`; Kitty wants a number. Assigned on first
  // use and never reassigned, because the number is the handle a later delete needs.
  #num(id) {
    if (!this.#ids.has(id)) this.#ids.set(id, ID_BASE + this.#ids.size);
    return this.#ids.get(id);
  }

  // One layer, as the bytes that put it on screen.
  //
  // Opens with a delete of the same id. Transmitting with `a=T` creates a *placement*
  // wherever the cursor is, so re-sending a chart that has moved one row down would
  // leave the old placement sitting at the old coordinates and stack a second on top.
  // Deleting first means an id has at most one placement, always the current one.
  //
  // Then: save the cursor, move it to the top-left cell of the rectangle, write the
  // image, put the cursor back. `C=1` tells the terminal not to move the cursor itself,
  // which the save and restore would cover anyway; both are here because the office's
  // renderer positions every line absolutely and a cursor left somewhere unexpected is
  // a frame drawn in the wrong place.
  #place(id, frame) {
    const { canvas, region, z = 0 } = frame;
    const n = this.#num(id);
    const data = canvas.png().toString('base64');
    const head = `a=T,f=100,i=${n},c=${region.w},r=${region.h},z=${z},C=1,q=2`;
    let out = `${del(n)}\x1b7\x1b[${region.y + 1};${region.x + 1}H`;
    for (let i = 0; i < data.length; i += CHUNK) {
      const more = i + CHUNK < data.length ? 1 : 0;
      const keys = i === 0 ? `${head},m=${more}` : `m=${more}`;
      out += `\x1b_G${keys};${data.slice(i, i + CHUNK)}\x1b\\`;
    }
    return `${out}\x1b8`;
  }

  // "I no longer know what that layer looks like", which is not the same as "that
  // layer is gone", and the difference is a bug the office shipped. This used to
  // delete the id, and deleting it is how a chart ends up stranded on the carpet:
  // the clear job in sync() only fires for ids that are in this map, so an id
  // dropped while its pixels were still on screen could never be cleared again.
  // A failed write is the case that still reaches here, and a failed write is a
  // question with no answer rather than a refusal: a partial write has put some of a
  // picture on the screen and none of this object's bookkeeping knows how much. The
  // stale placement is the dangerous half, because on a resize it is a progress bar
  // left at coordinates the layout has moved on from while the text version of the
  // same bar draws in its new home. Hence the bar twice.
  //
  // So the id stays and only its key is thrown away. The layer remains clearable,
  // and it is always re-sent because UNSURE can never match a real key. Only a
  // successful clear removes an id, which also means a failed clear is retried on
  // the next frame instead of being forgotten with its pixels still showing.
  #forget(id) {
    this.#drawn.set(id, UNSURE);
  }

  // On the way out, so the office does not leave a chart sitting in somebody's
  // pane after it has quit. Still `async` because the caller awaits it, and still
  // worth awaiting: this is the last thing written before the process exits, and on a
  // pipe that write is asynchronous.
  async clear() {
    if (!this.#drawn.size) return;
    const ids = [...this.#drawn.keys()];
    this.#drawn.clear();
    try {
      this.#out.write(ids.map((id) => del(this.#num(id))).join(''));
    } catch {
      // Quitting is not the moment to care that the terminal has gone away.
    }
  }
}
