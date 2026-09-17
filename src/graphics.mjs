// Pixels, when the terminal can take them.
//
// `pane.graphics.set` puts an image into a rectangle of cells in a pane. herdr
// handles the terminal protocol itself, which is the part that makes this worth
// doing at all: the schema has no mention of sixel, kitty or iterm anywhere in it,
// so the office never negotiates a graphics protocol, never sniffs `$TERM`, and
// never has to care that the same picture is three different escape sequences on
// three different terminals. It asks whether the pane can take an image, and if
// the answer is yes it sends one.
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
//    placement are unchanged is skipped entirely. Without this the feature is a
//    steady stream of identical PNGs, which is how a wall display becomes the
//    reason the socket is busy.
//
// 3. **Graphics never break the office.** Every call is wrapped, failures are
//    counted rather than reported, and enough of them turn the whole thing off for
//    the rest of the run. The text floor is the product; this is a coat of paint on
//    it, and a coat of paint does not get to take the building down.
const DEFAULT_LAYERS = 4;

// A terminal that says yes and then fails is worse than one that says no, because
// the failures arrive one a frame. A few in a row is taken as a no.
const GIVE_UP_AFTER = 3;

// How often to ask whether anybody is looking, and the whole reason there are two
// numbers rather than one. While the pane is on screen there is nothing to learn: it
// is visible, the layers are up, and the answer will be the same in a second. While
// it is off screen the answer is the only thing the office is waiting for, and it is
// also doing nothing else with the socket, so asking often is free.
//
// The number that matters is HIDDEN_MS, because it is what somebody switching back to
// the office actually experiences: the delay before the pixels reappear is this plus
// one round trip. Measured on a 2s poll it was two seconds of blank whiteboard, which
// is long enough to look, see text, and conclude the feature does not work.
const VISIBLE_MS = 1500;
const HIDDEN_MS = 250;

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

export class Graphics {
  #api;
  #paneId;
  // layer_id -> the key it was last drawn with. The key covers the placement as
  // well as the picture, so the same chart moving one row down is a redraw.
  #drawn = new Map();
  #inflight = false;
  #failures = 0;
  #probedAt = 0;
  #probing = false;

  constructor(api, paneId) {
    this.#api = api;
    this.#paneId = paneId || '';
    this.caps = null;
    this.off = !api || !this.#paneId;
    log(`new pane=${this.#paneId || '(none)'} api=${Boolean(api)} off=${this.off}`);
  }

