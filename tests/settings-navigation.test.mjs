import test from 'node:test';
import assert from 'node:assert/strict';
import {activeSettingsSection} from '../settings-navigation.js';

const sections = [
  {id: 'profile', top: -420},
  {id: 'follow-up-preferences', top: -40},
  {id: 'owner-whatsapp', top: 180},
  {id: 'preferences', top: 720},
  {id: 'account', top: 940},
];

test('settings scroll spy follows the section crossing its activation line', () => {
  assert.equal(activeSettingsSection(sections, {viewportHeight: 800, documentHeight: 2000}), 'follow-up-preferences');
  assert.equal(activeSettingsSection(sections, {viewportHeight: 800, documentHeight: 2000, activationOffset: 200}), 'owner-whatsapp');
});

test('settings scroll spy chooses the final link at the bottom of a long page', () => {
  assert.equal(activeSettingsSection(sections, {scrollY: 1200, viewportHeight: 800, documentHeight: 2000}), 'account');
});

test('a short settings page starts on Profile instead of falsely appearing at the bottom', () => {
  const shortPageSections = [
    {id: 'profile', top: 24},
    {id: 'follow-up-preferences', top: 160},
    {id: 'owner-whatsapp', top: 280},
    {id: 'preferences', top: 450},
    {id: 'account', top: 560},
  ];
  assert.equal(activeSettingsSection(shortPageSections, {viewportHeight: 900, documentHeight: 650}), 'profile');
});

test('settings scroll spy handles a missing section list', () => {
  assert.equal(activeSettingsSection([], {scrollY: 100, viewportHeight: 800, documentHeight: 1000}), null);
});
