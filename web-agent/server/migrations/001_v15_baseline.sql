CREATE TABLE agent_checkpoints (
        session_id TEXT PRIMARY KEY, turn INTEGER NOT NULL, run_id TEXT,
        history TEXT NOT NULL, created_at INTEGER NOT NULL
      );

CREATE TABLE agent_tool_effects (
        run_id TEXT NOT NULL, effect_key TEXT NOT NULL, status TEXT NOT NULL,
        result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, effect_key)
      );

CREATE TABLE api_tokens (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, role TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, label TEXT,
        created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER, last_used_at INTEGER
      );

CREATE TABLE approval_requests (
        id TEXT PRIMARY KEY, session_id TEXT, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
        summary TEXT, args TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        decided_at INTEGER, decision TEXT, reason TEXT
      );

CREATE TABLE authorization_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at INTEGER NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('granted', 'denied', 'connected', 'disconnected')),
        subject TEXT NOT NULL,
        capability TEXT NOT NULL,
        object TEXT NOT NULL,
        reason TEXT
      );

CREATE TABLE automation_occurrences_v3 (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    occurrence_key TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    state TEXT NOT NULL,
    reason TEXT,
    run_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(automation_id, occurrence_key)
  );

CREATE TABLE automation_trigger_baselines_v3 (
    automation_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    value TEXT,
    etag TEXT,
    last_modified TEXT,
    checked_at INTEGER,
    error TEXT,
    updated_at INTEGER NOT NULL
  );

CREATE TABLE automations_v3 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    workspace TEXT NOT NULL,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    trigger_json TEXT NOT NULL,
    state TEXT NOT NULL,
    approval TEXT NOT NULL,
    created_by TEXT NOT NULL,
    execution_session_id TEXT,
    provider_id TEXT,
    model TEXT,
    budget_usd REAL,
    budget_policy TEXT,
    materials_json TEXT NOT NULL DEFAULT '[]',
    item_id TEXT,
    source_session_id TEXT,
    next_due_at INTEGER,
    last_triggered_at INTEGER,
    trigger_value TEXT,
    trigger_etag TEXT,
    trigger_last_modified TEXT,
    trigger_checked_at INTEGER,
    trigger_error TEXT,
    revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

CREATE TABLE experience_audits_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    review_id TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

CREATE TABLE experience_findings_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    review_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

CREATE TABLE experience_regressions_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    finding_id TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

CREATE TABLE experience_reviews_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    status TEXT NOT NULL,
    request_key TEXT,
    run_ids TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(tenant_id, request_key)
  );

CREATE TABLE materials_v1 (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, workspace TEXT NOT NULL, record TEXT NOT NULL);

CREATE TABLE messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        role TEXT NOT NULL, content TEXT, tool_calls TEXT, tool_call_id TEXT,
        tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, cost REAL DEFAULT 0,
        trace_id TEXT, task_verification TEXT, created_at INTEGER NOT NULL
      , reasoning TEXT);

CREATE TABLE model_tool_checks_v2 (
    provider_id TEXT NOT NULL, model TEXT NOT NULL, record TEXT NOT NULL,
    PRIMARY KEY(provider_id,model)
  );

CREATE TABLE models (
        provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
        context_window INTEGER, max_output INTEGER,
        vision INTEGER NOT NULL DEFAULT 0, tools INTEGER NOT NULL DEFAULT 0,
        reasoning INTEGER NOT NULL DEFAULT 0,
        price_in REAL, price_out REAL, enabled INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL DEFAULT 'manual', latency_ms INTEGER, privacy_tier TEXT, risk_level TEXT, updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider_id, model_id)
      );

CREATE TABLE organization_contracts_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    work_order_id TEXT NOT NULL,
    team_cycle_id TEXT,
    role_id TEXT NOT NULL,
    run_id TEXT,
    status TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

CREATE TABLE organization_exceptions_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    work_order_id TEXT NOT NULL,
    contract_id TEXT,
    status TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

CREATE TABLE organization_institution_audits_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

CREATE TABLE organization_institutions_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(tenant_id, version)
  );

CREATE TABLE organization_ledger_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    work_order_id TEXT NOT NULL,
    contract_id TEXT,
    type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

CREATE TABLE organization_proposals_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    work_order_id TEXT NOT NULL,
    status TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

CREATE TABLE organization_receipts_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    work_order_id TEXT NOT NULL UNIQUE,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

CREATE TABLE organization_role_memories_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

CREATE TABLE organization_role_relations_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    from_role_id TEXT NOT NULL,
    to_role_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    record TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(tenant_id, from_role_id, to_role_id, kind)
  );

CREATE TABLE organization_roles_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

CREATE TABLE organization_society_audit_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    schedule_id TEXT,
    work_order_id TEXT,
    action TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    details TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(tenant_id, idempotency_key)
  );

CREATE TABLE organization_society_schedules_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    work_order_id TEXT,
    department_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

CREATE TABLE organization_society_tasks_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT '',
    department_id TEXT,
    status TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

