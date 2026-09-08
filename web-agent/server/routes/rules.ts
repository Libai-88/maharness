/**
 * server/routes/rules.ts —— 用户规则管理（读写全局/项目规则文件与策略规则）
 * 安全：只在「data/rules 目录」「工作区内候选文件」「rules.json」三类路径内读写，
 *      路径必须落在允许目录内（防任意写），写入走原子替换。
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
    res.json({ ok: true, file, count: cleaned.length });
  });
}
