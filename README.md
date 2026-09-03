# Show Creator

A light-show editor for home-brew pinball machines running MPF 0.50+.

This is a rebuild of the original BlitzMax `showcreator` tool. Same idea — draw
moving shapes over a playfield, sample what each LED sees, export an MPF show —
but with parametric shapes, a real timeline, and direct manipulation instead of
single-key commands.

---

## Running it

Double-click **`run.bat`**, or:

```bash
python server.py
```

It starts a local server on `http://127.0.0.1:8777` and opens your browser.
Python 3.8+ is the only requirement — no `pip install`, no build step.

### First run, from a fresh clone

The repo ships the app only. Anything that describes a *particular* machine is
deliberately left out (see `.gitignore`), so on a fresh clone you supply:

1. **A light map** — drop your MPF `monitor.yaml` into `lightmaps/`, then pick it
   from the **Map** dropdown. Without one the stage has no lights to sample.
2. **A tags file** *(optional)* — your machine's `lights.yaml`, also in
   `lightmaps/`, so layers can target tags rather than individual lights.
3. **A playfield image** *(optional)* — any PNG/JPG in `backgrounds/`.

`shows/`, `exports/`, `imports/` and `config.json` are yours too —
the server creates the empty folders on startup, so nothing needs setting up.

Useful flags:

```bash
python server.py --port 9000 --no-browser --verbose
```

### If it says it can't find Python

`run.bat` does not rely on Python being on your PATH. It tries the `py`
launcher, then `python`, then looks directly in the usual install folders
(`%LOCALAPPDATA%\Programs\Python\Python3xx`, `C:\Program Files\Python3xx`,
`C:\Python3xx`). It prints which interpreter it settled on.

If it still can't find one, Python is either not installed or is somewhere
unusual. You can always point it at a specific interpreter yourself:

```bash
"C:\path\to\python.exe" server.py
```

---

## Folders

| Folder         | What's in it                                                     |
| -------------- | ---------------------------------------------------------------- |
| `web/`         | The app (HTML/CSS/JS modules)                                     |
| `lightmaps/`   | `monitor.yaml` positions and `lights.yaml` tags                   |
| `shapes/`      | PNG images usable as shapes (copied from the original tool)       |
| `backgrounds/` | Playfield images used as a tracing guide                          |
| `imports/`     | MPF shows brought in for reuse                                    |
| `shows/`       | Saved projects, as JSON                                           |
| `exports/`     | Generated MPF show YAML                                           |
| `tools/`       | `check_show.py`, a validator for generated shows                  |

`config.json` remembers your light map, tags file, playfield image, export
destination and machine folder, and restores them next time you open the app.

---

## Show length and sample rate

These are two independent decisions, and since MPF 0.57+ output writes a real
duration onto every step, the sample rate no longer affects playback speed at
all.

- **Show length** (Show tab) is how long the show runs. Leave it at 0 to follow
  the layers, or set a fixed length. **Fit to** stretches or squeezes every
  layer so the whole show lands on a given length, keeping the composition
  intact.
- **Sample rate** (10–60 Hz) is purely smoothness versus file size. 30 Hz suits
  most shows.

### Choosing a rate

Whether a higher rate costs anything depends entirely on how much your lights
actually change, so the app measures it rather than guessing. **Measure cost of
each rate…** exports the show at every rate and reports real step counts and
file sizes, with a one-click switch.

Two effects worth knowing, both from measured output:

- **Smooth motion scales linearly.** A continuous sweep changes some light on
  every single frame, so doubling the rate roughly doubles the steps. A 2 s
  sweep went 20 steps at 10 Hz → 60 at 30 Hz → 120 at 60 Hz.
- **Held content is nearly free.** Consecutive identical frames merge into one
  longer step, so a strobe that settles between flashes cost the same 39 steps
  at 20, 30, 40 and 60 Hz.

