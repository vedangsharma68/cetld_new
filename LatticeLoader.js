// Adapted from the React Bits LatticeLoader for CETLD's browser-native UI.
const PATTERNS = {
  arrow: {3: {cells: [1, 2, 3, 0, 1, 2, 1, 2, 3], loop: 7.2, scale: 1}},
  dots: {3: {cells: [0, 1, 2, 0, 1, 2, 0, 1, 2], loop: 3, scale: 2.4}},
  ripple: {3: {cells: [2, 1, 2, 1, 0, 1, 2, 1, 2], loop: 4.8, scale: 1.5}},
  spiral: {3: {cells: [0, 1, 2, 7, 8, 3, 6, 5, 4], loop: 9, scale: 1.2, lit: 0.35}},
  orbit: {
    3: {cells: [0, 1, 2, 7, null, 3, 6, 5, 4], loop: 8, scale: 1},
    4: {cells: [0, 1, 2, 3, 11, null, null, 4, 10, null, null, 5, 9, 8, 7, 6], loop: 6, scale: 1.2, lit: 0.45},
  },
  snake: {
    3: {cells: [0, 1, 2, 5, 4, 3, 6, 7, 8], loop: 9, scale: 1, lit: 0.35},
    4: {cells: [0, 1, 2, 3, 7, 6, 5, 4, 8, 9, 10, 11, 15, 14, 13, 12], loop: 16, scale: 1, lit: 0.25},
  },
  sweep: {4: {cells: [0, 1, 2, 3, 1, 2, 3, 4, 2, 3, 4, 5, 3, 4, 5, 6], loop: 5, scale: 1, lit: 0.45}},
  spin: {4: {cells: [0, 0, 1, 1, 0, 0, 1, 1, 3, 3, 2, 2, 3, 3, 2, 2], loop: 4, scale: 1.6, lit: 0.35}},
  rain: {4: {cells: [0, 2, 1, 3, 1, 3, 2, 4, 2, 4, 3, 5, 3, 5, 4, 6], loop: 4, scale: 1.2, lit: 0.35}},
  pulse: {4: {cells: [2, 1, 1, 2, 1, 0, 0, 1, 1, 0, 0, 1, 2, 1, 1, 2], loop: 2.4, scale: 2.5, lit: 0.45}},
};
const MARKS = {
  3: {done: [2, 3, 5, 7], error: [0, 2, 4, 6, 8]},
  4: {done: [7, 8, 10, 13], error: [0, 3, 5, 6, 9, 10, 12, 15]},
};
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
const size = (value, fallback) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : fallback;

export function LatticeLoader({
  label = 'Thinking', doneLabel = 'Done in', errorLabel = 'Failed after', status = 'working',
  pattern = 'orbit', grid = 3, shape = 'round', color = 'currentColor',
  doneColor = '#22c55e', errorColor = '#ef4444', cellSize = 6, gap = 2,
  fontSize = 14, step = 90, idleOpacity = 0.15, glow = false, glowColor = '',
  showTimer = true, elapsed = 0, className = '',
} = {}) {
  const n = grid === 4 ? 4 : 3;
  const resolvedStatus = ['working', 'done', 'error'].includes(status) ? status : 'working';
  const patternName = typeof pattern === 'string' && PATTERNS[pattern]?.[n] ? pattern : n === 3 ? 'orbit' : 'sweep';
  const named = PATTERNS[patternName][n];
  const pat = typeof pattern === 'object' && Array.isArray(pattern?.cells)
    ? {cells: Array.from({length: n * n}, (_, i) => pattern.cells[i] ?? null), loop: pattern.loop ?? 8, scale: pattern.scale ?? 1, lit: pattern.lit ?? 0.62}
    : named;
  const delay = size(step, 90) * size(pat.scale, 1);
  const cycle = Math.round(size(pat.loop, 8) * delay);
  const cells = pat.cells.map((unit, i) => `<span class="lattice-loader__cell"${unit == null ? ' data-hole=""' : ''}${pat.lit && pat.lit !== 0.62 ? ` data-lit="${Math.round(pat.lit * 100)}"` : ''}${unit == null ? '' : ` style="animation-delay:${Math.round(unit * delay)}ms"`}></span>`).join('');
  const mark = pat.cells.map((_, i) => `<span class="lattice-loader__cell"${MARKS[n][resolvedStatus === 'error' ? 'error' : 'done'].includes(i) ? ' data-on=""' : ''}></span>`).join('');
  const seconds = size(elapsed, 0).toFixed(1);
  const spoken = resolvedStatus === 'working' ? `${label}, in progress` : `${resolvedStatus === 'done' ? doneLabel : errorLabel}${showTimer ? ` ${seconds} seconds` : ''}`;
  const css = `--ll-n:${n};--ll-cell:${size(cellSize, 6)}px;--ll-gap:${size(gap, 2)}px;--ll-font:${size(fontSize, 14)}px;--ll-color:${escape(color)};--ll-mark:${escape(resolvedStatus === 'error' ? errorColor : doneColor)};--ll-idle:${Math.min(1, size(idleOpacity, 0.15))};--ll-glow:${escape(glowColor || color)};--ll-mark-glow:${escape(glowColor || (resolvedStatus === 'error' ? errorColor : doneColor))};--ll-cycle:${cycle}ms`;
  return `<span role="status" class="lattice-loader${className ? ` ${escape(className)}` : ''}" data-status="${resolvedStatus}" data-pattern="${typeof pattern === 'object' ? 'custom' : patternName}" data-shape="${shape === 'square' ? 'square' : 'round'}"${glow ? ' data-glow=""' : ''} style="${css}"><span class="lattice-loader__grid" aria-hidden="true"><span class="lattice-loader__layer lattice-loader__run">${cells}</span><span class="lattice-loader__layer lattice-loader__mark">${mark}</span></span><span class="lattice-loader__label" aria-hidden="true"><span class="lattice-loader__text"${resolvedStatus === 'working' ? ' data-active=""' : ''}>${escape(label)}</span><span class="lattice-loader__text"${resolvedStatus === 'done' ? ' data-active=""' : ''}>${escape(doneLabel)}</span><span class="lattice-loader__text"${resolvedStatus === 'error' ? ' data-active=""' : ''}>${escape(errorLabel)}</span></span>${showTimer ? `<span class="lattice-loader__timer" aria-hidden="true">${seconds}s</span>` : ''}<span class="lattice-loader__sr">${escape(spoken)}</span></span>`;
}
