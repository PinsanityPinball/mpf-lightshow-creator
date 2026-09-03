/**
 * The canonical steps of building a shape layer.
 *
 * Two places show these: the wizard walks them in order, and the Layer panel
 * offers the same set as sub-tabs. They used to be declared separately and had
 * already drifted - the wizard had a Size step the panel folded into Shape - so
 * someone who learned the wizard then went looking for Size in the panel could
 * not find it. Both now build from this list, so adding, renaming or reordering
 * a step moves both at once.
 *
 * Pattern and imported-show layers are not built this way; they have their own
 * short tab sets in the inspector and no wizard.
 */
export const LAYER_STEPS = [
  { id: 'shape', title: 'Shape' },
  { id: 'path', title: 'Path' },
  { id: 'motion', title: 'Motion' },
  { id: 'size', title: 'Size' },
  { id: 'colour', title: 'Colour' },
  { id: 'lights', title: 'Lights' },
  { id: 'timing', title: 'Timing' },
];

export const STEP_IDS = LAYER_STEPS.map((s) => s.id);
