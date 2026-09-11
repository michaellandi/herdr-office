#!/usr/bin/env bash
# Records the README's GIF: scripts/demo.tape -> docs/demo.gif
#
#   brew install vhs && ./scripts/record-demo.sh
#
# vhs can write the GIF by itself, and if yours does, `vhs scripts/demo.tape` is
# all you need. It does not work on every machine: vhs shells out to ffmpeg for
# the encode, and against ffmpeg 9 it prints "Creating docs/demo.gif..." and then
# silently writes no file at all. So this script does the two halves separately,
# which works either way: vhs drives the terminal and dumps PNG frames, and we
# run the encode ourselves.
set -euo pipefail

cd "$(dirname "$0")/.."

for tool in vhs ffmpeg; do
  command -v "$tool" >/dev/null || { echo "need $tool: brew install $tool" >&2; exit 1; }
done

FRAMES=$(mktemp -d)
trap 'rm -rf "$FRAMES"' EXIT

# The tape's own Output line is the GIF, so point this run at a frame directory
# instead. Everything else about the recording stays exactly as the tape says.
# The copy has to keep the .tape suffix: vhs appends one to whatever path it is
# given, so a file called "tape" is looked for as "tape.tape".
# The frame directory must NOT exist yet. vhs creates it, and silently captures
# nothing if it is already there, so it gets a fresh subdirectory of its own
# rather than sharing one with the tape.
PNG="$FRAMES/png"
sed 's|^Output .*|Output "'"$PNG"'/"|' scripts/demo.tape > "$FRAMES/demo.tape"
vhs "$FRAMES/demo.tape"

count=$(find "$PNG" -name 'frame-text-*.png' | wc -l | tr -d ' ')
[ "$count" -gt 0 ] || { echo "vhs captured no frames" >&2; exit 1; }
echo "captured $count frames, encoding..."

mkdir -p docs
# Recorded at 24fps and encoded at 12: the office animates every 320ms, so 12 is
# still smooth and it halves the file. frame-text is the render without the cursor
# overlay, which is what we want because the office hides the cursor anyway.
ffmpeg -hide_banner -loglevel error -y \
  -framerate 24 -i "$PNG/frame-text-%05d.png" \
  -vf "fps=12,scale=1088:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" \
  -loop 0 docs/demo.gif

echo "wrote docs/demo.gif ($(du -h docs/demo.gif | cut -f1))"