CREATE TABLE organization_team_cycles_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    work_order_id TEXT NOT NULL,
    status TEXT NOT NULL,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

CREATE TABLE organization_version_audits_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    from_version INTEGER,
    to_version INTEGER NOT NULL,
    before_hash TEXT,
    after_hash TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

CREATE TABLE organization_versions_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    record TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_by TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(tenant_id, kind, subject_id, version)
  );

CREATE TABLE organization_work_orders_v1 (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL,
    root_run_id TEXT,
    origin_kind TEXT NOT NULL DEFAULT 'run',
    origin_id TEXT,
    status TEXT NOT NULL,
    operation_key TEXT,
    record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(tenant_id, operation_key)
  );

CREATE TABLE personas (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL,
        enabled INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );

CREATE TABLE plugin_development_v2 (tenant_id TEXT NOT NULL, workspace TEXT NOT NULL, grant_json TEXT NOT NULL, PRIMARY KEY(tenant_id,workspace));

CREATE TABLE plugin_state (
        plugin_id TEXT PRIMARY KEY, enabled INTEGER DEFAULT 1, version TEXT, loaded_at INTEGER
      );

CREATE TABLE providers (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, base_url TEXT NOT NULL,
        api_key TEXT NOT NULL, model TEXT NOT NULL,
        price_in REAL, price_out REAL, enabled INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      , protocol TEXT NOT NULL DEFAULT 'openai');

CREATE TABLE run_artifacts_v2 (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, ref TEXT NOT NULL, record TEXT NOT NULL,
    UNIQUE(run_id,ref)
  );

CREATE TABLE run_budget_reservations_v2 (
    run_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, amount REAL NOT NULL
  );

CREATE TABLE run_checkpoints_v2 (run_id TEXT PRIMARY KEY, data TEXT NOT NULL);

CREATE TABLE run_events_v2 (
    run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY(run_id,seq)
  );

CREATE TABLE run_history_v2 (
    run_id TEXT NOT NULL, message_id TEXT NOT NULL, message TEXT NOT NULL,
    PRIMARY KEY(run_id,message_id)
  );

CREATE TABLE run_materials_v1 (run_id TEXT NOT NULL, material_id TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY(run_id,material_id));

CREATE TABLE run_messages_v2 (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, content TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, request_key TEXT, UNIQUE(run_id,request_key)
  );

CREATE TABLE run_model_calls_v2 (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, record TEXT NOT NULL
  );

CREATE TABLE run_model_inputs_v2 (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, turn INTEGER NOT NULL, created_at INTEGER NOT NULL, input TEXT NOT NULL
  );

CREATE TABLE run_plugins_v2 (run_id TEXT PRIMARY KEY, bindings TEXT NOT NULL);

CREATE TABLE run_token_reservations_v2 (
    run_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, amount INTEGER NOT NULL
  );

CREATE TABLE run_tool_calls_v2 (
    run_id TEXT NOT NULL, call_id TEXT NOT NULL, name TEXT NOT NULL, args_summary TEXT NOT NULL,
    status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, result TEXT,
    tool_version TEXT, side_effect TEXT, side_effect_outcome TEXT,
    PRIMARY KEY(run_id,call_id)
  );

CREATE TABLE runs_v2 (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
    parent_id TEXT, status TEXT NOT NULL, record TEXT NOT NULL, request_key TEXT,
    UNIQUE(tenant_id, session_id, request_key)
  );

CREATE TABLE scheduled_recovery_jobs_v3 (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    run_id TEXT,
    principal_role TEXT,
    tenant_id TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_error TEXT
  );

CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '新会话',
        model TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '',
        tenant_id TEXT NOT NULL DEFAULT 'default',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      , mode TEXT NOT NULL DEFAULT 'normal', plan_pending INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, role TEXT NOT NULL DEFAULT '');

CREATE TABLE tenants (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, max_sessions INTEGER NOT NULL DEFAULT 0,
    max_active_runs INTEGER NOT NULL DEFAULT 0, max_cost_usd REAL NOT NULL DEFAULT 0,
    max_storage_bytes INTEGER NOT NULL DEFAULT 0,
    max_tool_calls_per_minute INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

CREATE TABLE workspace_permissions_v2 (
    tenant_id TEXT NOT NULL, workspace TEXT NOT NULL, profile TEXT NOT NULL, revision INTEGER NOT NULL,
    PRIMARY KEY(tenant_id,workspace)
  );

CREATE TABLE workspace_plugins_v2 (tenant_id TEXT NOT NULL, workspace TEXT NOT NULL, plugin_id TEXT NOT NULL, binding TEXT NOT NULL, PRIMARY KEY(tenant_id,workspace,plugin_id));

CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, path TEXT NOT NULL, created_at INTEGER NOT NULL
      );

CREATE INDEX automation_occurrences_v3_list ON automation_occurrences_v3(tenant_id, created_at DESC);

CREATE INDEX automation_trigger_baselines_v3_tenant ON automation_trigger_baselines_v3(tenant_id);

CREATE INDEX automations_v3_due ON automations_v3(state, approval, next_due_at);