The real hazard is sampling *too low*: a 10 Hz strobe sampled at 10 Hz collapsed
to a single step and vanished completely. If the advisor reports that doubling
the rate finds substantially more steps, the current rate is missing detail your
show contains.

---

## The Layer panel

The right-hand **Layer** panel is split into sub-tabs, so you are only ever
looking at one concern at a time. They are the **same seven steps the wizard
walks, in the same order** — learn one and you know the other:

| Tab / step | Holds |
|---|---|
| **Shape** | shape picker and its parameters |
| **Path** | path preset, turns, stretch, randomise start/end |
| **Motion** | position, orientation start/end, easing |
| **Size** | size presets, start/end scale, separate width and height |
| **Colour** | start/end colour, brightness, colour space |
| **Lights** | which lights this layer drives (all, or by tag), exclusions |
| **Timing** | start, duration, repeat, blend, show sample rate |

Both are generated from one list in `web/js/steps.js`, so they cannot drift
apart: renaming or reordering a step moves the wizard and the tabs together.
The start/end slider pair is shared code too, so a control behaves identically
in both places.

The layer's name and its on/off checkbox stay pinned above the tabs. Pattern and
imported-show layers are not built this way and get their own two-tab set.

**Roll** (beside Dup and Del) adds one random layer and leaves the rest of
your show alone. Click it as many times as you like, or undo.

New layers start at **0 ms**, not wherever the playhead is sitting — a show
should begin at the beginning.

## Light maps and tags

The light map is read once and held in memory. If you edit `lightmaps/*.yaml`
while the app is open, the reload button beside the Tags dropdown turns amber
and the status bar says so; the app also checks on window focus and every ten
seconds. Click it to re-read the map and tags from disk. Every cached mapping —
tag masks and imported-show light indexes — rebuilds against the new map.



Two files describe your machine, and both are remembered between sessions:

- **Map** — an MPF `monitor.yaml`, giving each light a normalised `x`/`y` plus
  optional `shape`, `size` and `rotation`.
- **Tags** — an MPF `lights.yaml`, giving each light its `tags:` list.

Pick both from the dropdowns in the top bar. A tags file is paired to a map
automatically by stem, so `mymachine_monitor.yaml` finds `mymachine_lights.yaml`
on its own.

### Using files where they already are

You do not have to copy anything into `lightmaps/`. Both dropdowns end with
**Browse for a file...**, which opens a file browser; pick your machine's
`monitor.yaml` and `lights.yaml` wherever they live and the app reads them in
place. The absolute path is remembered, so they stay in the dropdown next time,
listed under *Elsewhere on disk* as `monitor.yaml - <folder>` so a file that
shares its name with one in `lightmaps/` is still distinguishable.

Reading in place is the point: a copy goes stale the moment you edit the real
one. Because the app holds the path rather than a duplicate, the freshness check
still notices when the file changes on disk and offers to reload it.

Stem-pairing works out there too - an external `monitor.yaml` looks for its
partner beside itself, not in `lightmaps/`. The browser also labels what it
finds, since a machine's `lights.yaml` and a `monitor.yaml` both open with a
light block: the one with per-light `x`/`y` is the *light map*, the one with
`tags:` is the *tags* file.

The browser is read-only and lists only folders and `.yaml`/`.yml` files.
Tags split on commas *and* whitespace, so a missing comma (`tags: all, 5x 4x`)
still yields separate tags instead of one unusable compound.

### Pattern layers: blinks and chases

Sampling a shape is the right tool for a sweep, but the wrong one for an on-off
show: you would have to position a shape over the lights you meant, and the
sampled colours come back as whatever the shape's edges happened to cover.

A **pattern layer** drives its tagged lights directly instead, with no shape and
no pixel sampling, so `FF0000` really is `FF0000`. Add one from **+ Layer →
Tagged patterns**:

