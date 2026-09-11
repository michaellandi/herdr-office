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
# vhs sizes the window in pixels, not cells, so these are a cell count multiplied
# back out: 105 columns at 8 px, and the rows at 14.33 px, plus 16 px of padding
# on each side and about 43 px for the window bar. Changing FontSize, Padding or
# WindowBar means recomputing them.
#
# This lands on 136x43, which is four desks across rather than the three in the
# README's ASCII block, and that is deliberate. Opening a desk gives the panel the
# bottom half of the room, and the floor only keeps drawing cubicles while everyone
# fits in two pages of it (`roomForDesks` in render.mjs). Three across is two pages
# of three, so the seven agents in --demo tip it over and the floor falls back to
# the compact list for the whole second half of the recording. Four across is two
# pages of four, so the desks survive the panel opening, which is the thing worth
# showing.
Set Width 1152
Set Height 724
Set WindowBar Colorful
Set BorderRadius 8

Hide
Type "clear && node office.mjs --demo"
Enter
Sleep 2s
Show

# Sit still first: the typing, the dozing and the waving are all animation, and
# a GIF that starts moving immediately reads as a glitch.
Sleep 4s

# Walk the floor.
Type "l"
Sleep 1s
Type "l"
Sleep 1s
Type "j"
Sleep 1500ms

# Jump to whoever has their hand up, which is the actual point of the plugin.
Type "b"
Sleep 2s

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
