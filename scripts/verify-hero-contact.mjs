import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

// Serve the worktree on :8765. Uses local fixtures only; never contacts app APIs.
export async function verifyHeroContact(page, name) {
  await page.goto('http://127.0.0.1:8765/');
  const result = await page.evaluate(async () => {
    await document.fonts.ready;
    const words = ['confidence', 'calm', 'control', 'clarity', 'proof', 'ease'];
    const window = document.querySelector('.rotating-word');
    const current = document.querySelector('.rotating-word-current');
    const period = document.querySelector('.rotating-word-period');
    const samples = [];
    // Inspect every animation frame across the entire cycle, including both
    // wider-to-narrower transitions and the wrap from ease to confidence.
    const end = performance.now() + 15500;
    const seen = new Set();
    let frames = 0;
    let failure = null;
    await new Promise(resolve => {
      function frame() {
        const style = getComputedStyle(window);
        const text = document.querySelector('.rotating-word-text');
        const r = window.getBoundingClientRect();
        const p = period.getBoundingClientRect();
        const t = text.getBoundingClientRect();
        if (Math.abs(p.top - t.top) > 1 || p.height > t.height + 1) failure = 'period wrapped';
        if (style.whiteSpace !== 'nowrap' || getComputedStyle(text).whiteSpace !== 'nowrap') failure = 'missing nowrap';
        if (!current.classList.contains('is-exiting')) {
          seen.add(current.textContent);
          if (r.bottom - current.getBoundingClientRect().bottom < parseFloat(style.fontSize) * .35) failure = 'insufficient descender clearance';
        }
        frames++;
        if (performance.now() < end) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });
    samples.push({frames, seen: [...seen], failure});
    // Include g/y glyphs even if a future edit removes clarity from the list.
    current.textContent = 'gy';
    const glyph = current.getBoundingClientRect();
    const clip = window.getBoundingClientRect();
    return {samples, words, glyphClearance: clip.bottom - glyph.bottom};
  });
  assert.equal(result.samples[0].failure, null, `${name}: ${JSON.stringify(result)}`);
  const seen = result.samples[0].seen;
  const start = result.words.indexOf(seen[0]);
  assert.deepEqual(seen, [...result.words.slice(start), ...result.words.slice(0, start)]);
  assert.ok(result.glyphClearance > 10);

  const form = await page.evaluate(async () => {
    const {followUpPreferencesForm} = await import('/followup-preferences-ui.mjs');
    document.head.innerHTML = '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css">';
    document.body.innerHTML = '<main class="main"><div class="content"><div class="settings-layout"><nav class="settings-nav"></nav><div class="settings-content">' + followUpPreferencesForm() + '</div></div></div></main>';
    await new Promise(resolve => {
      const link = document.querySelector('link');
      if (link.sheet) resolve();
      else link.addEventListener('load', resolve, {once:true});
    });
    const card = document.querySelector('#follow-up-preferences');
    const bounds = card.getBoundingClientRect();
    const overflow = [...card.querySelectorAll('*')].filter(e => {
      const r = e.getBoundingClientRect();
      return r.width && (r.left < bounds.left - 1 || r.right > bounds.right + 1 || e.scrollWidth > e.clientWidth + 1);
    }).map(e => e.name || e.className || e.tagName);
    const times = [...card.querySelectorAll('input[type="time"]')].map(e => {
      e.value = e.name === 'contactStart' ? '08:30' : '19:45';
      const r = e.getBoundingClientRect(), parent = e.parentElement.getBoundingClientRect();
      return {name:e.name, value:e.value, fits:r.width <= parent.width + 1, valid:e.checkValidity()};
    });
    return {overflow, times, pageWidth:document.documentElement.scrollWidth, width:innerWidth};
  });
  assert.deepEqual(form.overflow, [], `${name}: preferences overflow`);
  assert.ok(form.pageWidth <= form.width);
  assert.equal(form.times.length, 2);
  assert.ok(form.times.every(t => t.fits && t.valid));
  console.log(`${name}: hero cycle/frames, descenders, period binding and ${form.width}px preferences passed`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const require = createRequire(import.meta.url);
  const playwright = require(process.env.CETLD_PLAYWRIGHT_PATH || 'playwright');
  for (const name of (process.argv.includes('--chromium-only') ? ['chromium'] : ['chromium', 'webkit'])) {
    const browser = await playwright[name].launch({headless:true, ...(name === 'chromium' && process.env.CETLD_CHROMIUM_EXECUTABLE ? {executablePath:process.env.CETLD_CHROMIUM_EXECUTABLE} : {})});
    try {
      for (const width of [390, 768, 1440]) {
        const page = await browser.newPage({viewport:{width,height:900}});
        await verifyHeroContact(page, `${name} ${width}`);
        await page.emulateMedia({reducedMotion:'reduce'});
        await page.goto('http://127.0.0.1:8765/');
        await page.waitForTimeout(2700);
        assert.equal(await page.locator('.rotating-word-current').textContent(), 'confidence');
        assert.equal(await page.locator('.rotating-word-next').textContent(), '');
        await page.close();
      }
    } finally { await browser.close(); }
  }
}