- **Blink** — on for *N* ms, off for *M* ms. Off can be dark or a second colour.
- **Chase** — steps through the lights in order, with an adjustable number lit
  at once and a fading tail. Order by light name (natural, so `l_x_2` precedes
  `l_x_10`), top-to-bottom, left-to-right, or around the centre.
- **Sparkle** — *N* lights lit at once, picked at random from a palette,
  re-picked on a timer, with an optional fading trail.
- **Wave** — a brightness wave travelling across the real light positions, up
  the playfield, across it, or outward from the centre. Wavelength, cycle time,
  trough brightness and crest sharpness are all adjustable.
- **Stack** — divides the lights into a grid and fills it cell by cell, bottom
  up by default, blending between two colours as it climbs. Set it to *wipe* to
  light only the leading cell instead.
- **Solid** — one colour, which the keyframe brightness can still fade.

**Sparkle is random but repeatable.** It runs off a seeded generator keyed to
the step number, so the same show always produces the same sparkle — the
preview matches the export, and exporting twice gives byte-identical files.
Change the **Seed** to roll a different arrangement.

A 0.5 s blink on the `shot` tag exports as exactly what you would have written
by hand:

```yaml
#show_version=6
- duration: 500ms
  lights:
    l_center_left: 'FF0000'
    l_center_ramp: 'FF0000'
    ...
- duration: 500ms
  lights:
    l_center_left: stop
    ...
```

That is 75 sampled frames collapsed to 5 steps and 1.5 kB, because identical
consecutive frames merge into one longer step.

Pattern layers stack with everything else — a blink on `shot` and a chase on
`story` can run at once, and either can sit under a sampled sweep. They draw
nothing on the playfield, so use the *Lights* or *Both* view to see them.

**One timing caveat.** The sampler can only switch on a frame boundary, so a
pattern time that is not a whole number of frames gets rounded: 120 ms at 30 Hz
actually lands on 100 ms. The panel tells you when that happens and suggests the
nearest exact value. Multiples of the frame period — 100, 200, 500 ms at 30 Hz —
land precisely.

### Animating a shape's own parameters

Position, rotation, scale, colour and brightness live on keyframes. A shape's
*own* parameters — an arc's span, a ring's thickness, a spiral's turns — start
out fixed for the whole layer, which is why a pie chart that fills was not
expressible.

Click the small diamond beside any shape parameter to animate it. The value
moves onto the keyframes, and from then on the slider writes to the keyframe
under the playhead exactly like dragging the shape does: scrub, adjust, repeat.
Click the diamond again to freeze it back to a single value.

An arc with an animated **Span** going 1° to 360° is a pie chart filling. A ring
with an animated **Thickness** grows. A spiral with animated **Turns** unwinds.
The shape's bounding box follows the animated values, so a shape that grows is
never clipped at its old size.

Switching shape type clears any animation, since the old shape's parameters do
not exist on the new one.

---

## Adding a layer

The app opens with an empty show, and **New** clears back to one — nothing is
created that you did not ask for. The big **+ Add layer** button, and the empty
state that greets you, both lead to the same five choices:

- **Build it step by step** — the wizard, with a live preview
- **Start from a preset** — sweeps, spins, chases, blinks, sparkles
- **Import an MPF show** — stack an existing show with new layers
- **Surprise me** — add one random layer (same as the Roll button)

`Ctrl+N` opens the same chooser.

---

## Building a layer step by step

Each step leads with a few obvious choices. Everything else — every slider,
every fine adjustment — is folded away behind **Advanced options**, closed by
default and remembered per step while the wizard is open. The steps were a wall
of sliders otherwise, which buried the choices that actually matter.

Any setting that can animate shows a single slider and a **changes** toggle.
Off, it is one value for the whole clip and there is nothing else to look at;
on, the end slider appears and the value animates from start to end. Shape
parameters, size and colour all work this way.

