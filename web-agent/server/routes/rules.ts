/**
 * server/routes/rules.ts —— 用户规则管理（读写全局/项目规则文件与策略规则）
 * 安全：只在「data/rules 目录」「工作区内候选文件」「rules.json」三类路径内读写，
 *      路径必须落在允许目录内（防任意写），写入走原子替换。
 *
 * A6-3 收口（策略注入旁路审批门）：
 *  · 变更类方法（PUT）本身受 `x-maharness-token` 门管辖（见 server/index.ts）；
 *  · 另加一层与 token 无关的内容门：**通配 allow**（tool 为 `*`/`**`/`?*` 这类纯通配、
 *    effect 为 allow）等于一次性关掉整个审批机制，是这条旁路的教科书形态
 *    （`{tool:"*",effect:"allow"}` 一条即成）。经 HTTP 写入必须显式确认：
 *    请求体带 `confirm:true`，或环境变量 MAHARNESS_ALLOW_BLANKET_ALLOW=1；
 *    否则 400 + 中文说明（想放行具体工具请写工具名/glob，别用纯通配）。
 *  · 直接编辑 data/rules.json 文件仍然可行——那是文件权限层面的既有事实（本机同权限进程
 *    本就能写它），本门只保证「一次无意的 HTTP 调用」关不掉审批。
 *  · 状态可见：已生效的通配 allow 由 GET /api/security 如实报出（policy.blanketAllow），
 *    前端能显示「当前审批门已被策略整体放行」而不是靠 401/无审批反推。
 */
import type { Express } from 'express';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RouteDeps } from './shared';
import { dryRunPolicy, isBlanketAllow, isWildcardTool, loadPolicyRules, validatePolicyRules } from '../../kernel/rules';
import type { PolicyRule } from '../../kernel/rules';
import { atomicWriteFileSync, ConcurrentWriteError, fileRevisionSync } from '../../kernel/atomic-file';

interface RulesService {
  sources: () => { scope: 'global' | 'project'; file: string; exists: boolean; chars: number }[];
  policy: () => PolicyRule[];
  errors: () => string[];
  reload: () => boolean;
  paths: () => { globalDir: string; globalPolicy: string; projectRoot: string };
  promptBlock?: () => string;
}

const SAFE_NAME = /^[\w.\u4e00-\u9fa5-]{1,64}\.md$/;
const POLICY_HISTORY_LIMIT = 20;
const SAFE_HISTORY_NAME = /^[a-z]+-[\w.-]+\.json$/;

export { isBlanketAllow, isWildcardTool };

/** 已生效策略里的通配 allow 明细（/api/security 用；文件不存在/解析失败都按空处理） */
export function blanketAllowIn(files: string[]): { file: string; tool: string; id: string }[] {
  const out: { file: string; tool: string; id: string }[] = [];
  for (const f of files) {
    try {
      if (!existsSync(f)) continue;
      for (const r of loadPolicyRules([f]).rules) {
        if (isBlanketAllow(r)) out.push({ file: f, tool: r.tool, id: r.id });
      }
    } catch { /* 状态接口绝不因规则文件问题而 500 */ }
  }
  return out;
}

/**
 * 供 GET /api/security 用的策略姿态：当前「全局 + 项目」策略文件里是否存在通配 allow。
 * rules 服务不可用（插件未加载）时返回 available:false——状态接口宁可如实说不知道，
 * 也不把「取不到」报成「没有风险」。
 */
export function policyPosture(kernel: RouteDeps['kernel']): {
  available: boolean;
  files: string[];
  blanketAllow: { file: string; tool: string; id: string }[];
} {
  const s = kernel.plugins.resolveService('service:rules') as RulesService | undefined;
  if (!s) return { available: false, files: [], blanketAllow: [] };
  try {
    const p = s.paths();
    const files = [p.globalPolicy, join(p.projectRoot, '.maharness', 'rules.json')].filter((f) => existsSync(f));
    return { available: true, files, blanketAllow: blanketAllowIn(files) };
  } catch {
    return { available: false, files: [], blanketAllow: [] };
  }
}

function atomicWrite(file: string, content: string, expectedRevision?: string): void {
  atomicWriteFileSync(file, content, { expectedRevision });
}

function concurrentRuleWrite(res: { status: (code: number) => { json: (body: unknown) => unknown } }, error: unknown): boolean {
  if (!(error instanceof ConcurrentWriteError)) return false;
  res.status(409).json({ error: '规则文件已被其他写入者修改，请重新读取后再保存' });
  return true;
}

function policyHistoryDir(dataDir: string): string {
  return join(dataDir, 'rules-policy-history');
}

