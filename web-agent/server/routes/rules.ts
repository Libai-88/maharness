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
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RouteDeps } from './shared';
import { loadPolicyRules } from '../../kernel/rules';
import type { PolicyRule } from '../../kernel/rules';

interface RulesService {
  sources: () => { scope: 'global' | 'project'; file: string; exists: boolean; chars: number }[];
  policy: () => PolicyRule[];
  errors: () => string[];
  reload: () => boolean;
  paths: () => { globalDir: string; globalPolicy: string; projectRoot: string };
  promptBlock?: () => string;
}

const SAFE_NAME = /^[\w.\u4e00-\u9fa5-]{1,64}\.md$/;

/** 纯通配工具名（`*`、`**`、`?*`……）：不含任何具体字符 → 覆盖所有工具 */
export function isWildcardTool(tool: string): boolean {
  return /^[*?]+$/.test(String(tool ?? '').trim());
}

/** 一条策略规则是否等于「整体关掉审批」 */
export function isBlanketAllow(r: PolicyRule): boolean {
  return !!r && r.effect === 'allow' && isWildcardTool(r.tool);
}

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

function atomicWrite(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  try { writeFileSync(file, content, 'utf8'); } finally { try { rmSync(tmp, { force: true }); } catch { /* 忽略 */ } }
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
    const globalFiles = existsSync(p.globalDir)
      ? readdirSync(p.globalDir).filter(f => f.endsWith('.md')).map(f => ({
        name: f,
        content: (() => { try { return readFileSync(join(p.globalDir, f), 'utf-8'); } catch { return ''; } })(),
      }))
      : [];
    const projectFiles = s.sources().filter(x => x.scope === 'project' && x.exists).map(x => ({
      name: x.file,
      content: (() => { try { return readFileSync(x.file, 'utf-8'); } catch { return ''; } })(),
    }));
    res.json({
      paths: p,
      policy: s.policy(),
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
    atomicWrite(file, content);
    s.reload();
    res.json({ ok: true, file });
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
    atomicWrite(file, content);
    s.reload();
    res.json({ ok: true, file: rel });
  });

  // 策略规则：整表写入（scope=global → data/rules.json；project → <workspace>/.maharness/rules.json）
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
    const check = loadPolicyRules([file]);
    atomicWrite(file, JSON.stringify({ rules: cleaned }, null, 2));
    const after = loadPolicyRules([file]);
    if (after.errors.length) {
      atomicWrite(file, JSON.stringify({ rules: check.rules }, null, 2));
      return res.status(400).json({ error: `写入后校验失败，已回滚: ${after.errors.join('; ')}` });
    }
    s.reload();
    if (blanket.length) {
      // 已被显式确认的整体放行：留下审计噪音（谁在什么时候把审批门关了）
      console.warn(`[rules] 已写入通配 allow 策略（${blanket.map((r) => r.tool).join(', ')}）→ ${file}：全部工具的审批门已被整体放行`);
    }
    res.json({
      ok: true, file, count: cleaned.length,
      // 前端据此出横幅：策略已把审批门整体放行（不写进响应就没人知道）
      blanketAllow: blanket.length ? blanket.map((r) => ({ id: r.id, tool: r.tool })) : undefined,
    });
  });
}