**Easing** appears on every step that animates something — Shape, Path, Motion,
Size and Colour. It is one setting for the layer shown in several places, not a
separate easing per property: "how should this move" comes up wherever you are
adjusting, not only on the Motion step.

**Fade in** and **Fade out** are checkboxes, not one-way buttons, so you can
turn them back off. Turning both on keeps a bright middle — with only the two
default keyframes a layer would otherwise interpolate from black to black and
vanish entirely, so a middle keyframe at full brightness is added.

**Wizard** (on the timeline toolbar, and inside + Layer) walks a new layer
through seven steps, with a live preview of it running against your real light
map beside every one:

1. **Shape** — the shape tiles, then a **start and end value for every one of
   that shape's parameters**
2. **Path** — how it travels (**None** by default, so it stays put until you
   give it somewhere to go), then centre, size, **stretch**, loops, off-screen
   margin, mirrors and randomisers
3. **Motion** — whole turns, then a start and end **orientation** in degrees,
   exact rotations, easing, rotate-and-grow. Shapes that look the same at every
   angle (circle, ring, glow) say so instead
4. **Size** — XS to XL, whether it stays/grows/shrinks, and whether width and
   height move together, then exact start and end values for each axis
5. **Colour** — a palette, whether it holds one colour or fades to another,
   then fill mode, exact start and end colour, and hue tweening
6. **Lights** — every light or a common tag, then the full tag list, match
   rules, invert and exclusions
7. **Timing** — a length, then name, start, repeat, ping-pong, hold, blend, and
   the whole show's **sample rate in Hz**

### Stretch

The playfield is roughly twice as tall as it is wide, so a circle that looks
round only covers about 35% of the height. Left at that, a spiral or figure-8
sits in a flat band across the middle and wastes the tall space.

**Stretch** scales a path's vertical extent without touching its width, so the
same spiral can go from 64% x 29% to 64% x 76%. The path step reports what the
current settings will actually cover, and says when part of the path runs off
the playfield.

### Start and end

Shape parameters, size and colour all take a **start** and an **end**. Leave both
the same and the value is fixed for the whole layer; make them differ and it
animates across the clip, spread by keyframe time so a 25-point path ramps
smoothly rather than jumping at the last keyframe.

That is how an arc becomes a pie chart that fills (span 1° → 360°), a ring
grows, or a shape fades from red to blue. Each row has a **static / start → end**
toggle if you would rather flip it than drag two sliders.

Width and height are independent, so a shape can stretch sideways while keeping
its height, or squash as it travels. They stay locked together until you ask for
"Separate width & height", since matching is what you usually want.

Whole-number settings — Stripes/Count, Star/Points, Dot ring/Count — snap to
integers however you reach them, whether by dragging or typing.

The preview has **play/pause and a scrubber** — pause it while you read the
controls and it stays paused for the rest of the session, including when you
reopen the wizard.

Every step is the same shape: obvious choices at the top, full control beneath.
The breadcrumbs jump between steps in any order, and **Create layer** is
available at any point — you never have to walk all seven.

The layer it produces is an ordinary layer, so everything afterwards (dragging
on the playfield, the timeline, animated shape parameters) works on it exactly
as usual.

Pattern layers — blink, chase, sparkle, wave, stack — are not in the wizard;
they have a single panel already and their own one-click presets.

---

## Motion paths, transforms and randomisers

Each path declares which settings it actually reads, and the wizard shows only
those. A circle has no loops to set and a straight sweep has no size, so those
sliders are simply absent rather than present and inert. What was one vague
**Loops** slider is now named for the path it belongs to: *Turns* on a spiral,
*Zig-zags* on a zig-zag, *Bounces* on a bounce.

**Centre X/Y** and **Stretch** are gone. Position is easier to set by dragging
the shape on the playfield afterwards, and stretch existed only to work around
a scaling quirk: the playfield is about twice as tall as it is wide, so a path
at "size" *r* reached *r* across but only *r*/2 up, and even at maximum size a
spiral stopped well short of the top edge. Size now means the same thing on both
axes, so its maximum genuinely reaches the playfield edges.

