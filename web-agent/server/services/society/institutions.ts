import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../../db';
import type { OrganizationService } from '../organization/service';
import { OrganizationError, type InstitutionPolicies, type InstitutionVersion, type OrganizationRole } from '../../organization-store';
import { DEFAULT_POLICIES, bounded, normalizePolicies, policyHash } from './policy';

/**
 * Institution bootstrap and versioned policy changes.
 *
 * The institution is the durable "constitution" of the society: default
 * departments, foundation roles, evaluation bootstrap and audited update /
 * rollback. Keeping it out of the scheduler makes policy changes readable
 * without following the tick state machine.
 */
export interface InstitutionDeps {
  store: Store;
  repository(): Store['organization'];
  organization: OrganizationService;
  now(): number;
  emit(type: string, data: Record<string, unknown>): void;
}

const FOUNDATION_ROLES: Array<Pick<OrganizationRole, 'name' | 'responsibilities' | 'capabilities'>> = [
  {
    name: '调度协调员',
    responsibilities: ['按制度选择单角色或短团队', '核对预算、权限和福利边界'],
    capabilities: ['coordination', 'planning', 'review'],
  },
  {
    name: '研究执行员',
    responsibilities: ['阅读资料、检索来源、形成可核对结论'],
    capabilities: ['research', 'reading', 'analysis', 'files'],
  },
  { name: '交付执行员', responsibilities: ['处理文件、文档和办公自动化任务'], capabilities: ['documents', 'files', 'automation'] },
  { name: '质量审校员', responsibilities: ['独立检查来源、验收条件和未完成项'], capabilities: ['review', 'analysis', 'quality'] },
];

export function ensureInstitution(deps: InstitutionDeps, tenantId: string): InstitutionVersion {
  const existing = deps.repository().activeInstitution(tenantId);
  if (existing) {
    ensureFoundationRoles(deps, tenantId);
    deps.organization.ensureEvaluation(tenantId);
    return existing;
  }
  const policies = normalizePolicies(DEFAULT_POLICIES);
  const record: InstitutionVersion = {
    id: randomUUID(),
    tenantId,
    version: 1,
    status: 'active',
    policies,
    hash: policyHash(policies),
    createdBy: 'maharness',
    reason: '初始化本地 AI 社会制度',
    createdAt: deps.now(),
  };
  deps.repository().transaction(() => {
    deps.repository().createInstitution(record);
    deps.repository().appendInstitutionAudit({
      id: randomUUID(),
      tenantId,
      version: 1,
      action: 'initialize',
      actor: 'maharness',
      toVersion: 1,
      afterHash: record.hash,
      reason: record.reason,
      createdAt: record.createdAt,
    });
    ensureFoundationRoles(deps, tenantId);
  });
  deps.organization.ensureEvaluation(tenantId);
  return record;
}

export function ensureFoundationRoles(deps: InstitutionDeps, tenantId: string): void {
  const repo = deps.repository();
  const now = deps.now();
  for (const role of FOUNDATION_ROLES) {
    const id = `institution-${createHash('sha256').update(`${tenantId}\0${role.name}`).digest('hex').slice(0, 24)}`;
    let record = repo.getRole(id, tenantId);
    if (!record) {
      record = {
        id,
        tenantId,
        projectId: '',
        ...role,
        authority: { workspace: '', readOnly: false, profile: 'standard', allowedTools: [] },
        modelPolicy: { providerId: '', model: 'runtime-selected' },
        persistent: true,
        employment: 'active',
        source: 'builtin',
        revision: 0,
        createdAt: now,
        updatedAt: now,
      };
      repo.createRole(record);
    } else if (record.source === 'builtin' && record.authority.readOnly) {
      record = repo.updateRole(
        record,
        {
          authority: { ...record.authority, readOnly: false },
        },
        record.revision,
      );
    }
    ensureAppointmentMemory(deps, record, now);
  }
  for (const record of repo.listRoles(tenantId, undefined, true)) {
    ensureAppointmentMemory(deps, record, now);
  }
}

export function ensureAppointmentMemory(deps: InstitutionDeps, role: OrganizationRole, now: number): void {
  if (
    deps
      .repository()
      .roleMemories(role.tenantId, role.id, 100)
      .some((item) => item.kind === 'appointment')
  )
    return;
  deps.repository().appendRoleMemory({
    id: randomUUID(),
    tenantId: role.tenantId,
    roleId: role.id,
    kind: 'appointment',
    summary: `岗位建立：${role.name}`,
    evidence: [],
    createdAt: now,
  });
}

export function updateInstitution(
  deps: InstitutionDeps,
  tenantId: string,
  input: Partial<InstitutionPolicies> & { reason: string },
): InstitutionVersion {
  ensureInstitution(deps, tenantId);
  const repo = deps.repository();
  const current = repo.activeInstitution(tenantId)!;
  const policies = normalizePolicies({ ...current.policies, ...input });
  const record: InstitutionVersion = {
    id: randomUUID(),
    tenantId,
    version: current.version + 1,
    status: 'active',
    policies,
    hash: policyHash(policies),
    createdBy: 'human',
    reason: bounded(input.reason, 500, '制度变更原因'),
    createdAt: deps.now(),
  };
  repo.transaction(() => {
    repo.updateInstitution(current, { status: 'superseded' });
    repo.createInstitution(record);
    repo.appendInstitutionAudit({
      id: randomUUID(),
      tenantId,
      version: record.version,
      action: 'update',
      actor: 'human',
      fromVersion: current.version,
      toVersion: record.version,
      beforeHash: current.hash,
      afterHash: record.hash,
      reason: record.reason,
      createdAt: record.createdAt,
    });
  });
  deps.emit('organization.institution.updated', { version: record.version, hash: record.hash });
  return record;
}

export function rollbackInstitution(deps: InstitutionDeps, tenantId: string, version: number, reason: string): InstitutionVersion {
  ensureInstitution(deps, tenantId);
  const repo = deps.repository();
  const current = repo.activeInstitution(tenantId)!;
  const target = repo.institutions(tenantId, 500).find((item) => item.version === version);
  if (!target) throw new OrganizationError(404, 'INSTITUTION_VERSION_NOT_FOUND', '制度版本不存在');
  const policies = normalizePolicies(target.policies);
  const record: InstitutionVersion = {
    id: randomUUID(),
    tenantId,
    version: current.version + 1,
    status: 'active',
    policies,
    hash: policyHash(policies),
    createdBy: 'human',
    reason: `回滚至 v${version}：${bounded(reason, 460, '回滚原因')}`,
    createdAt: deps.now(),
  };
  repo.transaction(() => {
    repo.updateInstitution(current, { status: 'superseded' });
    repo.createInstitution(record);
    repo.appendInstitutionAudit({
      id: randomUUID(),
      tenantId,
      version: record.version,
      action: 'rollback',
      actor: 'human',
      fromVersion: current.version,
      toVersion: record.version,
      beforeHash: current.hash,
      afterHash: record.hash,
      reason: record.reason,
      createdAt: record.createdAt,
    });
  });
  deps.emit('organization.institution.updated', { version: record.version, rollbackTo: version });
  return record;
}
