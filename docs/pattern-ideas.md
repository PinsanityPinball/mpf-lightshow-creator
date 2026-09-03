# Pattern ideas

Planning only — **nothing here is implemented**. These are candidates for the
next round of light patterns, written up so the good ones can be picked out
before any code is written.

The bar every one of these has to clear: it should be something you could not
reasonably write by hand in YAML, and it should read well on a *sparse* playfield
where lights are scattered rather than laid out in a neat grid. Existing patterns
that do this best — Wave, Stack, Fire, Plasma — all work off the real light
positions or off noise. The weakest are the ones that just index the light list.

Current set, for reference: Blink, Chase, Marquee, Sparkle, Wave, Stack, Fire,
Pinwheel, Scanner, Rain, Plasma, Solid.

---

## Strong candidates

### 1. Contagion / spread

One light lights up, then infects its nearest neighbours, then theirs, until the
whole group is lit. A flood fill across the actual light positions.

**Why it is worth doing.** It follows the *shape of your playfield* rather than a
straight line or a circle — light spreads through a ramp, around an orbit, into a
pocket of lights, in whatever order they physically sit. Nothing else in the set
does that, and it is impossible by hand because it depends on which lights happen
to be near which.

**How.** Build a neighbour graph once per light map (each light joined to those
within a radius, or its k nearest). Breadth-first from a seed light, recording
each light's hop distance; brightness follows `t/speed - hops`. Cache the graph
on the lights array identity, the way `targetBounds` already does.

**Controls.** Seed (a light name, a tag, or "nearest to a point"), spread speed,
trail (do lights stay lit or fade behind the front), neighbour radius.

**Risks.** A scattered map can have isolated lights that never get infected —
needs a fallback so they light eventually. Graph build is O(n²) at 435 lights,
which is fine once but must not run per frame.

---

### 2. Comet / trail with real physics

A point moving under simple physics — thrown from an edge with a velocity,
pulled by gravity, bouncing off the playfield walls — with lights lighting as it
passes and fading behind it.

**Why.** The motion is *pinball* motion. A ball arcing up a ramp and falling back
looks like the machine, and it is genuinely tedious to keyframe: you would be
hand-placing a parabola.

**How.** Integrate position per frame from `(vx, vy, gravity)`, deterministic
from the layer seed. Light each light by proximity to the current point, with a
decaying trail buffer.

**Controls.** Launch angle and speed, gravity, bounce damping, trail length,
number of comets.

**Risks.** Needs a per-frame integration that is *stateless* to stay
deterministic — the position at time `t` must be computable directly, not by
stepping from the last frame, or preview and export will drift apart. Closed-form
for a parabola with bounces is doable but fiddly; that is the real cost.

---

### 3. Sweep by tag order

Lights up whole tag groups in sequence — `left_ramp`, then `centre`, then
`right_orbit` — rather than individual lights.

**Why.** It is the natural way to describe a playfield-wide gesture, and it is
the one idea here that gets *easier* the more tags a machine has. Chase steps
light by light; this steps group by group, which reads far more clearly on a
sparse map than a single travelling dot.

**How.** Straightforward: an ordered list of tags, a dwell time per group, and an
overlap/crossfade amount. No geometry at all.

**Controls.** The tag order (drag to reorder), dwell, crossfade, whether groups
stay lit or hand off.

**Risks.** Almost none — this is the cheapest thing on the list. The design work
is the tag-ordering UI, not the renderer.

---

## Worth considering

### 4. Breathing / heartbeat

Whole-group brightness on a shaped curve — a double-thump heartbeat, or a slow
asymmetric breath (quick in, slow out) rather than a sine.

Honest assessment: **this one is borderline**, because a fade is exactly what
keyframes already do well. It earns its place only if the curve is the point —
a real double-beat is annoying to keyframe and trivial as a pattern. Consider
folding it into Solid as a "pulse shape" option instead of a new pattern.

### 5. Interference / moiré

Two Wave fields at slightly different wavelengths, multiplied. Produces slow
travelling beat patterns that look nothing like either wave alone.

Genuinely unhand-writable and very cheap to build (Wave already does the hard
part). The risk is that on a sparse playfield the beats may be too fine to read —
worth prototyping against the real light map before committing.

### 6. Voronoi / territory

Each of N seed points owns the lights nearest to it; seeds drift, so lights
change allegiance and flip colour as the boundaries sweep across them.

Striking on a dense map, and completely impossible by hand. But it wants a lot of
lights to read as territory rather than as noise — likely the weakest fit for a
playfield of a few hundred scattered lights, despite being the most novel.

---

## Rejected, and why

| Idea | Why not |
| --- | --- |
| **Ripple** (expanding rings) | Built it, dropped it — it is Wave with discrete fronts, and read as the same effect. |
| **Twinkle** | Sparkle with softer fades. Add a fade control to Sparkle instead. |
| **Strobe** | Blink with a short duty cycle. Already possible. |
| **Colour cycle** | A colour-mode option on any pattern, not a pattern. |
| **Text / scrolling letters** | Needs a dense regular grid; a pinball playfield is neither. |
| **VU meter / audio reactive** | Needs an audio pipeline the app does not have, and MPF shows are pre-rendered, so there is nothing to react to at export time. |

---

## Suggested order

1. **Sweep by tag order** — cheapest, and the most immediately useful on a
   machine that already has good tags.
2. **Contagion** — the most distinctive thing on the list, and the best argument
   for the app knowing where your lights physically are.
3. **Interference** — nearly free given Wave, worth a prototype to see if it
   reads.
4. **Comet** — the best-looking idea, but the determinism constraint makes it the
   most expensive; leave it until the cheap ones are done.