The **Motion path** section of the Layer tab rewrites where a shape travels:
circle, infinity, spiral, zig-zag, diagonal, down-and-round, bounce, straight
up. A path replaces only the x/y of the keyframes — colour, size, rotation and
any animated shape parameters are resampled from the layer as it was, so the
rest of your setup survives.

Below that are transforms that act on the keyframes you have: **mirror
left/right**, **mirror up/down**, **rotate and grow**, **rotate and shrink**,
**reverse direction**.

Then the randomisers. **Random start** drops the first keyframe somewhere in the
middle half of the playfield, so it begins on-screen. **Random exit** puts the
last keyframe just off one of the four edges, so it leaves cleanly. **Both**
does the pair.

**Size** offers five presets, XS through XL, applied to every keyframe. The
Keyframe tab carries the same five for sizing one keyframe on its own.

### Roll

The **Roll** button beside the layer buttons replaces the show with a random
one: a handful of presets with random colours, paths, sizes, start times, and a
tag target about a third of the time. It is a starting point to edit rather than
a finished piece, and it is a single undo away from whatever you had.

---

### Targeting a layer at tags

Every layer has an **Applies to** setting. Leave it on *Every light*, or switch
to *Only these tags* and pick from the tag chips — each chip shows how many
lights carry it. Match on **any** or **all** of the chosen tags, and optionally
**invert** to mean everything else.

Beneath the tag chips is a second row, **But never these**. Exclusions are
applied after the match, so combinations the tag list alone cannot express
become sayable — "every light except the strip", or "all the shot inserts but
not the ones that are also strip lamps".

Lights the selected layer can reach are ringed in orange on the playfield, so
you can see the scope while you work. This is what makes "radar sweep, but only
on the shot inserts" a two-click job rather than careful shape positioning.

---

## Importing existing MPF shows

**+ Layer → Import an MPF show** brings a show you already have in as a layer:
choose a `.yaml`, or pick one already sitting in `imports/`, `exports/`, or your
machine's `shows/` folder.

An imported show drives the lights it names, so you can stack it under new
shape layers, retime it by dragging its clip (stretching resamples it), repeat
or ping-pong it, and fade it with its keyframe brightness.

### When the light map changes

Imported shows are stored **by light name**, never by index, so a light that
simply *moved* keeps working with no action from you. For names that no longer
exist, each show layer has an **If a name is gone** setting:

- *Leave it unlit* — strict name matching.
- *Use the nearest light to where it was* — falls back to position.

Position fallback works because at import time the server records where each of
the show's lights sat, taking them from whichever light map names the most of
them. The Layer tab reports live coverage against the current map — matched by
name, matched by position, and any still unmatched, listed by name.

---

## Playfield image

**Show → Playfield image** loads a photo or render of your playfield to aim
effects against, with an opacity slider and a visibility toggle. It is a
tracing guide only: it is drawn on the preview and never reaches the sampler,
so it cannot affect exported colours.

---

## The model

A **show** contains **layers**. Each layer is one shape moving over time:

- a **shape** (parametric, or one of your PNGs) with live parameters
- a **clip** on the timeline — start time, length, repeat count, ping-pong
- a list of **keyframes**, each holding position, rotation, scale X/Y, colour
  and brightness, plus the easing curve used to reach the next keyframe

At export time every frame is rendered, each light samples the pixels underneath
it, and the result becomes a step in the show YAML.

Layers come in three kinds:

| Kind | What drives the lights |
| --- | --- |
| **Shape** | A parametric shape or PNG, sampled per light |
| **Pattern** | A blink or chase applied directly to tagged lights |
| **Show** | An imported MPF show, replayed on the lights it names |

Only shape layers have geometry on the playfield; the other two contribute
colours directly and are visible in the *Lights* view.

