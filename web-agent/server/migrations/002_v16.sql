-- v16: explicit society capability provenance and reviewer identity.
-- Both tables store the full domain record as JSON; these columns exist so the
-- host can query/audit provenance without parsing every record.

ALTER TABLE organization_society_tasks_v1 ADD COLUMN capability_source TEXT NOT NULL DEFAULT 'legacy_heuristic';
ALTER TABLE organization_society_tasks_v1 ADD COLUMN team_mode TEXT NOT NULL DEFAULT 'auto';

UPDATE organization_society_tasks_v1
   SET capability_source = COALESCE(json_extract(record, '$.capabilitySource'), 'legacy_heuristic'),
       team_mode = COALESCE(json_extract(record, '$.teamMode'), 'auto')
 WHERE json_valid(record);

CREATE INDEX IF NOT EXISTS organization_society_tasks_provenance
  ON organization_society_tasks_v1(tenant_id, capability_source);

ALTER TABLE experience_reviews_v1 ADD COLUMN reviewer_model TEXT;

UPDATE experience_reviews_v1
   SET reviewer_model = json_extract(record, '$.model')
 WHERE json_valid(record);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL
);
