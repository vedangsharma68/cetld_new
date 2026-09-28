import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {readWorkspacePage, saveWorkspacePage} from '../workspace-page.mjs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

test('selected workspace page survives refresh for the same account only', () => {
  const values = new Map();
  const storage = {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value)};
  saveWorkspacePage(storage, 'user-1', 'Assistant');
  assert.equal(readWorkspacePage(storage, 'user-1'), 'Assistant');
  assert.equal(readWorkspacePage(storage, 'user-2'), 'Overview');
  saveWorkspacePage(storage, 'user-1', 'Settings');
  assert.equal(readWorkspacePage(storage, 'user-1'), 'Settings');
  saveWorkspacePage(storage, 'user-1', 'unknown-page');
  assert.equal(readWorkspacePage(storage, 'user-1'), 'Settings');
});

test('unavailable or invalid browser storage safely opens Overview', () => {
  const blocked = {getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); }};
  assert.equal(readWorkspacePage(blocked, 'user-1'), 'Overview');
  assert.doesNotThrow(() => saveWorkspacePage(blocked, 'user-1', 'Assistant'));
  assert.equal(readWorkspacePage({getItem: () => 'Invalid'}, 'user-1'), 'Overview');
});

test('account load restores the page and render remembers navigation', () => {
  assert.match(app, /state\.page=oauthReturnPage\|\|readWorkspacePage\(workspacePageStorage\(\),user\.id\)/);
  assert.match(app, /if\(!state\.demo\)saveWorkspacePage\(workspacePageStorage\(\),state\.user\.id,state\.page\)/);
});

test('top navigation is fixed at all widths and leaves space for content', () => {
  assert.match(css, /\.main\{padding-top:68px\}/);
  assert.match(css, /\.topbar\{position:fixed;top:0;left:238px;right:0\}/);
  assert.match(css, /\.shell\.sidebar-collapsed \.topbar\{left:76px\}/);
  assert.match(css, /\.main\{padding-top:65px\}\.topbar\{left:0\}/);
});
