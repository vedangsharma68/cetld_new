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
    fullName: 'vedang',
    businessName: '',
    initials: 'VE',
    secondaryLabel: 'Workspace owner',
  });
  assert.equal(profileFromUser(null).fullName, 'Account');
  assert.equal(profileFromUser(null).initials, 'AC');
});

test('initials follow the persisted full name', () => {
  assert.equal(initialsFor('Grace Hopper'), 'GH');
  assert.equal(initialsFor('Grace'), 'GR');
});
