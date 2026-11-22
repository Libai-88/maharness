/** server/routes/rules-policy.ts —— 策略规则端点（dry-run / 历史 / 回滚 / 整表写入），从 rules.ts 拆出 */
import type { Express, Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { fileRevisionSync } from '../../kernel/atomic-file';
import { dryRunPolicy, isBlanketAllow, loadPolicyRules, validatePolicyRules } from '../../kernel/rules';
import type { PolicyRule } from '../../kernel/rules';
import type { RouteDeps } from './shared';
import {
  atomicWrite,
  concurrentRuleWrite,
  listPolicyHistory,
  policyHistoryDir,
  SAFE_HISTORY_NAME,
  snapshotPolicy,
  withinPath,
} from './rules-support';
import type { RulesService } from './rules-support';

/** 候选规则补 id；`requireTool` 为 true 时用于整表写入（要求 tool 必填）。 */
function normalizeRules(raw: unknown, requireTool: boolean): { rules?: PolicyRule[]; error?: string } {
  if (!Array.isArray(raw)) return { error: 'rules 须为数组' };
  const cleaned: PolicyRule[] = [];
  for (const rule of raw as PolicyRule[]) {
    if (!rule || typeof rule !== 'object') return { error: '每条规则须为对象' };
    if (requireTool) {
      if (typeof rule.tool !== 'string') return { error: '每条规则须有 tool' };
      if (!['allow', 'deny', 'require-approval'].includes(rule.effect)) return { error: `effect 非法: ${rule.effect}` };
    }
    cleaned.push({ ...rule, id: rule.id || randomUUID().slice(0, 8) });
  }
  return { rules: cleaned };
}

/** 策略文件定位 + 项目路径越界检查。 */
function policyTarget(s: RulesService, scope: 'project' | 'global'): { file: string; error?: string } {
  const p = s.paths();
  const file = scope === 'project' ? join(p.projectRoot, '.maharness', 'rules.json') : p.globalPolicy;
  if (scope === 'project' && !withinPath(file, p.projectRoot)) return { file, error: '路径越界' };
  return { file };
}

function handleDryRun(s: RulesService, req: Request, res: Response): void {
  const normalized = normalizeRules(req.body?.rules, false);
  if (normalized.error) {
    res.status(400).json({ error: normalized.error });
    return;
  }
  const candidate = normalized.rules!;
  const probes = Array.isArray(req.body?.probes) ? (req.body.probes as { tool?: unknown; args?: unknown }[]) : [];
  if (probes.length > 50) {
    res.status(400).json({ error: 'probes 最多 50 条' });
    return;
  }
  const issues = validatePolicyRules(candidate);
  const fatal = issues.filter((issue) => issue.level === 'error');
  if (fatal.length) {
    res.status(400).json({ error: '候选策略存在错误', issues });
    return;
  }
  const probeList = probes
    .filter((probe) => typeof probe?.tool === 'string' && probe.tool.trim())
    .map((probe) => ({ tool: String(probe.tool).trim(), args: probe.args ?? {} }));
  const result = dryRunPolicy(s.policy(), candidate, probeList);
  res.json({
    ok: true,
    changed: result.changed,
    diff: result.diff,
    probes: result.probes,
    issues,
    blanketAllow: candidate.filter(isBlanketAllow).map((rule) => ({ id: rule.id, tool: rule.tool })),
  });
}

function handleRollback(deps: RouteDeps, s: RulesService, req: Request, res: Response): void {
  const scope = req.body?.scope === 'project' ? 'project' : 'global';
  const snapshot = String(req.body?.snapshot ?? '');
  if (!SAFE_HISTORY_NAME.test(snapshot) || !snapshot.startsWith(`${scope}-`)) {
    res.status(400).json({ error: '快照名非法' });
    return;
  }
  const dir = policyHistoryDir(deps.kernel.paths.data);
  const source = join(dir, snapshot);
  if (!withinPath(source, dir) || !existsSync(source)) {
    res.status(404).json({ error: '快照不存在' });
    return;
  }
  const target = policyTarget(s, scope);
  if (target.error) {
    res.status(400).json({ error: target.error });
    return;
  }
  const expectedRevision = typeof req.body?.revision === 'string' ? req.body.revision : undefined;
  if (!expectedRevision) {
    res.status(428).json({ error: '回滚前须携带当前策略文件版本' });
    return;
  }
  if (expectedRevision !== fileRevisionSync(target.file)) {
    res.status(409).json({ error: '策略文件已被其他写入者修改，请重新读取后再回滚' });
    return;
  }
  const parsed = loadPolicyRules([source]);
  if (parsed.errors.length) {
    res.status(400).json({ error: `快照校验失败: ${parsed.errors.join('; ')}` });
    return;
  }
  const parsedFatal = validatePolicyRules(parsed.rules).filter((issue) => issue.level === 'error');
  if (parsedFatal.length) {
    res.status(400).json({ error: '快照包含非法规则', issues: parsedFatal });
    return;
  }
  const currentSnapshot = snapshotPolicy(target.file, scope, deps.kernel.paths.data);
  try {
    atomicWrite(target.file, JSON.stringify({ rules: parsed.rules }, null, 2), expectedRevision);
  } catch (error) {
    if (concurrentRuleWrite(res, error)) return;
    throw error;
  }
  s.reload();
  res.json({
    ok: true,
    file: target.file,
    snapshot: currentSnapshot,
    revision: fileRevisionSync(target.file),
    count: parsed.rules.length,
  });
}

/** A6-3 内容门：通配 allow 等于把全部工具的审批门整体关掉，必须显式确认。 */
function rejectBlanketAllow(req: Request, res: Response, blanket: PolicyRule[]): boolean {
  if (!blanket.length || process.env.MAHARNESS_ALLOW_BLANKET_ALLOW === '1' || req.body?.confirm === true) return false;
  res.status(400).json({
    error:
      `拒绝：规则 ${blanket.map((r) => r.id).join('、')} 是「通配 allow」（tool=${blanket[0].tool} + effect=allow），` +
      '等于把全部工具的审批门整体关掉。要放行具体工具请写工具名或 glob（如 read_file、powershell_*）；' +
      '确需整体关掉审批，请在请求体带 confirm:true，或设 MAHARNESS_ALLOW_BLANKET_ALLOW=1。',
    blanketAllow: blanket.map((r) => ({ id: r.id, tool: r.tool })),
  });
  return true;
}

interface PutPlan {
  rules: PolicyRule[];
  target: { file: string };
  blanket: PolicyRule[];
  previousSnapshot: ReturnType<typeof snapshotPolicy>;
}

/** 写入前的前置校验：结构、语义、通配放行内容门、目标文件与版本乐观锁。 */
function planPut(deps: RouteDeps, s: RulesService, req: Request, res: Response): PutPlan | undefined {
  const scope = String(req.body?.scope ?? 'global') === 'project' ? 'project' : 'global';
  const normalized = normalizeRules(req.body?.rules, true);
  if (normalized.error) {
    res.status(400).json({ error: normalized.error });
    return undefined;
  }
  const rules = normalized.rules!;
  const fatal = validatePolicyRules(rules).filter((issue) => issue.level === 'error');
  if (fatal.length) {
    res.status(400).json({ error: '策略规则非法', issues: fatal });
    return undefined;
  }
  const blanket = rules.filter(isBlanketAllow);
  if (rejectBlanketAllow(req, res, blanket)) return undefined;
  const target = policyTarget(s, scope);
  if (target.error) {
    res.status(400).json({ error: target.error });
    return undefined;
  }
  const expectedRevision = typeof req.body?.revision === 'string' ? req.body.revision : undefined;
  if (!expectedRevision) {
    res.status(428).json({ error: '保存策略前须携带读取到的文件版本' });
    return undefined;
  }
  if (expectedRevision !== fileRevisionSync(target.file)) {
    res.status(409).json({ error: '策略文件已被其他写入者修改，请重新读取后再保存' });
    return undefined;
  }
  return { rules, target, blanket, previousSnapshot: snapshotPolicy(target.file, scope, deps.kernel.paths.data) };
}

/** 原子写入 + 写后回读校验（失败即回滚）+ 重新加载 + 审计与响应。 */
function writePolicyFile(s: RulesService, plan: PutPlan, res: Response): void {
  const check = loadPolicyRules([plan.target.file]);
  try {
    atomicWrite(plan.target.file, JSON.stringify({ rules: plan.rules }, null, 2), fileRevisionSync(plan.target.file));
  } catch (error) {
    if (concurrentRuleWrite(res, error)) return;
    throw error;
  }
  const after = loadPolicyRules([plan.target.file]);
  if (after.errors.length) {
    atomicWrite(plan.target.file, JSON.stringify({ rules: check.rules }, null, 2), fileRevisionSync(plan.target.file));
    res.status(400).json({ error: `写入后校验失败，已回滚: ${after.errors.join('; ')}` });
    return;
  }
  s.reload();
  const blanketAllow = plan.blanket.length ? plan.blanket.map((r) => ({ id: r.id, tool: r.tool })) : undefined;
  if (blanketAllow)
    // 已被显式确认的整体放行：留下审计噪音（谁在什么时候把审批门关了）
    console.warn(
      `[rules] 已写入通配 allow 策略（${plan.blanket.map((r) => r.tool).join(', ')}）→ ${plan.target.file}：全部工具的审批门已被整体放行`,
    );
  res.json({
    ok: true,
    file: plan.target.file,
    count: plan.rules.length,
    revision: fileRevisionSync(plan.target.file),
    previousSnapshot: plan.previousSnapshot ?? undefined,
    // 前端据此出横幅：策略已把审批门整体放行（不写进响应就没人知道）
    blanketAllow,
  });
}

function handlePut(deps: RouteDeps, s: RulesService, req: Request, res: Response): void {
  const plan = planPut(deps, s, req, res);
  if (!plan) return;
  writePolicyFile(s, plan, res);
}

export function registerPolicyRoutes(app: Express, deps: RouteDeps, svc: () => RulesService | undefined): void {
  const requireService = (res: Response): RulesService | undefined => {
    const s = svc();
    if (!s) res.status(503).json({ error: 'rules 插件未加载' });
    return s;
  };

  app.post('/api/rules/policy/dry-run', (req, res) => {
    const s = requireService(res);
    if (s) handleDryRun(s, req, res);
  });
  app.get('/api/rules/policy/history', (req, res) => {
    const scope = req.query.scope === 'project' ? 'project' : req.query.scope === 'global' ? 'global' : undefined;
    res.json(listPolicyHistory(deps.kernel.paths.data, scope));
  });
  app.post('/api/rules/policy/rollback', (req, res) => {
    const s = requireService(res);
    if (s) handleRollback(deps, s, req, res);
  });
  app.put('/api/rules/policy', (req, res) => {
    const s = requireService(res);
    if (s) handlePut(deps, s, req, res);
  });
}