### What changed from the original

| Original                                  | Now                                                        |
| ----------------------------------------- | ---------------------------------------------------------- |
| 31 fixed PNGs                             | 15 parametric shapes with live parameters, plus the PNGs   |
| START and FINISH only                     | Any number of keyframes per layer                          |
| Linear interpolation only                 | 13 easing curves, including `hold` for hard blinks         |
| Keyboard-only, 10px click targets         | Drag/rotate/scale handles, sliders, colour pickers         |
| No timeline                               | Scrubbable timeline with draggable clips and keyframes     |
| `followprevious` chaining                 | Clips placed freely on a shared timeline                   |
| Single-pixel LED sampling                 | Adjustable sample radius, gamma, minimum level             |
| Idle frames written as bare `time:` steps | Trimmed or filled — output needs no hand-editing           |
| Fixed 30fps                               | 10–60 Hz, with measured cost per rate                      |
| Frame rate changed playback speed         | Rate is smoothness only; durations are in the file         |
| `#show_version=5`, rejected by MPF 0.57+  | `#show_version=6`, with a legacy option                    |
| `time: '+1'` (one second, needs speed: 30)| `duration: 33ms`, correct at default speed                 |
| No undo                                   | Undo/redo on everything                                    |
| Layers add in 8-bit sRGB                  | Linear-light addition, matching real LEDs                  |
| Shapes only                               | Imported MPF shows as layers too                           |
| Every layer hits every light              | Layers targetable by light tag                             |
| Sampled colours only                      | Pattern layers drive tagged lights at exact colours        |
| Bare dot-scatter playfield                | Optional playfield image underlay                          |

---

## Shapes

Shapes with a **Filled** checkbox switch between solid and outline freely. The
outline-width slider only sets how thick the outline is; it no longer decides
whether there is one, which previously made the checkbox one-way — once you had
set a width you could never fill the shape again.

Every shape is drawn as an alpha mask and then tinted, so feathering, gradients
and rainbow fills work the same way on all of them.

The picker shows the eight that read well on sparse pinball lights:

**Bar, Circle, Triangle, Square, Arc/Pie, Glow/Halo, Star, Cross/Burst**

**Show more shapes** reveals the rest — Ring, Radar sweep, Polygon, Chevrons,
Stripes, Dot ring, Spiral, Wave, Beam and PNG image. Nothing was removed, so
older shows that use them still load and render exactly as before.

**Filled or outline.** Circle, Triangle, Square, Star and Polygon take a
**Filled** checkbox with an outline width beneath. An unfilled circle is a ring,
an unfilled square is a frame, and so on.

Each has its own parameters (thickness, span, point count, edge softness, taper,
trailing fade…), so one shape covers what used to need a dozen separate images.

Colour fill can be **solid**, a **two-colour gradient**, or a **rainbow** sweep.
Colour tweening between keyframes runs through RGB or through HSL hues.

---

## Working in it

**Playfield**

- Click a shape to select it; drag to move it
- Blue corner handle scales, orange handle above rotates
- `Shift` while dragging moves every keyframe together; `Shift` while rotating
  snaps to 15°; `Shift` while scaling keeps it uniform
- Hover any light to see its name and current colour
- **Auto-key** (on by default): dragging writes to the keyframe under the
  playhead, creating one if it isn't there yet

**Timeline**

- Drag a clip to move it, drag its edges to retime it
- Drag keyframe diamonds to retime them; double-click a clip to add one
- `Alt` while dragging disables frame snapping
- Wheel scrolls, `Shift`+wheel pans, `Ctrl`+wheel zooms
- Drag layer names to reorder

**Rotations.** The Layer tab takes a number of whole turns rather than degrees,
with one-click buttons for the common counts and negatives for the other
direction. Turns are spread across the clip by keyframe *time*, so unevenly
spaced keyframes still spin at a constant rate rather than lurching between
them.

