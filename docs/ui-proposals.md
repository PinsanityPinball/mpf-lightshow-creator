# UI review

A pass over the whole interface looking for two things: what is unclear, and
what is rarely used and could be demoted. Split into what I changed (clear wins,
already committed) and what I did not (judgement calls, waiting on you).

---

## Changed already

| Change | Why |
| --- | --- |
| **Export panel folded** | It put 18 controls across 7 sections above the button you came to press. Blending, Sampling, YAML output and Dead frames are chosen once per machine, so they sit behind **Output settings** now: 4 visible controls, 18 when opened. |
| **"Target" → "Write for"** | The label sat under a heading already reading *MPF version*, so it said nothing. |
| **Marquee "Order by"** | Called top-to-bottom "Bottom to top". Straightforwardly wrong. |
| **Chase / Stack timing boxes** | With *Fit to layer length* on, the renderer ignores Step (ms) and Fill time (ms) — you could drag them and watch nothing happen. They now explain where the timing actually comes from. |
| **Wave: two checkboxes for one thing** | *Seamless loop* and *Fit to layer length* were ANDed, so each read as on while the other silently disabled it. Removed the duplicate. |
| **Pattern hint pointed at a control that does not exist** | It said "Pick tags under *Applies to* above"; the tag picker is on the **Lights** sub-tab and nothing is called "Applies to". |
| **Folder browser at "Places"** | *Use this folder* stayed armed with whichever folder you had navigated out of. |

---

## Proposed — needs your call

### 1. Blend option wording is inconsistent across four copies

The same dropdown appears in four places with three different phrasings:

- `Add (lights stack)` vs `Add (stacks with other layers)`
- `Normal (covers)` vs `Normal (overrides what is under it)` vs `Normal (overrides)`

**Proposal:** one shared list of option labels, used everywhere. I did not do
this because picking the wording is your call. My suggestion:

| Value | Label |
| --- | --- |
| `add` | Add — lights stack |
| `normal` | Normal — covers what is under |
| `average` | Average — mixes colours |
| `erase` | Erase — turns lights off |

### 2. An Erase shape *glows* in the Shapes view

The playfield canvas has no per-light accumulator to erase from, so an erasing
shape is drawn additively there — it appears as a bright shape while its own help
text says "Erase does not light anything". Only the **Lights** view is truthful.

**Proposal:** draw erasing shapes as a dashed outline with no fill on the Shapes
view, so they read as a mask rather than a light. Small change, but it is a
deliberate visual language decision.

### 3. "Visible before" is missing for pattern and imported-show layers

The renderer honours `holdBefore` for all three layer kinds and the timeline
draws it, but only the shape Timing pane offers the checkbox. Pattern and show
layers get "Visible after" only.

**Proposal:** add it, for consistency. Low risk; I left it because it is a
feature addition rather than a fix.

### 4. Rarely used, could be demoted

Ranked by how confident I am that they are rarely reached:

1. **Onion skin** and **Path** toggles in the view bar — useful occasionally
   while animating, permanently taking toolbar width. Could move into a small
   "View" popover with the Size slider.
2. **Speed** and **Zoom** in the transport bar — set once and left.
3. **Ping-pong** — a niche timing option sitting at the same level as Start,
   Length and Repeat.
4. **The Keyframe tab** — 30 controls, but only reachable when a keyframe is
   selected, and most of what it does can be done by dragging on the playfield.
   Not proposing removal, just noting it is the least-visited of the four tabs.

I did **not** touch any of these: hiding something you use daily is worse than
leaving a slightly crowded toolbar, and I cannot tell from the code which of
these you actually reach for.

### 5. The wizard's step list is not as safe as it looks

Both the wizard and the Layer sub-tabs build from `LAYER_STEPS`, so they cannot
show different steps. But the failure mode if a step is added without a matching
builder is silent: the wizard drops it (`.filter`) and the inspector falls
through to the Shape pane (`default:`). You would get a tab showing the wrong
content and no error anywhere.

**Proposal:** make both throw in development if an id has no handler. Cheap
insurance; not user-visible.

---

## Duplication worth cleaning up

Not user-visible, but it is the kind of thing that causes the next bug:

- `Inspector.fold()` and `Wizard.custom()` are near-identical collapsible
  implementations, sharing the same CSS classes. Should be one helper in `ui.js`.
- The Erase and Average help paragraphs exist as three verbatim copies each.
- `p.tailLen` is shared by Scanner and Rain, `p.color2` by Stack, Fire and
  Plasma, `p.axis` by Wave and Scanner. Harmless today — a layer is only one
  type — but switching a layer's pattern type silently carries values across.
