# The README's GIF, as a script rather than a thing somebody recorded once and
# cannot reproduce. Needs vhs (https://github.com/charmbracelet/vhs):
#
#   brew install vhs && vhs scripts/demo.tape
#
# It runs `--demo`, so it needs no Herdr server and no real agents, and `y` only
# prints what it would have sent. Never record this against a live office: the
# keys below would be answering somebody's actual approval prompt.

# The path has to be quoted. Unquoted, vhs parses the slashes as commands and
# fails with "Invalid command: docs".
Output "docs/demo.gif"

Set Shell "bash"
Set FontSize 13
Set Padding 16
Set Framerate 24
# vhs sizes the window in pixels, not cells, so if you change FontSize, Padding or
# WindowBar you have to find the new numbers rather than compute them. The way to
# do that is a throwaway tape that runs `stty size` and prints the answer, because
# the pixels-to-cells arithmetic depends on the font vhs actually resolved.
#
# These land on 136x52, and both halves matter.
#
# 136 columns is four desks across rather than the three in the README's ASCII
# block, and that is deliberate. Opening a desk gives the panel the bottom half of
# the room, and the floor only keeps drawing cubicles while everyone fits in two
# pages of it (`roomForDesks` in render.mjs). Three across is two pages of three, so
# the seven agents in --demo tip it over and the floor falls back to the compact
# list for the whole second half of the recording. Four across is two pages of four,
# so the desks survive the panel opening, which is the thing worth showing.
#
# 52 rows is what it takes to see the whole of "why herdr thinks so". That section
# yields to the answer keys below it (`detailPanel` in render.mjs), which is correct
# behaviour and also means a shorter window records a GIF where the office's own
# reasoning is one clipped line. At 43 rows it was exactly that.
Set Width 1152
Set Height 860
Set WindowBar Colorful
Set BorderRadius 8

Hide
Type "clear && node office.mjs --demo"
Enter
Sleep 2s
Show

# Sit still first: the typing, the dozing and the waving are all animation, and
# a GIF that starts moving immediately reads as a glitch.
Sleep 3s

# Walk the floor.
Type "l"
Sleep 800ms
Type "l"
Sleep 800ms
Type "j"
Sleep 1200ms

# Jump to whoever has their hand up, which is the actual point of the plugin.
#
# The clock above is why these dwells are as short as they are. --demo rotates
# everybody's status every sixth poll, so about twelve seconds in, the desk with its
# hand up puts it down again. Reaching the card before that is the difference between
# recording the panel that explains a raised hand and answers it, and recording the
# panel for somebody who has gone idle.
Type "b"
Sleep 1500ms

# Open them: what are you up to?
Enter
Sleep 4s

# Answer from here. In --demo this only says what it would have sent.
Type "y"
Sleep 2500ms

Escape
Sleep 2s

Hide
Type "q"