**Undo** covers everything, including sliders and colour pickers. A continuous
drag on one control folds into a single undo entry rather than one per pixel of
movement; pausing, or moving to a different control, starts a new entry.

**Views** — *Both*, *Shapes*, or *Lights*. **Lights** shows only what the
machine will actually do. **Onion** ghosts every keyframe at once; **Path** draws
the motion path including easing.

### Keyboard

| Key | Action | | Key | Action |
| --- | --- | --- | --- | --- |
| `Space` | Play / pause | | `K` | Add keyframe |
| `←` `→` | Step one frame (`Shift` = 10) | | `Del` | Delete keyframe |
| `↑` `↓` | Previous / next layer | | `Ctrl+Z` | Undo |
| `Home` `End` | Start / end | | `Ctrl+Shift+Z` | Redo |
| `1` `2` `3` | Both / Shapes / Lights | | `Ctrl+S` | Save |
| `L` | Toggle lights-only | | `Ctrl+N` | Add layer |
| `O` | Toggle onion skin | | `Ctrl+D` | Duplicate layer |

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

Play it at the default speed — the durations are explicit, so the timing is
already correct. Step durations are derived from the cumulative timeline rather
than rounded individually, so 30 fps alternates 33/33/34 ms instead of drifting
10 ms per second.

### MPF version targets

The show format changed after MPF 0.56, and the **MPF version** setting in the
Export tab picks the dialect:

| | MPF 0.57+ (default) | MPF 0.50–0.56 (legacy) |
| --- | --- | --- |
| Header | `#show_version=6` | `#show_version=5` |
| Step key | `duration: 33ms` | `time: '+1'` |
| Playback | correct at default speed | needs `speed:` set to the frame rate |

Two things make this matter, both verified against the mpf 0.80.x source:

- **The header is checked for exact string equality.** `YamlInterface.load()`
  reads the first line and raises a version mismatch if it is not exactly
  `#show_version=6`, so a `=5` file does not load at all on 0.57+.
- **A bare number in a time is seconds, not frames.** `Util.string_to_secs()`
  appends `s` to any time string containing no letters, so `time: '+1'` is one
  *second*. A 30 fps show written that way runs 30× slow unless it is played
  with `speed: 30`.

If you have shows produced by the original tool, they carry `#show_version=5`
and `+1` steps and will not load on MPF 0.57+ as-is. `tools/check_show.py`
reports both problems and works out the real playback duration.

Options in the **Export** tab:

- **Layers add in** — *Linear light* (default) converts to linear before adding,
  which is how real LEDs combine; *sRGB* adds the encoded bytes the way the
  original tool did. Two overlapping 50% greys give 176 in linear and a blown-out
  255 in sRGB — the linear figure is what the hardware will actually produce.
- **Write to** — a dropdown of destinations: this app's `exports/` folder, every
  machine folder you have picked before, and any found automatically. Anything
  else goes in through **Add a folder…**. See below.
- **Colour** — full colour, cut dark values, or black & white with a threshold
- **Sample radius** — `0` is a single pixel like the original tool; `2–3` gives
  smoother, less jittery output
- **Gamma** / **Minimum lit level** — lift dim pixels so faint edges still
  register on an LED
- **Only changed lights per step** — the diff behaviour the original used
- **Write `stop` for black**
- **Fade (ms)** — emit a `fade:` key per light
- **Trim dark frames at the start** — off by default. Removing leading silence
  shifts every cue earlier by that much, which silently desynchronises a show
  cut to audio or video. When it is on, the export dialog says how far
  everything moved.
- **Trim dark frames at the end** — on by default. Trailing silence carries no
  cues, so dropping it shortens the file without moving anything.
- **Idle steps** — what to do when a step changes nothing:
  - *Restate previous colours* (default) — every step has real content
  - *Merge into the next step* — emits `+N` instead of a run of `+1`
  - *Time-only step* — what the original tool wrote

