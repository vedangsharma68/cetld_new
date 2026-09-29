import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const [home, privacy, terms, app] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../privacy/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../terms/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../app/index.html', import.meta.url), 'utf8'),
]);

test('public landing page contains crawlable business information in static HTML', () => {
  assert.match(home, /<script src="\/hero-rotation\.js" defer><\/script>/i);
  for (const detail of [
    'Cetld',
    'software that helps small businesses track invoices and follow up on payments',
    'Mahindra Luminare Tower C',
    'Sector 59, Gurugram, Haryana, India',
    'vedangsharma52@gmail.com',
    '+91 73033 38959',
  ]) assert.match(home, new RegExp(detail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  assert.match(home, /href="\/app\/"[^>]*>Sign in/);
  assert.match(home, /class="wordmark brand-lockup"[^>]*>[\s\S]*?src="\/favicon\.svg"/);
  assert.match(home, /class="hero-logo" src="\/favicon\.svg"/);
  assert.match(home, /href="\/privacy"/);
  assert.match(home, /href="\/terms"/);
});

test('privacy and terms pages are static and carry contact details', () => {
  for (const page of [privacy, terms]) {
    assert.doesNotMatch(page, /<script\b/i);
    assert.match(page, /vedangsharma52@gmail\.com/);
    assert.match(page, /Mahindra Luminare Tower C/);
  }
  assert.match(privacy, /Privacy Policy/);
  assert.match(terms, /Terms of Service/);
});

test('the existing client application is available from the app route', () => {
  assert.match(app, /id="app"/);
  assert.match(app, /src="\/app\.js"/);
});