CREATE INDEX automations_v3_tenant ON automations_v3(tenant_id, updated_at DESC);

CREATE INDEX experience_audits_review
    ON experience_audits_v1(tenant_id, review_id, created_at DESC);

CREATE UNIQUE INDEX experience_findings_fingerprint
    ON experience_findings_v1(tenant_id, fingerprint);

CREATE INDEX experience_findings_tenant
    ON experience_findings_v1(tenant_id, status, updated_at DESC);

CREATE INDEX experience_regressions_finding
    ON experience_regressions_v1(tenant_id, finding_id, created_at DESC);

CREATE INDEX experience_reviews_status
    ON experience_reviews_v1(tenant_id, status, updated_at DESC);

CREATE INDEX experience_reviews_tenant
    ON experience_reviews_v1(tenant_id, updated_at DESC);

CREATE INDEX idx_api_tokens_tenant ON api_tokens(tenant_id, created_at);

CREATE INDEX idx_approval_requests_tenant ON approval_requests(tenant_id, created_at);

CREATE INDEX idx_authorization_audit_time ON authorization_audit(occurred_at DESC);

CREATE INDEX idx_messages_session ON messages(session_id, created_at);

CREATE INDEX idx_sessions_tenant ON sessions(tenant_id, updated_at DESC);

CREATE INDEX organization_contracts_order
    ON organization_contracts_v1(tenant_id, work_order_id, created_at);

CREATE INDEX organization_contracts_run
    ON organization_contracts_v1(tenant_id, run_id);

CREATE INDEX organization_exceptions_tenant
    ON organization_exceptions_v1(tenant_id, status, updated_at DESC);

CREATE INDEX organization_institution_audits_tenant
    ON organization_institution_audits_v1(tenant_id, created_at DESC);

CREATE INDEX organization_institutions_tenant
    ON organization_institutions_v1(tenant_id, version DESC);

CREATE INDEX organization_ledger_order
    ON organization_ledger_v1(tenant_id, work_order_id, created_at);

CREATE INDEX organization_proposals_tenant
    ON organization_proposals_v1(tenant_id, status, updated_at DESC);

CREATE INDEX organization_receipts_tenant
    ON organization_receipts_v1(tenant_id, updated_at DESC);

CREATE INDEX organization_role_memories_role
    ON organization_role_memories_v1(tenant_id, role_id, created_at DESC);

CREATE INDEX organization_role_relations_role
    ON organization_role_relations_v1(tenant_id, from_role_id, updated_at DESC);

CREATE INDEX organization_roles_project
    ON organization_roles_v1(tenant_id, project_id, status);

CREATE INDEX organization_roles_tenant
    ON organization_roles_v1(tenant_id, status, updated_at DESC);

CREATE INDEX organization_society_audit_task
    ON organization_society_audit_v1(tenant_id, task_id, created_at);

CREATE INDEX organization_society_schedules_order
    ON organization_society_schedules_v1(tenant_id, work_order_id);

CREATE INDEX organization_society_schedules_tenant
    ON organization_society_schedules_v1(tenant_id, status, updated_at DESC);

CREATE INDEX organization_society_tasks_tenant
    ON organization_society_tasks_v1(tenant_id, status, updated_at DESC);

CREATE INDEX organization_team_cycles_order
    ON organization_team_cycles_v1(tenant_id, work_order_id, updated_at DESC);

CREATE INDEX organization_version_audits_subject
    ON organization_version_audits_v1(tenant_id, kind, subject_id, created_at DESC);

CREATE UNIQUE INDEX organization_versions_one_active
    ON organization_versions_v1(tenant_id, kind, subject_id)
    WHERE status='active';

CREATE INDEX organization_versions_subject
    ON organization_versions_v1(tenant_id, kind, subject_id, version DESC);

CREATE INDEX organization_work_orders_project
    ON organization_work_orders_v1(tenant_id, project_id, updated_at DESC);

CREATE INDEX organization_work_orders_tenant
    ON organization_work_orders_v1(tenant_id, updated_at DESC);

CREATE INDEX run_model_calls_owner ON run_model_calls_v2(run_id);

CREATE UNIQUE INDEX runs_v2_session_active ON runs_v2(session_id)
    WHERE parent_id IS NULL AND status IN ('queued','running','waiting_approval','stopping');

CREATE INDEX runs_v2_tenant ON runs_v2(tenant_id);

CREATE INDEX scheduled_recovery_jobs_v3_due
    ON scheduled_recovery_jobs_v3(state, due_at);

CREATE INDEX scheduled_recovery_jobs_v3_tenant
    ON scheduled_recovery_jobs_v3(tenant_id, due_at);

CREATE TRIGGER organization_society_audit_no_delete
  BEFORE DELETE ON organization_society_audit_v1
  BEGIN
    SELECT RAISE(ABORT, 'organization_society_audit_v1 is append-only');
  END;

CREATE TRIGGER organization_society_audit_no_update
  BEFORE UPDATE ON organization_society_audit_v1
  BEGIN
    SELECT RAISE(ABORT, 'organization_society_audit_v1 is append-only');
  END;
