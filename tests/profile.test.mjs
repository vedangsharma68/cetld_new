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
    fullName: 'Vedang',
    businessName: '',
    initials: 'VE',
    secondaryLabel: 'Business owner',
  });
  assert.equal(profileFromUser(null).fullName, 'Account');
  assert.equal(profileFromUser(null).initials, 'AC');
});

for (const [localPart, fullName, initials] of [
  ['vedangsharma52+clientqa1', 'Vedangsharma52', 'VE'],
  ['clientqa1', 'Clientqa1', 'CL'],
  ['vedang.sharma', 'Vedang Sharma', 'VS'],
  ['VEDANG_sharma-clientqa1+qa.test-tag', 'Vedang Sharma Clientqa1', 'VC'],
  ['.vedang__sharma--', 'Vedang Sharma', 'VS'],
  ['+tag', 'Account', 'AC'],
  ['._-+tag', 'Account', 'AC'],
]) test(`email fallback formats ${localPart}`, () => {
  const profile = profileFromUser({
    email: `${localPart}@example.com`,
    user_metadata: {full_name: ' ', name: ''},
  });
  assert.equal(profile.fullName, fullName);
  assert.equal(profile.initials, initials);
});

for (const key of ['full_name', 'fullName', 'name'])
test(`explicit ${key} takes precedence over the email fallback without reformatting`, () => {
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