  // The one the office calls on every frame. Asks at most as often as the current
  // state deserves, so the caller does not have to own a timer or know which of the
  // two intervals applies. Returns nothing and is never awaited: this is a question
  // asked in the background, and the frame it was called from has already gone out.
  //
  // Deliberately driven off the redraw rather than a timer of its own. A pane the
  // office has stopped drawing is a pane the office is not running in.
  poll() {
    if (this.off || this.#probing) return;
    const due = this.caps?.visible === false ? HIDDEN_MS : VISIBLE_MS;
    if (Date.now() - this.#probedAt < due) return;
    this.#probing = true;
    this.probe().finally(() => {
      this.#probing = false;
    });
  }

  // Asks the pane what it can do, and whether anybody is looking at it. Unthrottled,
  // because the two callers that want it directly both want an answer now: the boot
  // path, which awaits it before the first frame, and the tests.
  async probe() {
    if (this.off) return null;
    // Stamped before the call, not after, so a slow or hanging `info` cannot turn
    // into a queue of them. #probing already covers overlap; this covers the gap
    // between one finishing and the next being allowed.
    this.#probedAt = Date.now();
    try {
      const info = await this.#api.request('pane.graphics.info', { pane_id: this.#paneId }, 3000);
      const cellW = Number(info?.cell_width_px) || 0;
      const cellH = Number(info?.cell_height_px) || 0;
      // A cell with no pixels in it is a pane that cannot draw, whatever else the
      // response said. Same posture as the rest of the office: an answer that does
      // not make sense is treated as a no rather than divided by.
      if (!(cellW > 0 && cellH > 0)) {
        log(`probe: cell is ${cellW}x${cellH}, treating as no graphics`);
        this.caps = null;
        this.off = true;
        return null;
      }
      const was = this.caps?.visible;
      this.caps = {
        cellW,
        cellH,
        visible: info.pane_visible !== false,
        maxLayers: Number(info?.max_layers_per_pane) || DEFAULT_LAYERS,
        pixelMouse: Boolean(info?.pixel_mouse),
      };
      // Coming back into view is a full redraw. A pane that was off screen may
      // have had its images dropped while it was away, and the office cannot tell
      // from here: the only safe assumption is that what it thinks it drew is gone.
      if (was === false && this.caps.visible) {
        log('probe: came back into view, forgetting what was drawn');
        this.#drawn.clear();
      }
      if (was !== this.caps.visible) log(`probe: visible=${this.caps.visible} cell=${cellW}x${cellH} layers=${this.caps.maxLayers}`);
      return this.caps;
    } catch {
      // No such method, or a server that would rather not say. Either way this is
      // a terminal without graphics, and the text floor is already correct.
      log('probe: no graphics on this server, text only from here');
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
  // Deliberately not awaited by the caller. draw() is synchronous and runs on a
  // 320ms timer; a slow socket must slow the pixels down, never the floor.
  sync(frames) {
    if (this.off || !this.caps || !this.caps.visible || this.#inflight) {
      log(
        `sync skipped: off=${this.off} caps=${Boolean(this.caps)} ` +
          `visible=${this.caps?.visible} inflight=${this.#inflight} frames=${frames?.length ?? 0}`,
      );
      return;
    }
    const want = new Map();
    for (const f of (frames || []).slice(0, this.caps.maxLayers)) {
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
    this.#inflight = true;
    this.#run(jobs).finally(() => {
      this.#inflight = false;
    });
  }

  async #run(jobs) {
    for (const job of jobs) {
      try {
        if (job.kind === 'clear') {
          await this.#api.request('pane.graphics.clear', { pane_id: this.#paneId, layer_id: job.id }, 3000);
          this.#drawn.delete(job.id);
          continue;
        }
        const { canvas, region, z = 0 } = job.frame;
        await this.#api.request(
          'pane.graphics.set',
          {
            pane_id: this.#paneId,
            layer_id: job.id,
            format: 'png',
            image_width: canvas.w,
            image_height: canvas.h,
            data_base64: canvas.png().toString('base64'),
            z_index: z,
            // The placement is in cells, which is what lets a pixel chart land
            // exactly on the rectangle the text renderer set aside for it. The
            // canvas was sized off `cell_width_px` in the first place, so the image
            // and the cells it covers are the same shape by construction.
            placement: {
              grid_cols: region.w,
              grid_rows: region.h,
              viewport_col: region.x,
              viewport_row: region.y,
            },
          },
          5000,
        );
        log(`set ok: ${job.id} ${canvas.w}x${canvas.h}px at ${region.x},${region.y} ${region.w}x${region.h} cells`);
        this.#drawn.set(job.id, job.key);
        this.#failures = 0;
      } catch (err) {
        log(`FAILED ${job.kind} ${job.id}: ${err?.message ?? err}`);
        this.#failures += 1;
        // Forget what we thought was on screen: after a failure the office does
        // not know, and assuming the worst means the next frame redraws.
        this.#drawn.delete(job.id);
        if (this.#failures >= GIVE_UP_AFTER) {
          log(`giving up after ${this.#failures} failures: graphics off for the rest of this run`);
          this.off = true;
          this.caps = null;
          return;
        }
      }
    }
  }

  // On the way out, so the office does not leave a chart sitting in somebody's
  // pane after it has quit. Bounded by the caller for the same reason clearing the
  // window title is: a hung socket must never be why ctrl-c did not work.
  async clear() {
    if (!this.#api || !this.#paneId || !this.#drawn.size) return;
    const ids = [...this.#drawn.keys()];
    this.#drawn.clear();
    for (const id of ids) {
      await this.#api.request('pane.graphics.clear', { pane_id: this.#paneId, layer_id: id }, 400).catch(() => {});
    }
  }
}
