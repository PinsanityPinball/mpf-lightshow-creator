# Show Creator

A light-show editor for home-brew pinball machines running MPF 0.50+.

Draw moving shapes over your playfield, sample what each LED sees, and export an
MPF show. A rebuild of the original BlitzMax
[`showcreator`](https://github.com/missionpinball/showcreator), with parametric
shapes, a real timeline, light patterns and direct manipulation.

> **Built with [Claude Code](https://claude.com/claude-code).** Almost all of the
> code here was written by Claude, working from my direction, my machine's light
> maps, and a lot of back-and-forth about what actually reads well on a
> playfield. The ideas and the pinball knowledge are mine; the implementation is
> Claude's.

---

## Features

**Building shows**

- **17 parametric shapes** plus your own PNGs — bar, circle, triangle, square,
  arc/pie, glow, star, cross, ring, spiral, chevrons and more, each with live
  parameters rather than a fixed image
- **Full keyframe timeline** — any number of keyframes per layer, 13 easing
  curves, draggable clips, repeat and ping-pong
- **Animate shape parameters** — an arc's span, a ring's thickness, a spiral's
  turns, so a pie chart that fills is one layer
- **Motion paths** — circle, infinity, spiral, zig-zag, bounce and more, applied
  in one click, plus transforms and randomisers
- **Blend modes** — add, normal, *average* (mixes colours without dimming), or
  *erase* (switches lights off wherever a layer reaches)
- **Fire a layer many times** — one layer, many start times, varied per firing,
  instead of a copy per repeat
- **Step-by-step wizard** with a live preview, or full manual control

**Light patterns** — no shape, no sampling, exact colours straight to your lights

- Chase, Marquee, Sparkle, Wave, Stack, Fire, Pinwheel, Scanner, Rain, Plasma,
  Contagion, Comet, Group sweep, Interference, Blink and Solid
- Most work off your real light *positions*, so they follow your playfield
  layout rather than a drawn shape

**Your machine**

- Reads your MPF `monitor.yaml` and `lights.yaml` **in place** — no copying
- **Target layers by light tag** (`ring`, `left_ramp`, …) instead of by hand
- Optional **playfield photo** underlay to trace against
- Exports straight into your machine's `shows/` folder
- Notices when a light map changes on disk and offers to reload

**Output**

- **MPF 0.57+ compliant** (`#show_version=6`, explicit step durations), with a
  legacy 0.50–0.56 mode
- **Linear-light blending**, matching how real LEDs actually add
- Identical consecutive frames merge, so a 0.5 s blink is 5 steps, not 75
- **Import existing MPF shows** as layers and stack new work on top
- `tools/check_show.py` validates output against MPF 0.80's real rules

**Working in it** — undo/redo on everything, save/load projects as JSON,
keyboard shortcuts, and a Lights-only view showing exactly what the machine will
do.

---

## Running it

Double-click **`run.bat`**, or:

```bash
python server.py
```

It starts a local server on `http://127.0.0.1:8777` and opens your browser.
Python 3.8+ is the only requirement — no `pip install`, no build step. Closing
the browser window shuts the server down; `--keep-alive` leaves it running.

Useful flags:

```bash
python server.py --port 9000 --no-browser --verbose
```

### First run

The repo ships the app only — anything describing a *particular* machine is left
out. Point it at your files with the **Map** and **Tags** dropdowns (see below).
Everything else is created for you on startup.

### If it can't find Python

`run.bat` does not rely on Python being on your PATH. It tries the `py`
launcher, then `python`, then the usual install folders, and prints which
interpreter it used. Failing that, point it at one yourself:

```bash
"C:\path\to\python.exe" server.py
```

---

## Light maps and tags

Two files describe your machine, both remembered between sessions:

- **Map** — an MPF `monitor.yaml`, giving each light a normalised `x`/`y` plus
  optional `shape`, `size` and `rotation`
- **Tags** — an MPF `lights.yaml`, giving each light its `tags:` list

Pick both from the dropdowns in the top bar. **Browse for a file…** opens a file
browser so you can use them wherever they already live — the app stores the path
and reads the file in place, so it never goes stale against the original.

A tags file pairs to a map automatically by stem, so `mymachine_monitor.yaml`
finds `mymachine_lights.yaml` beside it. Some machines keep positions and tags in
one file; a `lights.yaml` with both `x`/`y` and `tags:` is labelled **map + tags**
and fills either slot.

If you edit a map while the app is open, the reload button turns amber and the
status bar says so.

---

## Layers

A **show** contains **layers**. Each has a clip on the timeline — start, length,
repeat, ping-pong — and comes in one of three kinds:

| Kind | What drives the lights |
| --- | --- |
| **Shape** | A parametric shape or PNG, sampled per light |
| **Pattern** | A blink, chase or wave applied directly to tagged lights |
| **Show** | An imported MPF show, replayed on the lights it names |

Only shape layers have geometry on the playfield. The other two contribute
colours directly, so use the *Lights* or *Both* view to see them.

Each layer has a **blend mode**: *Add* stacks it with everything else, *Normal*
covers what is under it, *Average* mixes colours instead of summing them, and
*Erase* turns lights **off** wherever it reaches.

*Average* mixes every averaging layer reaching a light into one colour, then
scales the result back up to the brightest layer that reached it — so mixing
changes the hue without dimming the light. Red over yellow gives orange rather
than yellow; red over white gives pink rather than white; two half-brightness
reds stay half rather than doubling. Colours that share no channels (red and
blue) come out the same as adding, since there is nothing to average away.
An eraser lights nothing of its own — its colour is irrelevant, only its shape
matters — and it affects only layers below it in the list, so you can punch a
moving hole in a wash or hold one group dark while the rest of the show runs.
Any layer kind can erase.

**+ Add layer** (or `Ctrl+N`) offers four routes: start from a preset, build it
step by step with the wizard, import an MPF show, or roll a random one.

The right-hand **Layer** panel splits into the same seven steps the wizard walks
— Shape, Path, Motion, Size, Colour, Lights, Timing — so learning one teaches
the other. Each step leads with a few obvious choices and folds the rest behind
**Advanced options**.

### Firing a layer more than once

A layer normally fires once. Give it extra start times — **Layer → Timing → Fire
again** — and the same animation runs at each of them, overlapping freely. One
layer instead of a copy per firing.

This matters more than it sounds: across the saved shows in `shows/`, **63–71% of
every layer is an exact duplicate** of another differing only in start time. One
file holds 291 copies of a single gesture among 5,033 layers, which is how a
300-second show reaches 14 MB.

**Vary each firing** stops a train looking mechanical. *Hue shift* is cumulative
degrees per firing, so a long run drifts through the spectrum. Position and size
take short lists that cycle by firing number, so three values cover any number of
firings — and they are **offsets**, so each firing keeps the layer's own
animation and is simply nudged from it. Shape layers only: a pattern drives its
lights from its own settings and never reads the state that varying changes.

A layer with no extra times behaves exactly as before, so existing shows are
unaffected.

### Pattern layers

Sampling a shape is right for a sweep and wrong for an on-off show. A pattern
layer drives its tagged lights directly, with no shape and no pixel sampling, so
`FF0000` really is `FF0000`.

| Pattern | What it does |
| --- | --- |
| **Blink** | On for *N* ms, off for *M* ms. Off can be dark or a second colour |
| **Chase** | Steps through the lights in order, adjustable width and fading tail |
| **Marquee** | Every *N*th light lit, the set stepping along — a theatre sign |
| **Sparkle** | *N* random lights at once from a palette, re-picked on a timer |
| **Wave** | A wave across the real light positions, outward from the centre or up/across. A trough colour makes it wash between two colours |
| **Stack** | Fills a grid cell by cell, Tetris-style, with the pieces visibly travelling to their resting place |
| **Fire** | Per-light flicker, hottest at the base of the group, cooling upward |
| **Pinwheel** | Arms rotating about the centre, worked out from each light's angle |
| **Scanner** | The Knight Rider band, sweeping back and forth with a trail |
| **Rain** | Drops falling down the playfield, each with a trail |
| **Plasma** | Overlapping sine fields — every light its own colour and brightness |
| **Contagion** | Light spreads from one light to its neighbours, then theirs — so it follows the shape of your playfield, climbing a ramp and rounding an orbit |
| **Comet** | With gravity 0, the DVD-logo bounce: a straight line at constant speed reflecting off all four edges. With gravity, a thrown ball arcing and bouncing off the floor |
| **Group sweep** | Whole tag groups lighting one after another, with a hand-over |
| **Interference** | Two wave fields multiplied, so the beat between them travels far slower than either wave |
| **Solid** | One colour, with an optional pulse shape |
| **Blink** | On/off, also with a pulse shape |

**Pulse shapes** on Solid and Blink give the brightness a curve: *Breathe*
(quick in, slow out), *Heartbeat* (lub-dub then a rest), ramps and a triangle. A
plain fade is what keyframes are for; these are the curves that are tedious to
keyframe and trivial as a setting.

**Contagion needs a sensible Reach.** It decides how close counts as a
neighbour: too small and the spread cannot cross the gaps in your layout, too
large and it jumps everywhere at once. The neighbour graph is built once per
light map and cached — measured at 8 ms to build against 317 lights and 0.25 ms
per frame afterwards, so a 300-frame export costs 74 ms rather than 2.4 seconds.

**Group sweep** arrives with groups already chosen off your map — the four
largest that do not overlap each other — so it does something the moment you
drop it in. The panel lists your map's tags as buttons: click one to add it,
click it again to take it out, and the number shows its place in the order. Tags
nearest the top of that list overlap least, which is what makes a sweep read;
a machine's broadest tags are often supersets of one another, and sweeping
through three of those lights nearly the same lights every slot.

**Fit to layer length** (on by default) makes one cycle span the clip: a
complete fill for Stack, one pass for Chase, whole passes for Wave. Resize the
clip and the pattern stretches with it.

**Sparkle, Rain and Fire are random but repeatable.** They run off a seeded
generator, so the preview matches the export and exporting twice gives
byte-identical files. Change the **Seed** for a different arrangement.

Order lights by name (natural, so `l_x_2` precedes `l_x_10`), position, or angle
around the centre. Tags split on commas *and* whitespace, so a missing comma
(`tags: all, 5x 4x`) still yields separate tags.

One timing caveat: the sampler can only switch on a frame boundary, so 120 ms at
30 Hz actually lands on 100 ms. The panel says so and suggests the nearest exact
value.

---

## Working in it

**Playfield** — click a shape to select, drag to move. Blue corner handle
scales, orange handle rotates. Hover a light to see its name and colour.

**The mouse button says what you mean.** **Left-drag** moves the *whole layer* —
every keyframe shifts together and the shape follows your pointer exactly.
**Right-drag** moves the keyframe at the playhead, creating one there if it does
not exist. The same applies to the rotate and scale handles: left resizes or
turns the whole layer, right does just that keyframe. `Shift` snaps rotation to
15° and keeps scaling square.

Press **?** or the toolbar's **?** button for the full list of keys and
gestures.

**Timeline** — drag a clip to move it, drag its ends to retime it. Drag keyframe
diamonds; double-click a clip to add one. `Alt` disables frame snapping. Wheel
scrolls, `Shift`+wheel pans, `Ctrl`+wheel zooms. Drag layer names to reorder,
double-click one to rename it.

**Views** — *Both*, *Shapes* or *Lights*. **Lights** shows only what the machine
will actually do. **Onion** ghosts every keyframe; **Path** draws the motion
path including easing.

**Undo** covers everything, including sliders. A continuous drag folds into one
undo entry rather than one per pixel.

### Keyboard

| Key | Action | | Key | Action |
| --- | --- | --- | --- | --- |
| `Space` | Play / pause | | `K` | Add keyframe |
| `←` `→` | Step one frame (`Shift` = 10) | | `Backspace` | Delete keyframe |
| `↑` `↓` | Previous / next layer | | `Del` | Delete layer |
| `Home` `End` | Start / end | | `Ctrl+Z` | Undo |
| `1` `2` `3` | Both / Shapes / Lights | | `Ctrl+Shift+Z` | Redo |
| `L` | Toggle lights-only | | `Ctrl+S` | Save |
| `O` | Toggle onion skin | | `Ctrl+N` | Add layer |

---

## Show length and sample rate

Two independent decisions. Since MPF 0.57+ output writes a real duration onto
every step, the sample rate no longer affects playback speed.

- **Show length** (Show tab) — leave at 0 to follow the layers, or set a fixed
  length. **Fit to** stretches every layer to land on a given length.
- **Sample rate** (10–60 Hz) — smoothness versus file size. 30 Hz suits most
  shows.

**Measure cost of each rate…** exports at every rate and reports real step counts
and file sizes. Smooth motion scales roughly linearly with rate; held content is
nearly free, since identical frames merge. The real hazard is sampling *too low*
— a 10 Hz strobe sampled at 10 Hz collapses to a single step and vanishes.

---

## Export

**Export show** renders every frame and writes MPF show YAML:

```yaml
#show_version=6
- duration: 33ms
  lights:
    l_right_ramp: '009900'
- duration: 34ms
  lights:
    l_right_ramp: '008B00'
```

Play it at the default speed — the durations are explicit. Step durations come
from the cumulative timeline rather than being rounded individually, so 30 fps
alternates 33/33/34 ms instead of drifting 10 ms per second.

### MPF version targets

The format changed after MPF 0.56. **MPF version** in the Export tab picks the
dialect:

| | MPF 0.57+ (default) | MPF 0.50–0.56 (legacy) |
| --- | --- | --- |
| Header | `#show_version=6` | `#show_version=5` |
| Step key | `duration: 33ms` | `time: '+1'` |
| Playback | correct at default speed | needs `speed:` set to the frame rate |

Two things make this matter, both verified against the mpf 0.80.x source:

- **The header is checked for exact string equality.** `YamlInterface.load()`
  raises a version mismatch if the first line is not exactly `#show_version=6`,
  so a `=5` file does not load at all on 0.57+.
- **A bare number in a time is seconds, not frames.** `Util.string_to_secs()`
  appends `s` to any time string with no letters, so `time: '+1'` is one
  *second*. A 30 fps show written that way runs 30× slow.

Shows from the original tool carry both problems. `tools/check_show.py` reports
them and works out the real playback duration.

### Options

- **Layers add in** — *Linear light* (default) converts before adding, which is
  how real LEDs combine; *sRGB* adds the encoded bytes like the original tool.
  Two overlapping 50% greys give 176 in linear and a blown-out 255 in sRGB.
- **Write to** — `exports/`, or any machine folder. The app scans likely places
  for folders containing `config/config.yaml`; **Browse for a folder…** finds
  the rest. A destination with a `config/` receives shows in its `shows/`.
- **Colour** — full colour, cut dark values, or black & white with a threshold
- **Sample radius** — `0` is a single pixel like the original; `2–3` is smoother
- **Gamma** / **Minimum lit level** — lift dim pixels so faint edges register
- **Only changed lights per step**, **Write `stop` for black**, **Fade (ms)**
- **Trim dark frames** — trailing by default. Trimming the *start* shifts every
  cue earlier, which desynchronises a show cut to audio, so it is off and the
  dialog tells you how far things moved.
- **Idle steps** — restate previous colours (default), merge into the next step,
  or write a bare time-only step as the original tool did.

### Validating

```bash
python tools/check_show.py exports/my_show.yaml
```

It replicates the checks MPF 0.80 actually performs — first-line version
equality, `duration:`/`time:` handling, zero-duration steps, mixing step keys,
and an empty `lights:` block (which MPF reads as `lights: null` and refuses) —
and reports real playback length. `--show-version 5` checks a legacy file on its
own terms.

---

## Folders

| Folder | What's in it |
| --- | --- |
| `web/` | The app (HTML/CSS/JS modules) |
| `lightmaps/` | `monitor.yaml` positions and `lights.yaml` tags |
| `shapes/` | PNG images usable as shapes |
| `backgrounds/` | Playfield images used as a tracing guide |
| `imports/` | MPF shows brought in for reuse |
| `shows/` | Saved projects, as JSON |
| `exports/` | Generated MPF show YAML |
| `tools/` | `check_show.py`, a validator for generated shows |

`config.json` remembers your light map, tags file, playfield image and export
destination. None of these folders are committed — they describe your machine,
not the app.

---

## Notes

- Preview and export run through the same render and sampling code, so what you
  see is what you get.
- The playfield renders at a fixed internal resolution, so exports are
  deterministic regardless of window size.
- Projects are plain JSON in `shows/` — easy to diff or hand-edit.
- Sampling walks layers one at a time rather than reading one composited frame.
  That is what makes linear accumulation, tag masks and show layers possible.
- The original tool's `sets/` and `segments/` `.txt` files are not imported; the
  keyframe model has no equivalent for their two-point format.

---

## Credits

A rebuild of the original BlitzMax show creator by **Mark Incitti**:
<https://github.com/missionpinball/showcreator>. That tool established the idea
this one is built on and was the reference throughout.

The 31 PNGs in `shapes/` are Mark's, used with his permission — see
[`shapes/README.md`](shapes/README.md).

## Licence

MIT — see [`LICENSE`](LICENSE). Use it, change it, ship it; keep the copyright
notice, and note there is no warranty.

**One exception:** the shape images in `shapes/` are not covered by the MIT
grant. They come from the original repository, which carries no licence of its
own, and are included by permission. If you redistribute a fork, either seek
permission separately or delete that folder — the built-in shapes are drawn in
code and do not depend on it.