That last option matters. The original emitted steps containing nothing but a
time; the finished shows on the machine (`cloud_dragon.yaml` and friends) contain
none of these, so they were being cleaned up by hand. The default here avoids
producing them at all.

You can write to `exports/`, download the file, or copy it to the clipboard.

### Where shows are written

The **Write to** dropdown in the Export tab lists:

- **This app: exports folder** — the default, `exports/` next to `server.py`.
- **Folders you have used before**, remembered in `config.json`.
- **Machines found nearby**, marked `(found)`. On startup the app scans a few
  likely places — the folder holding this app, your home folder, Documents,
  Desktop and the drive roots — two levels deep, for folders containing
  `config/config.yaml`. That file is what distinguishes a machine root from a
  mode folder, which also has a `config/` but names the file after the mode.
- **Add a folder…** for anything the scan missed. Paste a path; it is checked
  before being remembered, so a folder that does not exist is refused rather
  than silently stored.

Picking a `(found)` folder remembers it. **Forget this folder** removes it from
the list again. A destination with a `config/` subfolder receives shows in its
`shows/` subfolder; any other folder is written to directly. You are always
asked before an existing file is replaced.

Validate any generated show with:

```bash
python tools/check_show.py exports/my_show.yaml
```

It replicates the checks MPF 0.80 actually performs — first-line version
equality, `duration:`/`time:` handling, zero-duration steps, mixing the two step
keys, and an empty `lights:` block (which MPF reads as `lights: null` and
refuses) — and reports the real playback length in seconds. Pass
`--show-version 5` to check a legacy file on its own terms.

Worth running on anything before it goes near the machine:

```bash
python tools/check_show.py exports/*.yaml
```

---

## Light maps

Light positions are read from an MPF `monitor.yaml` — the same file the original
tool used. Pick one from the **Lights** dropdown, or use **Show → Import a
monitor.yaml…** to bring in a new one.

Each light may specify `x`, `y` (required, normalised 0–1) plus optional
`shape`, `size` and `rotation`:

```yaml
light:
  l_right_ramp:
    x: 0.503
    y: 0.721
    shape: diamond
    size: 0.05
    rotation: 0
```

Supported shapes for display: `circle` (default), `square`, `rectangle`,
`diamond`, `triangle`, `arrow`, `flipper`, `star`.

---

## Notes

- Preview and export run through the same render and sampling code, so what you
  see is what you get.
- The playfield renders at a fixed internal resolution, so exports are
  deterministic regardless of window size.
- Projects are plain JSON in `shows/` — easy to diff or hand-edit.
- The original tool's `sets/` and `segments/` `.txt` files are not imported; the
  keyframe model has no direct equivalent for their two-point format.
- Imported show layers contribute light colours directly and draw nothing, so
  they are invisible in the *Shapes* view. Use *Lights* or *Both* to see them.
- Sampling walks layers one at a time rather than reading one composited frame.
  That is what makes linear accumulation, tag masks and show layers possible.

---

## Credits

This is a rebuild of the original BlitzMax show creator by **Mark Incitti**:

> <https://github.com/missionpinball/showcreator>

That tool established the core idea this one is built on — draw shapes over a
playfield, sample what each LED sees, write an MPF show — and was the reference
throughout. If you are running MPF and want the original, it is still there.

The 31 PNGs in `shapes/` are Mark's, used with his permission. See
[`shapes/README.md`](shapes/README.md).

## Licence

MIT — see [`LICENSE`](LICENSE). Use it, change it, ship it; just keep the
copyright notice, and note there is no warranty.

**One exception:** the shape images in `shapes/` are not covered by the MIT
grant. They come from the original repository, which carries no licence of its
own, and are included here by permission rather than by licence. If you
redistribute a fork, either seek permission separately or delete that folder —
the built-in shapes are drawn in code and do not depend on it.
