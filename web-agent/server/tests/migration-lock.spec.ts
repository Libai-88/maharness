import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIGRATION_LOCK, migrationFingerprint } from '../migration-lock';

test('existing migration steps and schema DDL are locked to an explicit reviewable fingerprint', () => {
  assert.match(MIGRATION_LOCK, /^[a-f0-9]{64}$/);
  const actual = migrationFingerprint();
  assert.equal(actual, MIGRATION_LOCK, `migration fingerprint changed; update MIGRATION_LOCK to ${actual}`);
});
