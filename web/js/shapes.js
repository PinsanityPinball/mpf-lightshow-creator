// Parametric shape library.
//
// Every shape draws into a scratch canvas as WHITE with varying ALPHA, inside a
// unit space where the shape's natural extent is roughly [-0.5, 0.5]. The
// renderer has already applied translate/rotate/scale, so drawing code never
// worries about position or size. Colour is applied afterwards by compositing
// paint through the alpha the shape leaves behind, which means feathering,
// gradients and rainbow fills all work identically for every shape.

const D2R = Math.PI / 180;

const W = (a) => `rgba(255,255,255,${a})`;

// Erase everything outside/according to a gradient. Safe because the scratch
// canvas only ever holds the single layer currently being drawn.
function applyAlphaMask(ctx, grad) {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = grad;
  ctx.fillRect(-4, -4, 8, 8);
  ctx.restore();
}

function hasConic(ctx) {
  return typeof ctx.createConicGradient === 'function';
}

// Radial alpha ramp from a solid core out to a soft edge.
function radialFeather(ctx, outer, feather) {
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, outer);
  const solid = Math.max(0, 1 - feather);
  g.addColorStop(0, W(1));
  g.addColorStop(solid, W(1));
  g.addColorStop(1, W(0));
  return g;
}

function polyPath(ctx, pts, close = true) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  if (close) ctx.closePath();
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  if (r <= 0) {
    ctx.rect(x, y, w, h);
  } else {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

// param helpers. B() declares a checkbox rather than a slider.
const P = (key, label, def, min, max, step) => ({ key, label, def, min, max, step });
const B = (key, label, def) => ({ key, label, def, type: 'bool' });

/** Outline width to use when a shape is set to outline rather than filled. */
function outlineWidth(p, fallback = 0.08) {
  return p.thick > 0 ? p.thick : (p.hollow > 0 ? p.hollow : fallback);
}

/** True when the shape should be drawn as an outline. */
function isOutline(p) {
  // The Filled checkbox is the answer whenever the shape has one. Treating a
  // non-zero `hollow` as "also outline" made the checkbox one-way: once you had
  // set an outline width you could never fill the shape again, because hollow
  // stayed above zero and kept forcing the outline branch. hollow is only a
  // width now - it decides how thick the outline is, not whether there is one.
  if (p.filled !== undefined) return p.filled === false;
  return p.hollow > 0;   // older shapes and saved layers with no filled flag
}

export const SHAPES = [
  {
    id: 'bar',
    label: 'Bar',
    group: 'Basic',
    common: true,
    params: [
      P('len', 'Length', 1.0, 0.02, 4, 0.01),
      P('thick', 'Thickness', 0.18, 0.01, 2, 0.01),
      P('feather', 'Edge softness', 0.0, 0, 1, 0.01),
      P('taper', 'End fade', 0.0, 0, 1, 0.01),
      P('round', 'Corner round', 0.0, 0, 0.5, 0.01),
    ],
    draw(ctx, p) {
      const w = p.len, h = p.thick;
      if (p.feather > 0) {
        const g = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
        const f = Math.min(0.499, p.feather / 2);
        g.addColorStop(0, W(0));
        g.addColorStop(f, W(1));
        g.addColorStop(1 - f, W(1));
        g.addColorStop(1, W(0));
        ctx.fillStyle = g;
      }
      roundRect(ctx, -w / 2, -h / 2, w, h, p.round);
      ctx.fill();
      if (p.taper > 0) {
        const g = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
        const t = Math.min(0.499, p.taper / 2);
        g.addColorStop(0, W(0));
        g.addColorStop(t, W(1));
        g.addColorStop(1 - t, W(1));
        g.addColorStop(1, W(0));
        applyAlphaMask(ctx, g);
      }
    },
  },

  {
    id: 'circle',
    label: 'Circle',
    group: 'Basic',
    common: true,
    symmetric: true,          // rotating it changes nothing
    params: [
      B('filled', 'Filled', true),
      P('thick', 'Outline width', 0.12, 0.01, 0.5, 0.01),
      P('feather', 'Edge softness', 0.0, 0, 1, 0.01),
    ],
    draw(ctx, p) {
      if (isOutline(p)) {
        // an unfilled circle is a ring
        const outer = 0.5;
        const w = outlineWidth(p, 0.12);
        const inner = Math.max(0.001, outer - w);
        const f = p.feather * w;
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, outer);
        const at = (r) => Math.max(0, Math.min(1, r / outer));
        g.addColorStop(0, W(0));
        g.addColorStop(at(Math.max(0.0001, inner - f)), W(0));
        g.addColorStop(at(inner), W(1));
        g.addColorStop(at(outer - f), W(1));
        g.addColorStop(1, W(0));
        ctx.fillStyle = g;
      } else if (p.feather > 0) {
        ctx.fillStyle = radialFeather(ctx, 0.5, p.feather);
      }
      ctx.beginPath();
      ctx.arc(0, 0, 0.5, 0, Math.PI * 2);
      ctx.fill();
    },
  },

  {
    id: 'triangle',
    label: 'Triangle',
    group: 'Basic',
    common: true,
    params: [
      B('filled', 'Filled', true),
      P('thick', 'Outline width', 0.1, 0.01, 0.4, 0.01),
      P('feather', 'Edge softness', 0, 0, 1, 0.01),
    ],
    draw(ctx, p) {
      const r = 0.5;
      const pts = [];
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
        pts.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
      polyPath(ctx, pts);
      if (isOutline(p)) {
        ctx.lineWidth = outlineWidth(p, 0.1);
        ctx.lineJoin = 'round';
        ctx.strokeStyle = W(1);
        ctx.stroke();
      } else {
        ctx.fill();
      }
      if (p.feather > 0) applyAlphaMask(ctx, radialFeather(ctx, 0.6, p.feather));
    },
  },

  {
    id: 'square',
    label: 'Square',
    group: 'Basic',
    common: true,
    params: [
      B('filled', 'Filled', true),
      P('thick', 'Outline width', 0.1, 0.01, 0.4, 0.01),
      P('round', 'Corner round', 0, 0, 0.5, 0.01),
      P('feather', 'Edge softness', 0, 0, 1, 0.01),
    ],
    draw(ctx, p) {
      roundRect(ctx, -0.5, -0.5, 1, 1, p.round);
      if (isOutline(p)) {
        ctx.lineWidth = outlineWidth(p, 0.1);
        ctx.lineJoin = 'round';
        ctx.strokeStyle = W(1);
        ctx.stroke();
      } else {
        ctx.fill();
      }
      if (p.feather > 0) applyAlphaMask(ctx, radialFeather(ctx, 0.75, p.feather));
    },
  },

  {
    id: 'ring',
    label: 'Ring',
    group: 'Basic',
    symmetric: true,
    params: [
      P('thick', 'Thickness', 0.12, 0.01, 0.5, 0.01),
      P('feather', 'Edge softness', 0.0, 0, 1, 0.01),
    ],
    draw(ctx, p) {
      const outer = 0.5;
      const inner = Math.max(0.001, outer - p.thick);
      const f = p.feather * p.thick;
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, outer);
      const at = (r) => Math.max(0, Math.min(1, r / outer));
      g.addColorStop(0, W(0));
      g.addColorStop(at(Math.max(0.0001, inner - f)), W(0));
      g.addColorStop(at(inner), W(1));
      g.addColorStop(at(outer - f), W(1));
      g.addColorStop(1, W(0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, outer, 0, Math.PI * 2);
      ctx.fill();
    },
  },

  {
    id: 'arc',
    label: 'Arc / Pie',
    group: 'Basic',
    common: true,
    params: [
      P('span', 'Span', 90, 1, 360, 1),
      P('thick', 'Thickness', 0.5, 0.01, 0.5, 0.01),
      P('feather', 'Edge softness', 0.0, 0, 1, 0.01),
      P('trail', 'Trailing fade', 0.0, 0, 1, 0.01),
    ],
    draw(ctx, p) {
      const outer = 0.5;
      const inner = Math.max(0, outer - p.thick);
      const half = (Math.min(360, p.span) / 2) * D2R;
      ctx.beginPath();
      if (p.span >= 360) {
        ctx.arc(0, 0, outer, 0, Math.PI * 2);
        if (inner > 0) ctx.arc(0, 0, inner, Math.PI * 2, 0, true);
      } else {
        ctx.arc(0, 0, outer, -half, half);
        if (inner > 0) ctx.arc(0, 0, inner, half, -half, true);
        else ctx.lineTo(0, 0);
        ctx.closePath();
      }
      ctx.fill();
      if (p.feather > 0) {
        applyAlphaMask(ctx, radialFeather(ctx, outer, p.feather));
      }
      if (p.trail > 0 && hasConic(ctx)) {
        const g = ctx.createConicGradient(-half, 0, 0);
        const frac = Math.min(360, p.span) / 360;
        g.addColorStop(0, W(1 - p.trail));
        g.addColorStop(Math.min(1, frac), W(1));
        g.addColorStop(1, W(1));
        applyAlphaMask(ctx, g);
      }
    },
  },

  {
    id: 'sweep',
    label: 'Radar sweep',
    group: 'Basic',
    params: [
      P('span', 'Tail length', 120, 5, 360, 1),
      P('thick', 'Thickness', 0.5, 0.02, 0.5, 0.01),
      P('feather', 'Edge softness', 0.3, 0, 1, 0.01),
    ],
    draw(ctx, p) {
      const outer = 0.5;
      const inner = Math.max(0, outer - p.thick);
      ctx.beginPath();
      ctx.arc(0, 0, outer, 0, Math.PI * 2);
      if (inner > 0) ctx.arc(0, 0, inner, Math.PI * 2, 0, true);
      ctx.fill();
      const frac = Math.min(360, p.span) / 360;
      if (hasConic(ctx)) {
        // The tail has to fall BEHIND the bright edge, and the layer rotates
        // towards increasing angle - so the tail runs backwards from angle 0,
        // not forwards. It used to fade forwards, which put the faint end in
        // front and the bright line at the back: a radar sweeping the wrong way.
        const g = ctx.createConicGradient(0, 0, 0);
        g.addColorStop(0, W(0));
        g.addColorStop(Math.max(0, 1 - frac), W(0));
        g.addColorStop(1, W(1));
        applyAlphaMask(ctx, g);
      }
      if (p.feather > 0) applyAlphaMask(ctx, radialFeather(ctx, outer, p.feather));
    },
  },

  {
    id: 'halo',
    label: 'Glow / Halo',
    group: 'Basic',
    common: true,
    symmetric: true,
    params: [
      P('falloff', 'Falloff', 2.0, 0.2, 6, 0.1),
      P('core', 'Core size', 0.1, 0, 0.9, 0.01),
    ],
    draw(ctx, p) {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 0.5);
      g.addColorStop(0, W(1));
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const a = t <= p.core ? 1 : Math.pow(1 - (t - p.core) / (1 - p.core), p.falloff);
        g.addColorStop(t, W(Math.max(0, a)));
      }
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 0.5, 0, Math.PI * 2);
      ctx.fill();
    },
  },

  {
    id: 'polygon',
    label: 'Polygon',
    group: 'Geometry',
    params: [
      P('sides', 'Sides', 6, 3, 20, 1),
      B('filled', 'Filled', true),
      P('hollow', 'Outline width', 0, 0, 0.4, 0.01),
      P('feather', 'Edge softness', 0, 0, 1, 0.01),
    ],
    draw(ctx, p) {
      const n = Math.max(3, Math.round(p.sides));
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        pts.push([Math.cos(a) * 0.5, Math.sin(a) * 0.5]);
      }
      polyPath(ctx, pts);
      if (isOutline(p)) {
        ctx.lineWidth = outlineWidth(p, 0.08);
        ctx.lineJoin = 'round';
        ctx.strokeStyle = W(1);
        ctx.stroke();
      } else {
        ctx.fill();
      }
      if (p.feather > 0) applyAlphaMask(ctx, radialFeather(ctx, 0.55, p.feather));
    },
  },

  {
    id: 'star',
    label: 'Star',
    group: 'Geometry',
    common: true,
    params: [
      P('points', 'Points', 5, 3, 16, 1),
      P('inner', 'Inner radius', 0.45, 0.05, 0.95, 0.01),
      B('filled', 'Filled', true),
      P('hollow', 'Outline width', 0, 0, 0.3, 0.01),
      P('feather', 'Edge softness', 0, 0, 1, 0.01),
    ],
    draw(ctx, p) {
      const n = Math.max(3, Math.round(p.points));
      const pts = [];
      for (let i = 0; i < n * 2; i++) {
        const r = (i % 2 === 0 ? 0.5 : 0.5 * p.inner);
        const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
        pts.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
      polyPath(ctx, pts);
      if (isOutline(p)) {
        ctx.lineWidth = outlineWidth(p, 0.06);
        ctx.lineJoin = 'round';
        ctx.strokeStyle = W(1);
        ctx.stroke();
      } else {
        ctx.fill();
      }
      if (p.feather > 0) applyAlphaMask(ctx, radialFeather(ctx, 0.55, p.feather));
    },
  },

  {
    id: 'cross',
    label: 'Cross / Burst',
    group: 'Geometry',
    common: true,
    params: [
      P('arms', 'Arms', 4, 2, 16, 1),
      P('thick', 'Arm width', 0.14, 0.01, 0.6, 0.01),
      P('inner', 'Inner gap', 0.0, 0, 0.45, 0.01),
      P('taper', 'Arm taper', 0.0, 0, 1, 0.01),
    ],
    draw(ctx, p) {
      const n = Math.max(2, Math.round(p.arms));
      for (let i = 0; i < n; i++) {
        ctx.save();
        ctx.rotate((i / n) * Math.PI * 2);
        const tipW = p.thick * (1 - p.taper);
        polyPath(ctx, [
          [p.inner, -p.thick / 2],
          [0.5, -tipW / 2],
          [0.5, tipW / 2],
          [p.inner, p.thick / 2],
        ]);
        ctx.fill();
        ctx.restore();
      }
    },
  },

  {
    id: 'chevron',
    label: 'Chevrons',
    group: 'Geometry',
    params: [
      P('count', 'Count', 3, 1, 12, 1),
      P('thick', 'Line width', 0.08, 0.01, 0.4, 0.01),
      P('spread', 'Spacing', 0.22, 0.02, 1, 0.01),
      P('angle', 'Angle', 60, 5, 175, 1),
      P('fade', 'Fade trailing', 0.0, 0, 1, 0.01),
    ],
    draw(ctx, p) {
      const n = Math.max(1, Math.round(p.count));
      const half = (p.angle / 2) * D2R;
      const arm = 0.5;
      ctx.lineWidth = p.thick;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const start = -((n - 1) / 2) * p.spread;
      for (let i = 0; i < n; i++) {
        const x = start + i * p.spread;
        const a = p.fade > 0 ? 1 - p.fade * (i / Math.max(1, n - 1)) : 1;
        ctx.strokeStyle = W(a);
        ctx.beginPath();
        ctx.moveTo(x - Math.cos(half) * arm, -Math.sin(half) * arm);
        ctx.lineTo(x, 0);
        ctx.lineTo(x - Math.cos(half) * arm, Math.sin(half) * arm);
        ctx.stroke();
      }
    },
  },

  {
    id: 'stripes',
    label: 'Stripes',
    group: 'Geometry',
    params: [
      P('count', 'Count', 4, 1, 24, 1),
      P('thick', 'Stripe width', 0.08, 0.01, 1, 0.01),
      P('spread', 'Spacing', 0.18, 0.02, 1, 0.01),
      P('len', 'Length', 1.0, 0.05, 4, 0.01),
      P('fade', 'Fade trailing', 0.0, 0, 1, 0.01),
    ],
    draw(ctx, p) {
      const n = Math.max(1, Math.round(p.count));
      const start = -((n - 1) / 2) * p.spread;
      for (let i = 0; i < n; i++) {
        const x = start + i * p.spread;
        const a = p.fade > 0 ? 1 - p.fade * (i / Math.max(1, n - 1)) : 1;
        ctx.fillStyle = W(a);
        ctx.fillRect(x - p.thick / 2, -p.len / 2, p.thick, p.len);
      }
    },
  },

  {
    id: 'dots',
    label: 'Dot ring',
    group: 'Geometry',
    params: [
      P('count', 'Count', 8, 1, 48, 1),
      P('radius', 'Ring radius', 0.4, 0, 0.5, 0.01),
      P('size', 'Dot size', 0.1, 0.005, 0.5, 0.005),
      P('arc', 'Arc span', 360, 5, 360, 1),
      P('fade', 'Fade trailing', 0.0, 0, 1, 0.01),
      P('feather', 'Dot softness', 0.0, 0, 1, 0.01),
    ],
    draw(ctx, p) {
      const n = Math.max(1, Math.round(p.count));
      const spanR = Math.min(360, p.arc) * D2R;
      const full = p.arc >= 360;
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0.5 : i / (full ? n : n - 1);
        const a = -spanR / 2 + t * spanR;
        const x = Math.cos(a) * p.radius;
        const y = Math.sin(a) * p.radius;
        const alpha = p.fade > 0 ? 1 - p.fade * (i / Math.max(1, n - 1)) : 1;
        ctx.save();
        ctx.translate(x, y);
        if (p.feather > 0) {
          const g = ctx.createRadialGradient(0, 0, 0, 0, 0, p.size / 2);
          g.addColorStop(0, W(alpha));
          g.addColorStop(Math.max(0, 1 - p.feather), W(alpha));
          g.addColorStop(1, W(0));
          ctx.fillStyle = g;
        } else {
          ctx.fillStyle = W(alpha);
        }
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    },
  },

  {
    id: 'spiral',
    label: 'Spiral',
    group: 'Curves',
    params: [
      P('turns', 'Turns', 2.5, 0.25, 8, 0.05),
      P('thick', 'Line width', 0.05, 0.005, 0.3, 0.005),
      P('inner', 'Inner radius', 0.02, 0, 0.45, 0.01),
      P('taper', 'Width taper', 0.6, 0, 1, 0.01),
      P('fade', 'Fade toward centre', 0.0, 0, 1, 0.01),
    ],
    draw(ctx, p) {
      const segs = Math.max(24, Math.round(p.turns * 48));
      const total = p.turns * Math.PI * 2;
      ctx.lineCap = 'round';
      for (let i = 0; i < segs; i++) {
        const t0 = i / segs;
        const t1 = (i + 1) / segs;
        const r0 = p.inner + (0.5 - p.inner) * t0;
        const r1 = p.inner + (0.5 - p.inner) * t1;
        const a0 = t0 * total;
        const a1 = t1 * total;
        const wid = p.thick * (1 - p.taper * (1 - t0));
        const alpha = 1 - p.fade * (1 - t0);
        ctx.strokeStyle = W(Math.max(0, alpha));
        ctx.lineWidth = Math.max(0.001, wid);
        ctx.beginPath();
        ctx.moveTo(Math.cos(a0) * r0, Math.sin(a0) * r0);
        ctx.lineTo(Math.cos(a1) * r1, Math.sin(a1) * r1);
        ctx.stroke();
      }
    },
  },

  {
    id: 'wave',
    label: 'Wave',
    group: 'Curves',
    params: [
      P('amp', 'Amplitude', 0.18, 0, 1, 0.01),
      P('freq', 'Cycles', 2, 0.25, 12, 0.25),
      P('thick', 'Line width', 0.07, 0.005, 0.5, 0.005),
      P('len', 'Length', 1.0, 0.1, 4, 0.01),
      P('phase', 'Phase', 0, 0, 360, 1),
      P('taper', 'End fade', 0, 0, 1, 0.01),
    ],
    draw(ctx, p) {
      const segs = 96;
      ctx.lineWidth = p.thick;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = W(1);
      ctx.beginPath();
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const x = (t - 0.5) * p.len;
        const y = Math.sin((t * p.freq * 360 + p.phase) * D2R) * p.amp;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (p.taper > 0) {
        const g = ctx.createLinearGradient(-p.len / 2, 0, p.len / 2, 0);
        const f = Math.min(0.499, p.taper / 2);
        g.addColorStop(0, W(0));
        g.addColorStop(f, W(1));
        g.addColorStop(1 - f, W(1));
        g.addColorStop(1, W(0));
        applyAlphaMask(ctx, g);
      }
    },
  },

  {
    id: 'beam',
    label: 'Beam',
    group: 'Curves',
    params: [
      P('len', 'Length', 1.0, 0.05, 4, 0.01),
      P('near', 'Width at start', 0.05, 0.005, 1, 0.005),
      P('far', 'Width at end', 0.3, 0.005, 2, 0.005),
      P('fade', 'Fade to end', 0.7, 0, 1, 0.01),
      P('feather', 'Edge softness', 0.5, 0, 1, 0.01),
    ],
    draw(ctx, p) {
      polyPath(ctx, [
        [-p.len / 2, -p.near / 2],
        [p.len / 2, -p.far / 2],
        [p.len / 2, p.far / 2],
        [-p.len / 2, p.near / 2],
      ]);
      ctx.fill();
      if (p.fade > 0) {
        const g = ctx.createLinearGradient(-p.len / 2, 0, p.len / 2, 0);
        g.addColorStop(0, W(1));
        g.addColorStop(1, W(Math.max(0, 1 - p.fade)));
        applyAlphaMask(ctx, g);
      }
      if (p.feather > 0) {
        const wid = Math.max(p.near, p.far);
        const g = ctx.createLinearGradient(0, -wid / 2, 0, wid / 2);
        const f = Math.min(0.499, p.feather / 2);
        g.addColorStop(0, W(0));
        g.addColorStop(f, W(1));
        g.addColorStop(1 - f, W(1));
        g.addColorStop(1, W(0));
        applyAlphaMask(ctx, g);
      }
    },
  },

  {
    id: 'image',
    label: 'PNG image',
    group: 'Image',
    isImage: true,
    params: [
      P('feather', 'Edge softness', 0, 0, 1, 0.01),
    ],
    draw(ctx, p, env) {
      const img = env && env.image;
      if (!img || !img.complete || !img.naturalWidth) return;
      const ar = img.naturalWidth / img.naturalHeight;
      let w = 1, h = 1;
      if (ar >= 1) h = 1 / ar; else w = ar;
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      if (p.feather > 0) applyAlphaMask(ctx, radialFeather(ctx, 0.6, p.feather));
    },
  },
];

