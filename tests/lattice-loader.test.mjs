import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {LatticeLoader} from '../LatticeLoader.js';

const css = readFileSync(new URL('../LatticeLoader.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');

test('Assistant loads the lattice CSS and renders an animated task label without a timer', () => {
  assert.match(html, /LatticeLoader\.css/);
  const loader = LatticeLoader({label: 'Checking invoices', showTimer: false, step: 150, gap: 3});
  assert.match(loader, /role="status"/);
  assert.match(loader, /data-status="working"/);
  assert.match(loader, /Checking invoices/);
  assert.match(loader, /Checking invoices, in progress/);
  assert.match(loader, /data-pattern="orbit"/);
  assert.match(loader, /--ll-cycle:1200ms/);
  assert.equal((loader.match(/class="lattice-loader__cell"/g) || []).length, 18);
  assert.doesNotMatch(loader, /lattice-loader__timer/);
  assert.match(css, /@keyframes lattice-on/);
  assert.match(css, /@keyframes lattice-orbit/);
  assert.match(css, /\[data-pattern=orbit\].*animation-name:lattice-orbit/);
  assert.match(css, /prefers-reduced-motion:reduce/);
});

test('Assistant uses a compact glowing orbit rather than the default pulse', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(app, /pattern:'orbit',grid:3,shape:'round',cellSize:4,gap:2,fontSize:12,step:105,idleOpacity:0\.12,glow:true/);
  assert.match(app, /className:'assistant-lattice'/);
  assert.match(css, /\.lattice-loader\.assistant-lattice\{--ll-cell:4px;--ll-gap:2px;--ll-font:12px;--ll-idle:\.12;--ll-cycle:840ms\}/);
  assert.match(css, /nth-child\(6\)\{animation-delay:315ms\}/);
  assert.match(css, /nth-child\(4\)\{animation-delay:735ms\}/);
  assert.match(css, /@keyframes lattice-orbit\{0%,8%/);
  assert.match(css, /\.assistant-lattice\[data-status=working\] \.lattice-loader__grid::after/);
  assert.match(css, /animation:assistant-lattice-orbit var\(--ll-cycle\) linear infinite/);
  assert.match(css, /\.assistant-lattice\[data-status=working\] \.lattice-loader__text\[data-active\]/);
  assert.match(css, /@keyframes assistant-status-shimmer/);
  assert.match(css, /background-clip:text/);
  assert.match(css, /prefers-reduced-motion:reduce[^}]*[\s\S]*assistant-lattice\[data-status=working\] \.lattice-loader__grid::after\{animation:none/);
  assert.match(css, /assistant-lattice\[data-status=working\] \.lattice-loader__text\[data-active\]\{animation:none;color:inherit;background:none\}/);
});

test('lattice state marks and task labels are escaped', () => {
  const done = LatticeLoader({status: 'done', label: '<script>', showTimer: false});
  const error = LatticeLoader({status: 'error', label: 'Syncing books', showTimer: false});
  assert.match(done, /data-status="done"/);
  assert.match(done, /&lt;script&gt;/);
  assert.doesNotMatch(done, /<script>/);
  assert.match(error, /data-status="error"/);
  assert.match(error, /Failed after/);
  assert.equal((error.match(/data-on=""/g) || []).length, 5);
});
