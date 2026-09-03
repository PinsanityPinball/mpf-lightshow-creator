# Transitions

> **Status: tier 1 shipped.** Fade, Dissolve, Wipe, Iris and Split all
> work, on shape, pattern and imported-show layers alike, and default to None -
> a layer with no transition carries no transition field at all, so existing
> shows reload and render byte-identically. Verified by rendering
> `attract300.json` (3,750 layers) at eight points across its 300 seconds
> before and after the change: all eight signatures matched.
>
> **Not built yet: tier 2** - Flip, Push and Doors, which need the layer
> transformed before it is sampled rather than only masked.
>
> **The auto-blend rule has no trigger yet.** It was written for Doors and
> Flip, where the top layer has to hide what is beneath. Every tier-1
> transition masks *itself* rather than uncovering a neighbour, so it reads
> correctly on Add and on Normal, and switching someone's blend for it would be
> a change with no benefit. The rule stands; it lands with tier 2.

The ask was PowerPoint-style transitions — wipe, dissolve, iris, doors, flip —
placed *in between* two layer items. The effects are worth having. The
in-between placement is not, and this plan explains why and what replaces it.

---

## Why not "between two layers"

PowerPoint transitions work because slides are mutually exclusive and
sequential. Exactly one is on screen, so "what was" and "what's next" are
unambiguous, and the transition owns the whole screen for its duration.

Layers here are simultaneous and additive. Measured on `attract300.json`:

| | |
|---|---|
| Layers | 3,750 |
| Live at any instant, mean | **62.8** |
| Live at any instant, peak | **128** |
| Moments in 300s with nothing running | **0** |

There is no "between". At every instant of that show, roughly sixty layers are
mid-flight. A transition anchored between A and B has no answer for the other
sixty-one: PowerPoint would cover the screen, but those layers have to keep
running.

The second problem is anchoring. A between-object needs two endpoints that stay
put, and these do not:

- **Instancing.** `layer.at: [ms, ...]` fires one layer at many times —
  `attract300c.json` has 291 firings of a single gesture. Which firing owns the
  transition?
- **Repeats and ping-pong** multiply that again.
- Move A, delete A, or drag B so they are no longer adjacent, and the object
  between them is orphaned.

---

## The model: In and Out belong to a layer

A transition becomes **a treatment on one layer**: how it arrives, and how it
leaves. "A transition between A and B" is then "A has an Out and B has an In",
which is exactly what a crossfade already is in this app.

Everything above dissolves. The treatment travels with the layer, so instancing,
repeats, moves and deletes need no special handling — every firing gets the same
In and Out. It composes with tag masks and blend modes because it sits inside
the per-layer sampling loop that already applies both.

It is also strictly more expressive than the PowerPoint version:

- **In and Out can differ.** Iris in, wipe out. PowerPoint applies one
  transition per slide boundary.
- **A lone layer can still transition.** PowerPoint cannot transition from
  nothing; here a layer with nothing before it can still iris in.
- **Cover works properly.** Layers accumulate, so the layer underneath can stay
  lit rather than being destroyed.

---

## How it renders

Two tiers. Most transitions need only the first.

### Tier 1 — coverage mask

The per-layer sampling loop in `web/js/render.js` already computes two things
per light:

```js
const mask = layerMask(layer, lights);   // per-light 0/1, from tags
const alphaScale = ...;                  // one number, from the keyframe
for (let i = 0; i < lights.length; i++) {
  if (mask && !mask[i]) continue;
  const cx = lights[i].x * this.w;       // position is right here
```

A transition is that mask turned from **boolean into a float**, computed from
`lights[i].x`, `lights[i].y` and the layer's local progress, then folded into
`alphaScale` per light instead of applied as one scalar.

Every separable transition is then one small function of `(x, y, p)`:

| Transition | Coverage |
|---|---|
| Fade | `p` |
| Wipe | `clamp((p - x) / soft)` — any axis, or by angle |
| Iris / Box / Circle | same, on distance from the centre |
| Split | `abs(x - 0.5) > p / 2` |
| Dissolve | `seededRandom(i) < p` |

Blend modes, `erase`, averaging, tag masks, instancing and determinism all live
*outside* that loop, so they are untouched and compose for free. A wipe on a
layer restricted to `strip_odd` wipes only those lights, correctly, with no
extra work.

### Tier 2 — render-time transform

A mask can remove coverage but not *move* it. Three transitions need the layer
transformed before it is sampled:

- **Flip** — animate scaleX 1 → 0 on the way out, 0 → 1 on the way in. The app
  already has sizeX/sizeY keyframes, so this is a preset that writes existing
  keys rather than new renderer code.
- **Push** — translate. The motion path machinery already does this.
- **Doors** — draw the layer twice, clipped to each half, each offset outward.
  This one is genuinely new, but small, and the renderer already applies
  transforms for size, orientation and paths.

---

## The catalogue

| PowerPoint | Tier | Verdict |
|---|---|---|
| Fade, Dissolve | 1 | Yes |
| Wipe, any direction | 1 | Yes |
| Iris / Box / Circle / Split | 1 | Yes |
| Cover / Uncover | 1 | Yes — better here, the layer below survives |
| Blinds, Bars, Checkerboard | 1 | Built, then cut - see *taste* below |
| Flip | 2 | Yes, via scaleX — no perspective |
| Push | 2 | Yes, approximated — see *matched durations* |
| Doors | 2 | Yes, needs the two-clipped-halves draw |
| Cube, Vortex, Ferris wheel | — | No: needs depth ordering across faces |
| Morph | — | No: needs element correspondence between slides |

