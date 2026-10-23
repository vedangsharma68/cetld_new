import test from 'node:test';
import assert from 'node:assert/strict';
import {initialsFor, profileFromUser} from '../profile.mjs';

test('profile reads existing auth metadata and keeps initials in sync', () => {
  assert.deepEqual(profileFromUser({
    email: 'fallback@example.com',
    user_metadata: {full_name: 'Ada Lovelace', business_name: 'Analytical Engines'},
  }), {
    fullName: 'Ada Lovelace',
    businessName: 'Analytical Engines',
    initials: 'AL',
    secondaryLabel: 'Analytical Engines',
  });
});

test('profile uses safe fallbacks when metadata is missing', () => {
  assert.deepEqual(profileFromUser({email: 'vedang@example.com'}), {
    fullName: '',
    businessName: '',
    initials: 'AC',
    secondaryLabel: 'Business owner',
  });
  assert.equal(profileFromUser(null).fullName, '');
  assert.equal(profileFromUser(null).initials, 'AC');
});

for (const localPart of [
  'vedangsharma52+clientqa1',
  'clientqa1',
  'vedang.sharma',
  'VEDANG_sharma-clientqa1+qa.test-tag',
  '.vedang__sharma--',
  '+tag',
  '._-+tag',
]) test(`email local-part ${localPart} is never treated as a name`, () => {
  const profile = profileFromUser({
    email: `${localPart}@example.com`,
    user_metadata: {full_name: ' ', name: ''},
  });
  assert.equal(profile.fullName, '');
  assert.equal(profile.initials, 'AC');
});

for (const key of ['full_name', 'fullName', 'name'])
test(`explicit ${key} is preserved without reformatting`, () => {
  const profile = profileFromUser({
    email: 'vedang.sharma+clientqa1@example.com',
    user_metadata: {[key]: '  Mary-Jane McDonald  '},
  });
  assert.equal(profile.fullName, 'Mary-Jane McDonald');
  assert.equal(profile.initials, 'MM');
});

test('initials follow the persisted full name', () => {
  assert.equal(initialsFor('Grace Hopper'), 'GH');
  assert.equal(initialsFor('Grace'), 'GR');
});