export const SHAPE_BY_ID = new Map(SHAPES.map((s) => [s.id, s]));

export function shapeDefaults(id) {
  const s = SHAPE_BY_ID.get(id);
  if (!s) return {};
  const out = {};
  for (const p of s.params) out[p.key] = p.def;
  return out;
}

// Rough half-extent of a shape in unit space, used to size the scratch clear
// rect and to hit-test on the playfield.
export function shapeExtent(id, params) {
  const p = params || {};
  switch (id) {
    case 'bar': return Math.max(p.len || 1, p.thick || 0.2) * 0.5 + 0.02;
    case 'stripes': {
      const n = Math.max(1, Math.round(p.count || 1));
      const span = (n - 1) * (p.spread || 0) + (p.thick || 0);
      return Math.max(span, p.len || 1) * 0.5 + 0.02;
    }
    case 'chevron': {
      const n = Math.max(1, Math.round(p.count || 1));
      return ((n - 1) * (p.spread || 0)) / 2 + 0.5 + (p.thick || 0);
    }
    case 'wave': return Math.max(p.len || 1, (p.amp || 0) * 2 + (p.thick || 0)) * 0.5 + 0.02;
    case 'beam': return Math.max(p.len || 1, p.far || 0, p.near || 0) * 0.5 + 0.02;
    case 'dots': return (p.radius || 0.4) + (p.size || 0.1) / 2 + 0.02;
    case 'cross': return 0.5 + (p.thick || 0) * 0.5;
    case 'square': return 0.72 + (p.filled === false ? (p.thick || 0) * 0.5 : 0);
    case 'triangle': return 0.55 + (p.filled === false ? (p.thick || 0) * 0.5 : 0);
    default: return 0.62;
  }
}
