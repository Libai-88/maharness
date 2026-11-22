/** OPS-01：租户注册表（默认租户启动时自动创建）。 */
import type { Express } from 'express';
import { tenantIdOf, type RouteDeps } from './shared';

const TENANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function registerTenantRoutes(app: Express, deps: RouteDeps): void {
  const { store } = deps;
  const apiRoleOf = (req: unknown): string | undefined => (req as { apiRole?: unknown } | undefined)?.apiRole as string | undefined;

  app.get('/api/tenants', (req, res) => {
    res.json({ current: tenantIdOf(req), tenants: store.listTenants() });
  });

  app.post('/api/tenants', (req, res) => {
    const id = String(req.body?.id ?? '').trim();
    const name = String(req.body?.name ?? '').trim();
    const maxSessions = Math.trunc(Number(req.body?.maxSessions ?? 0));
    const maxActiveRuns = Math.trunc(Number(req.body?.maxActiveRuns ?? 0));
    const maxCostUsd = Number(req.body?.maxCostUsd ?? 0);
    const maxStorageBytes = Math.trunc(Number(req.body?.maxStorageBytes ?? 0));
    const maxToolCallsPerMinute = Math.trunc(Number(req.body?.maxToolCallsPerMinute ?? 0));
    if (!TENANT_ID_RE.test(id)) {
      return res.status(400).json({ error: '租户 id 仅支持字母/数字/下划线/连字符，长度 1-64' });
    }
    if (!Number.isFinite(maxSessions) || maxSessions < 0 || maxSessions > 100_000) {
      return res.status(400).json({ error: 'maxSessions 需为 0-100000 的整数（0 = 不限制）' });
    }
    if (!Number.isFinite(maxActiveRuns) || maxActiveRuns < 0 || maxActiveRuns > 1_000) {
      return res.status(400).json({ error: 'maxActiveRuns 需为 0-1000 的整数（0 = 不限制）' });
    }
    if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0 || maxCostUsd > 1_000_000_000) {
      return res.status(400).json({ error: 'maxCostUsd 需为 0-1000000000 的数值（0 = 不限制）' });
    }
    if (!Number.isFinite(maxStorageBytes) || maxStorageBytes < 0 || maxStorageBytes > Number.MAX_SAFE_INTEGER) {
      return res.status(400).json({ error: 'maxStorageBytes 需为非负整数字节数（0 = 不限制）' });
    }
    if (!Number.isFinite(maxToolCallsPerMinute) || maxToolCallsPerMinute < 0 || maxToolCallsPerMinute > 1_000_000) {
      return res.status(400).json({ error: 'maxToolCallsPerMinute 需为 0-1000000 的整数（0 = 不限制）' });
    }
    if (store.hasTenant(id)) return res.status(409).json({ error: '租户已存在' });
    try {
      res.json(store.createTenant(id, name, maxSessions, maxActiveRuns, maxCostUsd, maxStorageBytes, maxToolCallsPerMinute));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch('/api/tenants/:id', (req, res) => {
    const id = String(req.params.id ?? '');
    if (!store.hasTenant(id)) return res.status(404).json({ error: '租户不存在' });
    const next = store.updateTenantQuotas(id, {
      ...(req.body?.maxSessions !== undefined ? { maxSessions: Number(req.body.maxSessions) } : {}),
      ...(req.body?.maxActiveRuns !== undefined ? { maxActiveRuns: Number(req.body.maxActiveRuns) } : {}),
      ...(req.body?.maxCostUsd !== undefined ? { maxCostUsd: Number(req.body.maxCostUsd) } : {}),
      ...(req.body?.maxStorageBytes !== undefined ? { maxStorageBytes: Number(req.body.maxStorageBytes) } : {}),
      ...(req.body?.maxToolCallsPerMinute !== undefined ? { maxToolCallsPerMinute: Number(req.body.maxToolCallsPerMinute) } : {}),
    });
    res.json(next);
  });

  app.get('/api/tokens', (req, res) => {
    const role = apiRoleOf(req);
    if (role && role !== 'admin') return res.status(403).json({ error: 'Forbidden: 需要 admin token' });
    const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
    res.json(store.listApiTokens(tenantId));
  });

  app.post('/api/tokens', (req, res) => {
    const role = apiRoleOf(req);
    if (role && role !== 'admin') return res.status(403).json({ error: 'Forbidden: 需要 admin token' });
    const tenantId = String(req.body?.tenantId ?? tenantIdOf(req)).trim();
    if (!store.hasTenant(tenantId)) return res.status(404).json({ error: '租户不存在' });
    const tokenRole = req.body?.role === 'admin' || req.body?.role === 'readonly' ? req.body.role : 'member';
    const label = typeof req.body?.label === 'string' ? req.body.label.slice(0, 120) : undefined;
    const expiresAt = req.body?.expiresAt === undefined ? undefined : Number(req.body.expiresAt);
    if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
      return res.status(400).json({ error: 'expiresAt 必须是未来的毫秒时间戳' });
    }
    const created = store.createApiToken({ tenantId, role: tokenRole, label, expiresAt });
    res.json({ ...created, note: 'token 只在本响应展示一次，请立即保存' });
  });

  app.delete('/api/tokens/:id', (req, res) => {
    const role = apiRoleOf(req);
    if (role && role !== 'admin') return res.status(403).json({ error: 'Forbidden: 需要 admin token' });
    if (!store.revokeApiToken(String(req.params.id ?? ''))) return res.status(404).json({ error: 'token 不存在或已吊销' });
    res.json({ ok: true });
  });
}
