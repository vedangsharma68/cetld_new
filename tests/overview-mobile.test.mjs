import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

function mobileRules() {
  const match = css.match(/@media\s*\(max-width:\s*640px\)\s*\{([\s\S]*)$/);
  assert.ok(match, 'Overview needs a dedicated <=640px responsive rule');
  return match[1];
}

test('Overview mobile layout stacks every dashboard section at full width', () => {
  const rules = mobileRules();
  const oneColumn = /grid-template-columns\s*:\s*(?:1fr|minmax\(0,1fr\))/;
  assert.match(rules, /\.dashboard-grid/);
  assert.match(rules, /\.dashboard-aside/);
  assert.match(rules, /\.insight-grid/);
  assert.match(rules, /\.stats/);
  assert.match(rules, oneColumn);
});

test('Overview mobile cards and controls can shrink without horizontal overflow', () => {
  const rules = mobileRules();
  assert.match(css, /body\{[^}]*overflow-x\s*:\s*hidden/);
  assert.match(rules, /\.dashboard-grid[^}]*min-width\s*:\s*0/);
  assert.match(rules, /\.dashboard-aside[^}]*min-width\s*:\s*0/);
  assert.match(rules, /\.panel[^}]*min-width\s*:\s*0/);
  assert.match(rules, /\.search-row\s*\{[^}]*display\s*:\s*grid/);
  assert.match(rules, /\.search[^}]*min-width\s*:\s*0/);
  assert.match(rules, /\.filter[^}]*width\s*:\s*100%/);
});

test('Overview mobile empty Agent Status stays compact and readable', () => {
  const rules = mobileRules();
  assert.match(rules, /\.attention\s*\{[^}]*padding\s*:/);
  assert.match(rules, /\.attention h2\s*\{[^}]*font-size\s*:/);
  assert.match(rules, /\.attention p\s*\{[^}]*line-height\s*:/);
  assert.match(rules, /\.empty\s*\{[^}]*padding\s*:/);
});
