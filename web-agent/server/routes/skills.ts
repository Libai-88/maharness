/**
 * server/routes/skills.ts —— Skills 管理（发现源/市场安装/GitHub 锁文件同步/用量台账）
 */
import type { Express } from 'express';
import { existsSync, readdirSync, readFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RouteDeps } from './shared';
import { readLockFile, installSkill } from '../../kernel/skillsSync';
import { parseFrontMatter, fmString } from '../../kernel/frontmatter';
import type { SkillSource } from '../../core/skills/index';

interface SkillsService {
  list: () => { name: string; description: string; source: string; shadowed?: string[]; bodyChars?: number }[];
  get: (n: string) => { ok: boolean; content?: string; error?: string };
  readBySource?: (source: SkillSource, name: string) => string | null;
  usage?: () => Record<string, { indexShown: number; reads: number; bodyTokens: number; lastReadAt?: number }>;
  invalidateCache?: () => void;
}

export function registerSkillRoutes(app: Express, deps: RouteDeps): void {
  const { kernel } = deps;
  const getSkillsService = (): SkillsService | undefined =>
    kernel.plugins.resolveService('service:skills') as SkillsService | undefined;
  const marketDir = join(kernel.rootDir, 'market');
  const userSkillsDir = join(kernel.rootDir, 'data', 'skills');

  const descOf = (dir: string): string => {
    try {
      const fm = parseFrontMatter(readFileSync(join(dir, 'SKILL.md'), 'utf-8'));
      return fmString(fm.data, 'description') || '(无描述)';
    } catch { return '(无描述)'; }
  };

  app.get('/api/skills', (_req, res) => {
    const installed = getSkillsService()?.list() ?? [];
    const market: { name: string; description: string }[] = [];
    if (existsSync(marketDir)) {
      for (const e of readdirSync(marketDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const skillDir = join(marketDir, e.name);
        if (!existsSync(join(skillDir, 'SKILL.md'))) continue;
        if (installed.some((s) => s.name === e.name)) continue;
        market.push({ name: e.name, description: descOf(skillDir) });
      }
    }
    res.json({ installed, market });
  });

  // skills-lock.json（GitHub 源 + 哈希锁）：可同步项与本地状态
  app.get('/api/skills/lock', (_req, res) => {
    const { file, data, error } = readLockFile(kernel.rootDir);
    const installed = new Set((getSkillsService()?.list() ?? []).map(s => s.name));
    const skills = Object.entries(data?.skills ?? {}).map(([name, e]) => ({
      name,
      source: e.source,
      sourceType: e.sourceType ?? 'github',
      skillPath: e.skillPath,
      computedHash: e.computedHash,
      installed: installed.has(name),
    }));
    res.json({ file, error, count: skills.length, skills });
  });

  // 按锁文件安装（默认只装缺失项；force=true 覆盖并放行哈希不符）
  app.post('/api/skills/sync', async (req, res) => {
    const only = Array.isArray(req.body?.names) ? req.body.names.map(String) : null;
    const force = !!req.body?.force;
    const { data, error } = readLockFile(kernel.rootDir);
    if (error) return res.status(400).json({ error });
    if (!data) return res.status(404).json({ error: '未找到 skills-lock.json' });
    mkdirSync(userSkillsDir, { recursive: true });
    const results = [];
    for (const [name, entry] of Object.entries(data.skills)) {
      if (only && !only.includes(name)) continue;
      results.push(await installSkill(name, entry, userSkillsDir, { force }));
    }
    if (results.some(r => r.installed)) {
      getSkillsService()?.invalidateCache?.();
      try { await kernel.plugins.reload('skills'); } catch { /* 重载失败：下次加载仍会看到新目录 */ }
    }
    res.json({ ok: results.every(r => r.ok), results });
  });

  app.get('/api/skills/usage', (_req, res) => {
    res.json({ usage: getSkillsService()?.usage?.() ?? {} });
  });

  app.post('/api/skills/install', async (req, res) => {
    const name = String(req.body?.name ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!name) return res.status(400).json({ error: '缺少技能名' });
    const src = join(marketDir, name);
    if (!existsSync(join(src, 'SKILL.md'))) return res.status(404).json({ error: `市场中不存在技能: ${name}` });
    const dest = join(userSkillsDir, name);
    if (existsSync(dest)) return res.status(400).json({ error: `技能已安装: ${name}` });
    mkdirSync(userSkillsDir, { recursive: true });
    cpSync(src, dest, { recursive: true });
    try {
      getSkillsService()?.invalidateCache?.();
      await kernel.plugins.reload('skills');
    } catch (err) {
      rmSync(dest, { recursive: true, force: true });
      return res.status(500).json({ error: `技能安装失败（重载插件出错）: ${err instanceof Error ? err.message : String(err)}` });
    }
    res.json({ ok: true, name });
  });

  app.post('/api/skills/:name/uninstall', async (req, res) => {
    const name = String(req.params.name).replace(/[^a-zA-Z0-9_-]/g, '');
    const dest = join(userSkillsDir, name);
    if (!existsSync(dest)) return res.status(404).json({ error: `技能未安装: ${name}` });
    rmSync(dest, { recursive: true, force: true });
    getSkillsService()?.invalidateCache?.();
    await kernel.plugins.reload('skills');
    res.json({ ok: true, name });
  });

  app.get('/api/skills/:source/:name/read', (req, res) => {
    const source = String(req.params.source) as SkillSource;
    const name = String(req.params.name).replace(/[^a-zA-Z0-9_-]/g, '');
    const svc = getSkillsService();
    const content = svc?.readBySource ? svc.readBySource(source, name) : null;
    if (content !== null) return res.json({ name, content });
    // 兜底：老式按来源目录直读（服务未提供 readBySource 时）
    const dir = source === 'builtin'
      ? join(kernel.rootDir, 'core', 'skills', 'builtin')
      : source === 'pack'
        ? join(kernel.rootDir, 'vendor')
        : userSkillsDir;
    const direct = join(dir, name, 'SKILL.md');
    if (existsSync(direct)) return res.json({ name, content: readFileSync(direct, 'utf-8') });
    if (source === 'pack') {
      for (const pack of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, pack.name, name, 'SKILL.md');
        if (existsSync(p)) return res.json({ name, content: readFileSync(p, 'utf-8') });
        const nested = join(dir, pack.name, 'skills', name, 'SKILL.md');
        if (existsSync(nested)) return res.json({ name, content: readFileSync(nested, 'utf-8') });
      }
    }
    res.status(404).json({ error: '技能不存在' });
  });
}