---

## Three things that will bite

### Occlusion, and therefore blend mode

Doors and Flip are *reveals*, and a reveal only reads as one if the top layer
hides what is under it. That works — the `normal` branch of the composite is
real alpha compositing:

```js
const inv = 1 - cov;
accum[j] = accum[j] * inv + (sr / sa) * cov;
```

Where the layer fully covers a light it replaces what is beneath; where it
partly covers, it mixes. But pattern layers default to `blend: 'add'`, where
nothing is ever hidden — and on `add`, Doors degrades into "two halves drift
apart" over a layer that was visible the whole time. Pleasant, but not the
effect anyone pictures.

**Settled:** choosing one of these sets the layer to `normal`. See
[Decisions](#decisions).

### Export cost

The exporter emits only the lights that *changed* in each step. A transition is
by definition "change many lights slightly, every frame", which defeats exactly
that compression. Measured, two static colour washes over 435 lights, 4 seconds
at 20fps:

| | Steps | YAML |
|---|---|---|
| Hard cut | 2 | 25 KB |
| Crossfade | 80 | **1,009 KB** |

**40×.** The same crossfade on an already-*moving* layer cost 15%, because
delta encoding was already defeated there — so the cost falls almost entirely on
static layers, which is precisely where transitions are most tempting.

This cost already exists for today's fades. What a transitions feature adds is
the invitation to use them everywhere. The export dialog already reports stats;
it should warn when transitions push the step count past a threshold.

### Taste

Blinds and checkerboard assume a dense rectangular grid. This playfield has 435
irregular positions. Voronoi was built and removed for exactly this reason — see
[`pattern-ideas.md`](pattern-ideas.md).

**Confirmed, and Blinds is gone.** It was built, looked at, and read as noise
rather than as slats. Checkerboard would fail the same way and is not worth
building.

---

## Fitting what is already there

- **Fades are the same feature.** `setFades()` in `project.js` and the *Fade in*
  / *Fade out* checkboxes are a crossfade already. The transition control should
  replace them, not sit beside them — two ways to do one thing is how the
  preset/dropdown label mismatch happened.
- **`erase` blend is a mask** and **Contagion is a dissolve** across the light
  graph. Reuse rather than reimplement.
- **Dissolve must be seeded** with the existing `seedKey` / `mulberry32`
  machinery, or preview and export will disagree.
- **Where the UI goes.** The fade checkboxes currently live on the **Motion**
  pane, not Timing, which is arguably already wrong. If transitions replace
  them, that is the moment to move them to Timing.
- **Adding a step is a one-line change.** `web/js/steps.js` is the shared list
  the wizard and the Layer panel both build from, so a new step or control
  appears in both. Section 4 of `/selftest.html` checks that parity
  automatically.

---

## Build order

1. ~~Tier 1 mask plumbing — float coverage folded into `alphaScale`.~~ Done.
2. ~~Fade and Dissolve on it.~~ Done, and determinism holds: a seeded dissolve
   renders identically twice and survives a save/reload. The fade checkboxes
   were **left in place** - removing a working control before its replacement
   has been used in anger seemed the wrong order. Unifying them is the next
   tidy-up, not a blocker.
3. ~~Wipe and Iris~~, plus Split. Done.
4. ~~Export-cost warning.~~ Done: the export dialog says so when a show with
   transitions comes out over 400 kB.
5. Flip and Push, as presets over existing size and motion keys.
6. Doors — the clipped two-halves draw.
7. ~~Blinds and checkerboard last, on the real machine, kept only if they
   read.~~ Blinds was built and cut: it read as noise on scattered lights,
   exactly as the doubt below predicted.

---

## Decisions

Answered, so these are settled unless something in the build contradicts them.

**A reveal-style transition sets `blend: 'normal'` automatically.** Doors and
Flip only read as reveals under `normal`, so choosing one switches the layer.
Two riders: it must be part of the same undo step as choosing the transition,
and it must say so in the status line, because an additive glow layer turning
opaque is a large visual change to make silently. Removing the transition does
*not* switch the blend back - a silent revert is worse than a change you were
told about.

**In and Out share one duration.** One control, both ends.

**Push writes both sides at once - as a one-time action, not a live link.**
This is the one answer that needs care. "Both sides" implies knowing who the
other side is, which is exactly the anchoring problem this model was chosen to
avoid: with ~63 layers live at any instant there is no "the next layer", and an
instanced partner has no single firing to pair with. So when Push is chosen the
user picks the partner, and the matching In is written onto it there and then,
with the same duration. Nothing persistent is created, so nothing is orphaned
when a layer moves or is deleted. Drift after a later one-sided edit remains
possible, and remains acceptable.

**Transitions extend the layer rather than eating into it**, and they extend it
*forwards*. A 2000ms layer with 300ms transitions runs 2600ms:

| | |
|---|---|
| In | `[start, start + 300]` |
| Body | `[start + 300, start + 2300]` |
| Out | `[start + 2300, start + 2600]` |

The start does not move. Extending backwards would push a layer sitting at 0ms
into negative time, and shows are meant to start at 0. "Start" keeps meaning
"when this begins to appear".

Consequences to handle: the layer's clip gets longer on the timeline the moment
a transition is added, and the show's total duration can grow with it.

---

## Open questions

- Should the transition list be one dropdown, or split by tier (mask effects
  versus ones that move the layer)?
- Is there a sensible maximum duration, given a transition longer than the body
  it decorates is probably a mistake?
- Should the export-cost warning be a threshold on total steps, or on how much
  transitions added over a hypothetical hard-cut version of the same show?