/** 写入前保存上一版策略；只保留最近 N 份，失败不阻断正式写入（回滚是增强，不是写入前置条件）。 */
function snapshotPolicy(file: string, scope: 'global' | 'project', dataDir: string): string | null {
  try {
    if (!existsSync(file)) return null;
    const dir = policyHistoryDir(dataDir);
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${scope}-${stamp}-${randomUUID().slice(0, 8)}.json`;
    writeFileSync(join(dir, name), readFileSync(file, 'utf-8'), 'utf-8');
    const entries = readdirSync(dir)
      .filter((item) => item.startsWith(`${scope}-`) && item.endsWith('.json'))
      .sort()
      .reverse();
    for (const stale of entries.slice(POLICY_HISTORY_LIMIT)) {
      try { unlinkSync(join(dir, stale)); } catch { /* 历史清理失败不影响主写入 */ }
    }
    return name;
  } catch {
    return null;
  }
}

function listPolicyHistory(dataDir: string, scope?: 'global' | 'project'): {
  name: string; scope: 'global' | 'project'; createdAt: number; bytes: number;
}[] {
  const dir = policyHistoryDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => SAFE_HISTORY_NAME.test(name) && (!scope || name.startsWith(`${scope}-`)))
    .map((name) => {
      const full = join(dir, name);
      const stat = statSync(full);
      return {
        name,
        scope: name.split('-')[0] as 'global' | 'project',
        createdAt: stat.mtimeMs,
        bytes: stat.size,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, POLICY_HISTORY_LIMIT);
}

export function registerRulesRoutes(app: Express, deps: RouteDeps): void {
  const { kernel } = deps;
  const svc = (): RulesService | undefined => kernel.plugins.resolveService('service:rules') as RulesService | undefined;

  const within = (file: string, root: string): boolean => {
    const r = resolve(root).toLowerCase();
    const f = resolve(file).toLowerCase();
    return f === r || f.startsWith(r + '\\') || f.startsWith(r + '/');
  };

  app.get('/api/rules', (_req, res) => {
    const s = svc();
    if (!s) return res.status(503).json({ error: 'rules 插件未加载' });
    const p = s.paths();
    const globalNames = existsSync(p.globalDir) ? readdirSync(p.globalDir).filter(f => f.endsWith('.md')) : [];
    const globalFiles = globalNames.map(f => ({
        name: f,
        content: (() => { try { return readFileSync(join(p.globalDir, f), 'utf-8'); } catch { return ''; } })(),
        revision: fileRevisionSync(join(p.globalDir, f)),
      }));
    const projectFiles = s.sources().filter(x => x.scope === 'project' && x.exists).map(x => ({
      name: x.file,
      content: (() => { try { return readFileSync(x.file, 'utf-8'); } catch { return ''; } })(),
      revision: fileRevisionSync(x.file),
    }));
    res.json({
      paths: p,
      policy: s.policy(),
      policyRevisions: {
        global: fileRevisionSync(p.globalPolicy),
        project: fileRevisionSync(join(p.projectRoot, '.maharness', 'rules.json')),
      },
      ruleFileRevisions: {
        global: Object.fromEntries([...globalNames, 'maharness.md', 'new-rule.md'].map((name) => [name, fileRevisionSync(join(p.globalDir, name))])),
        project: Object.fromEntries(['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', '.agents/AGENTS.md'].map((name) => [name, fileRevisionSync(join(p.projectRoot, name))])),
      },
      policyFiles: [p.globalPolicy, join(p.projectRoot, '.maharness', 'rules.json')].filter(f => existsSync(f)),
      errors: s.errors(),
      globalFiles,
      projectFiles,
      promptChars: s.promptBlock?.().length ?? 0,
    });
  });

  // 写全局规则文件（data/rules/<name>.md）
  app.put('/api/rules/global/:name', (req, res) => {
    const s = svc();
    if (!s) return res.status(503).json({ error: 'rules 插件未加载' });
    const name = String(req.params.name);
    if (!SAFE_NAME.test(name)) return res.status(400).json({ error: '文件名只能是 中文/字母/数字/._- 且以 .md 结尾' });
    const content = String(req.body?.content ?? '');
    if (content.length > 200_000) return res.status(400).json({ error: '单文件超过 200k 字符' });
    const file = join(s.paths().globalDir, name);
    if (!within(file, s.paths().globalDir)) return res.status(400).json({ error: '路径越界' });
    const revision = typeof req.body?.revision === 'string' ? req.body.revision : undefined;
    if (!revision) return res.status(428).json({ error: '保存规则前须携带读取到的文件版本' });
    if (revision !== fileRevisionSync(file)) return res.status(409).json({ error: '规则文件已被其他写入者修改，请重新读取后再保存' });
    try { atomicWrite(file, content, revision); }
    catch (error) { if (concurrentRuleWrite(res, error)) return; throw error; }
    s.reload();
    res.json({ ok: true, file, revision: fileRevisionSync(file) });
  });

  // 写项目规则文件（只允许 AGENTS.md / CLAUDE.md / .maharness/rules/*.md）
  app.put('/api/rules/project', (req, res) => {
    const s = svc();
    if (!s) return res.status(503).json({ error: 'rules 插件未加载' });
    const root = s.paths().projectRoot;
    const rel = String(req.body?.path ?? 'AGENTS.md').replace(/\\/g, '/');
    const allowed = ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', '.agents/AGENTS.md'];
    const ok = allowed.includes(rel) || (rel.startsWith('.maharness/rules/') && SAFE_NAME.test(rel.split('/').pop() ?? ''));
    if (!ok) return res.status(400).json({ error: `只允许写入 ${allowed.join(' / ')} 或 .maharness/rules/*.md` });
    const file = join(root, rel);
    if (!within(file, root)) return res.status(400).json({ error: '路径越界' });
    const content = String(req.body?.content ?? '');
    if (content.length > 200_000) return res.status(400).json({ error: '单文件超过 200k 字符' });
    const revision = typeof req.body?.revision === 'string' ? req.body.revision : undefined;
    if (!revision) return res.status(428).json({ error: '保存规则前须携带读取到的文件版本' });
    if (revision !== fileRevisionSync(file)) return res.status(409).json({ error: '规则文件已被其他写入者修改，请重新读取后再保存' });
    try { atomicWrite(file, content, revision); }
    catch (error) { if (concurrentRuleWrite(res, error)) return; throw error; }
    s.reload();
    res.json({ ok: true, file: rel, revision: fileRevisionSync(file) });
  });

  // 策略规则：整表写入（scope=global → data/rules.json；project → <workspace>/.maharness/rules.json）
  app.post('/api/rules/policy/dry-run', (req, res) => {
    const s = svc();
    if (!s) return res.status(503).json({ error: 'rules 插件未加载' });
    const candidate = Array.isArray(req.body?.rules) ? req.body.rules as PolicyRule[] : null;
    if (!candidate) return res.status(400).json({ error: 'rules 须为数组' });
    const probes = Array.isArray(req.body?.probes) ? req.body.probes as { tool?: unknown; args?: unknown }[] : [];
    if (probes.length > 50) return res.status(400).json({ error: 'probes 最多 50 条' });
    const cleaned: PolicyRule[] = [];
    for (const rule of candidate) {
      if (!rule || typeof rule !== 'object') return res.status(400).json({ error: '每条规则须为对象' });
      cleaned.push({ ...rule, id: rule.id || randomUUID().slice(0, 8) });
    }
    const issues = validatePolicyRules(cleaned);
    const fatal = issues.filter((issue) => issue.level === 'error');
    if (fatal.length) return res.status(400).json({ error: '候选策略存在错误', issues });
    const probeList = probes
      .filter((probe) => typeof probe?.tool === 'string' && probe.tool.trim())
      .map((probe) => ({ tool: String(probe.tool).trim(), args: probe.args ?? {} }));
    const result = dryRunPolicy(s.policy(), cleaned, probeList);
    res.json({
      ok: true,
      changed: result.changed,
      diff: result.diff,
      probes: result.probes,
      issues,
      blanketAllow: cleaned.filter(isBlanketAllow).map((rule) => ({ id: rule.id, tool: rule.tool })),
    });
  });

  app.get('/api/rules/policy/history', (req, res) => {
    const scope = req.query.scope === 'project' ? 'project' : req.query.scope === 'global' ? 'global' : undefined;
    res.json(listPolicyHistory(kernel.paths.data, scope));
  });

  app.post('/api/rules/policy/rollback', (req, res) => {
    const s = svc();
    if (!s) return res.status(503).json({ error: 'rules 插件未加载' });
    const scope = req.body?.scope === 'project' ? 'project' : 'global';
    const snapshot = String(req.body?.snapshot ?? '');
    if (!SAFE_HISTORY_NAME.test(snapshot) || !snapshot.startsWith(`${scope}-`)) {
      return res.status(400).json({ error: '快照名非法' });
    }
    const dir = policyHistoryDir(kernel.paths.data);
    const source = join(dir, snapshot);
    if (!within(source, dir) || !existsSync(source)) return res.status(404).json({ error: '快照不存在' });
    const p = s.paths();
    const file = scope === 'project' ? join(p.projectRoot, '.maharness', 'rules.json') : p.globalPolicy;
    if (scope === 'project' && !within(file, p.projectRoot)) return res.status(400).json({ error: '路径越界' });
    const expectedRevision = typeof req.body?.revision === 'string' ? req.body.revision : undefined;
    if (!expectedRevision) return res.status(428).json({ error: '回滚前须携带当前策略文件版本' });
    if (expectedRevision !== fileRevisionSync(file)) return res.status(409).json({ error: '策略文件已被其他写入者修改，请重新读取后再回滚' });
    const parsed = loadPolicyRules([source]);
    if (parsed.errors.length) return res.status(400).json({ error: `快照校验失败: ${parsed.errors.join('; ')}` });
    const parsedFatal = validatePolicyRules(parsed.rules).filter((issue) => issue.level === 'error');
    if (parsedFatal.length) return res.status(400).json({ error: '快照包含非法规则', issues: parsedFatal });
    const currentSnapshot = snapshotPolicy(file, scope, kernel.paths.data);
    try { atomicWrite(file, JSON.stringify({ rules: parsed.rules }, null, 2), expectedRevision); }
    catch (error) { if (concurrentRuleWrite(res, error)) return; throw error; }
    s.reload();
    res.json({
      ok: true, file, snapshot: currentSnapshot,
      revision: fileRevisionSync(file), count: parsed.rules.length,
    });
  });

  app.put('/api/rules/policy', (req, res) => {
    const s = svc();
    if (!s) return res.status(503).json({ error: 'rules 插件未加载' });
    const scope = String(req.body?.scope ?? 'global');
    const rules = Array.isArray(req.body?.rules) ? req.body.rules as PolicyRule[] : null;
    if (!rules) return res.status(400).json({ error: 'rules 须为数组' });
    const cleaned: PolicyRule[] = [];
    for (const r of rules) {
      if (!r || typeof r.tool !== 'string') return res.status(400).json({ error: '每条规则须有 tool' });
      if (!['allow', 'deny', 'require-approval'].includes(r.effect)) return res.status(400).json({ error: `effect 非法: ${r.effect}` });
      cleaned.push({ ...r, id: r.id || randomUUID().slice(0, 8) });
    }
    const fatal = validatePolicyRules(cleaned).filter((issue) => issue.level === 'error');
    if (fatal.length) return res.status(400).json({ error: '策略规则非法', issues: fatal });
    // A6-3 内容门：通配 allow（tool 纯通配 + effect=allow）一次写入就把全部工具的审批门
    // 整体关掉，所以经 HTTP 写必须显式确认；具体工具名/glob 不受影响。
    const blanket = cleaned.filter(isBlanketAllow);
    if (blanket.length && process.env.MAHARNESS_ALLOW_BLANKET_ALLOW !== '1' && req.body?.confirm !== true) {
      return res.status(400).json({
        error: `拒绝：规则 ${blanket.map((r) => r.id).join('、')} 是「通配 allow」（tool=${blanket[0].tool} + effect=allow），`
          + '等于把全部工具的审批门整体关掉。要放行具体工具请写工具名或 glob（如 read_file、powershell_*）；'
          + '确需整体关掉审批，请在请求体带 confirm:true，或设 MAHARNESS_ALLOW_BLANKET_ALLOW=1。',
        blanketAllow: blanket.map((r) => ({ id: r.id, tool: r.tool })),
      });
    }
    const p = s.paths();
    const file = scope === 'project' ? join(p.projectRoot, '.maharness', 'rules.json') : p.globalPolicy;
    if (scope === 'project' && !within(file, p.projectRoot)) return res.status(400).json({ error: '路径越界' });
    const expectedRevision = typeof req.body?.revision === 'string' ? req.body.revision : undefined;
    if (!expectedRevision) return res.status(428).json({ error: '保存策略前须携带读取到的文件版本' });
    if (expectedRevision !== fileRevisionSync(file)) return res.status(409).json({ error: '策略文件已被其他写入者修改，请重新读取后再保存' });
    const check = loadPolicyRules([file]);
    const previousSnapshot = snapshotPolicy(file, scope === 'project' ? 'project' : 'global', kernel.paths.data);
    try { atomicWrite(file, JSON.stringify({ rules: cleaned }, null, 2), expectedRevision); }
    catch (error) { if (concurrentRuleWrite(res, error)) return; throw error; }
    const after = loadPolicyRules([file]);
    if (after.errors.length) {
      atomicWrite(file, JSON.stringify({ rules: check.rules }, null, 2), fileRevisionSync(file));
      return res.status(400).json({ error: `写入后校验失败，已回滚: ${after.errors.join('; ')}` });
    }
    s.reload();
    if (blanket.length) {
      // 已被显式确认的整体放行：留下审计噪音（谁在什么时候把审批门关了）
      console.warn(`[rules] 已写入通配 allow 策略（${blanket.map((r) => r.tool).join(', ')}）→ ${file}：全部工具的审批门已被整体放行`);
    }
    res.json({
      ok: true, file, count: cleaned.length, revision: fileRevisionSync(file),
      previousSnapshot: previousSnapshot ?? undefined,
      // 前端据此出横幅：策略已把审批门整体放行（不写进响应就没人知道）
      blanketAllow: blanket.length ? blanket.map((r) => ({ id: r.id, tool: r.tool })) : undefined,
    });
  });
}
