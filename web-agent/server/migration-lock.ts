import { createHash } from 'node:crypto';
import { Store } from './db';
import { RUN_SCHEMA } from './run-store';
import { MATERIAL_SCHEMA } from './materials';
import { AUTOMATION_SCHEMA } from './automations';
import { RECOVERY_SCHEDULE_SCHEMA } from './schedule-store';
import { EXPERIENCE_SCHEMA } from './experience-store';
import { ORGANIZATION_SCHEMA } from './organization-store';

/**
 * Migration audit lock.
 *
 * Existing migration steps are append-only. Editing an old step or changing a
 * schema constant must be an explicit, reviewable operation: update this lock
 * in the same change and explain why in the migration commit. New steps append
 * to Store.MIGRATIONS; do not rewrite historical `from -> to` entries.
 */
export const MIGRATION_LOCK = 'c80a1f5d332ee63fa4780ee271e29d4d462166e717cb62c2c9f3d41646015b56';

export function migrationFingerprint(): string {
  const digest = createHash('sha256');
  const schemas: Array<[string, string]> = [
    ['RUN_SCHEMA', RUN_SCHEMA],
    ['MATERIAL_SCHEMA', MATERIAL_SCHEMA],
    ['AUTOMATION_SCHEMA', AUTOMATION_SCHEMA],
    ['RECOVERY_SCHEDULE_SCHEMA', RECOVERY_SCHEDULE_SCHEMA],
    ['EXPERIENCE_SCHEMA', EXPERIENCE_SCHEMA],
    ['ORGANIZATION_SCHEMA', ORGANIZATION_SCHEMA],
  ];
  for (const [name, sql] of schemas) {
    digest.update('schema:').update(name).update('\0').update(sql).update('\0');
  }
  for (const step of Store.MIGRATIONS) {
    digest.update('step:').update(String(step.from)).update('->').update(String(step.to)).update('\0')
      .update(step.run.toString()).update('\0');
  }
  return digest.digest('hex');
}
