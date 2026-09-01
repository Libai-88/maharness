/**
 * server/routes/skills.ts —— Skills（内置 + 市场安装管理）
 */
import type { Express } from 'express';
import { existsSync, readdirSync, readFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RouteDeps } from './shared';

interface SkillService { list: () => { name: string; description: string; source: string }[]; get: (n: string) => { ok: boolean; content?: string; error?: string } }

export function registerSkillRoutes(app: Express, deps: RouteDeps): void {
  const { kernel } = deps;
  const getSkillsService = (): SkillService | undefined =>
    kernel.plugins.resolveService('service:skills') as SkillService | undefined;
  const marketDir = join(kernel.rootDir, 'market');
  const userSkillsDir = join(kernel.rootDir, 'data', 'skills');

  /** 读取市场 skill 的 description（frontmatter） */
  function marketSkillDesc(dir: string): string {
    try {
      const md = readFileSync(join(dir, 'SKILL.md'), 'utf-8');
      const m = md.match(/^---\n([\s\S]*?)\n---/);
      const desc = m?.[1].match(/description:\s*(.+)/);
      return desc ? desc[1].trim() : '(无描述)';
    } catch { return '(无描述)'; }
  }

  app.get('/api/skills', (_req, res) => {
    const installed = getSkillsService()?.list() ?? [];
    const market: { name: string; description: string }[] = [];
    if (existsSync(marketDir)) {
      for (const e of readdirSync(marketDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const skillDir = join(marketDir, e.name);
        if (!existsSync(join(skillDir, 'SKILL.md'))) continue;
        if (installed.some((s) => s.name === e.name)) continue; // 已安装不重复显示
        market.push({ name: e.name, description: marketSkillDesc(skillDir) });
      }
    }
    res.json({ installed, market });
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
      await kernel.plugins.reload('skills'); // 热加载新技能
    } catch (err) {
      rmSync(dest, { recursive: true, force: true }); // 重载失败则回滚安装
      return res.status(500).json({ error: `技能安装失败（重载插件出错）: ${err instanceof Error ? err.message : String(err)}` });
    }
    res.json({ ok: true, name });
  });

  app.post('/api/skills/:name/uninstall', async (req, res) => {
    const name = String(req.params.name).replace(/[^a-zA-Z0-9_-]/g, '');
    const dest = join(userSkillsDir, name);
    if (!existsSync(dest)) return res.status(404).json({ error: `技能未安装: ${name}` });
    rmSync(dest, { recursive: true, force: true });
    await kernel.plugins.reload('skills');
    res.json({ ok: true, name });
  });

  app.get('/api/skills/:source/:name/read', (req, res) => {
    const { source, name } = req.params;
    // source：builtin=随产品分发的内置指南；pack=vendor 技能包（如 ARS）；user=用户安装
    const dir = source === 'builtin'
      ? join(kernel.rootDir, 'core', 'skills', 'builtin')
      : source === 'pack'
        ? join(kernel.rootDir, 'vendor', 'academic-research-skills')
        : userSkillsDir;
    const mdPath = join(dir, String(name).replace(/[^a-zA-Z0-9_-]/g, ''), 'SKILL.md');
    if (!existsSync(mdPath)) return res.status(404).json({ error: '技能不存在' });
    res.json({ name, content: readFileSync(mdPath, 'utf-8') });
  });
}
