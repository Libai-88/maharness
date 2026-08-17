/**
 * server/routes/files.ts —— 文件 API（沙箱内）
 * 沙箱安全工具从 kernel/sandbox 导入（基础设施层，非插件耦合）。
 * isProtectedWritePath / isDeniedReadPath 契约：.env / data/ 读拒；
 * kernel/、core/chat/ 写拒；AGENT_ALLOW_CORE_EDIT=1 放行。
 */
import type { Express } from 'express';
import { statSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { resolveInSandbox, readTextSmart, isProtectedWritePath, isDeniedReadPath } from '../../kernel/sandbox';
import { openInExplorer, type RouteDeps } from './shared';

export function registerFileRoutes(app: Express, deps: RouteDeps): void {
  const { kernel } = deps;

  /** 文件树（单层，前端懒加载展开；忽略噪音目录） */
  const TREE_IGNORE = new Set(['node_modules', '.git', 'dist', 'data', '.dsh', '.idea', '__pycache__', 'coverage']);
  app.get('/api/files/tree', (req, res) => {
    try {
      const sandbox = kernel.config.get<string>('sandboxRoot', kernel.rootDir);
      const dir = resolveInSandbox(sandbox, String(req.query.path ?? '.'));
      if (!existsSync(dir)) return res.status(404).json({ error: '目录不存在' });
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => !TREE_IGNORE.has(e.name) && !e.name.startsWith('.'))
        .map((e) => {
          const full = resolve(dir, e.name);
          try {
            const s = statSync(full);
            return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: s.size };
          } catch {
            return { name: e.name, type: e.isDirectory() ? 'dir' : 'file' };
          }
        })
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      res.json({ path: relative(sandbox, dir) || '.', entries });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---------- 文件（沙箱内） ----------
  app.get('/api/files', (req, res) => {
    try {
      const dir = resolveInSandbox(kernel.config.get<string>('sandboxRoot', kernel.rootDir), String(req.query.path ?? '.'));
      if (!existsSync(dir)) return res.status(404).json({ error: '目录不存在' });
      const entries = readdirSync(dir, { withFileTypes: true }).map((e) => {
        const full = resolve(dir, e.name);
        try {
          const s = statSync(full);
          return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: s.size, mtime: s.mtimeMs };
        } catch {
          return { name: e.name, type: e.isDirectory() ? 'dir' : 'file' };
        }
      }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      res.json({ path: relative(kernel.config.get<string>('sandboxRoot', kernel.rootDir), dir) || '.', entries });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/files/read', (req, res) => {
    try {
      const sandbox = kernel.config.get<string>('sandboxRoot', kernel.rootDir);
      const file = resolveInSandbox(sandbox, String(req.query.path ?? ''));
      // C-S4/H10：与 Agent 工具同一读边界（.env / data/ 等敏感位置读拒）
      if (isDeniedReadPath(file, sandbox)) {
        return res.status(403).json({ error: '拒绝读取受保护路径（.env / data/ 等敏感位置）' });
      }
      if (!existsSync(file)) return res.status(404).json({ error: '文件不存在' });
      const r = readTextSmart(file);
      if (r.isBinary) return res.status(400).json({ error: '二进制文件不支持读取' });
      res.json({ path: relative(sandbox, file), text: r.text, encoding: r.encoding });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/files/write', (req, res) => {
    try {
      const { path, content } = req.body ?? {};
      if (!path || content === undefined) return res.status(400).json({ error: '需要 path 与 content' });
      const sandbox = kernel.config.get<string>('sandboxRoot', kernel.rootDir);
      const file = resolveInSandbox(sandbox, String(path));
      // C-S4/H10：与 Agent 工具同一写边界（kernel/、core/chat/ 核心代码写拒；
      // AGENT_ALLOW_CORE_EDIT=1 放行——由 tools-fs 契约函数统一判定）
      if (isProtectedWritePath(file, sandbox)) {
        return res.status(403).json({ error: '拒绝写入受保护路径（kernel/ 与 core/chat/ 核心代码；如确需修改请设置 AGENT_ALLOW_CORE_EDIT=1）' });
      }
      mkdirSync(resolve(file, '..'), { recursive: true });
      writeFileSync(file, String(content), 'utf8');
      res.json({ ok: true, path: relative(sandbox, file) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 文件搜索：递归匹配文件名/相对路径（跳过 node_modules/.git/dist，上限 200 条）
  app.get('/api/files/search', (req, res) => {
    try {
      const q = String(req.query.q ?? '').trim().toLowerCase();
      if (!q) return res.json({ query: '', results: [] });
      const sandbox = kernel.config.get<string>('sandboxRoot', kernel.rootDir);
      const skip = new Set(['node_modules', '.git', 'dist', '.dsh', 'data']);
      const results: { path: string; size: number }[] = [];
      const walk = (dir: string, rel: string): void => {
        if (results.length >= 200) return;
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (results.length >= 200) return;
          if (skip.has(e.name)) continue;
          const child = join(dir, e.name);
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(child, childRel);
          else if (e.name.toLowerCase().includes(q)) {
            let size = 0;
            try { size = statSync(child).size; } catch { /* 忽略 */ }
            results.push({ path: childRel, size });
          }
        }
      };
      walk(sandbox, '');
      res.json({ query: q, results });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 用系统文件管理器打开沙箱内文件/目录
  app.post('/api/files/open', (req, res) => {
    try {
      const relPath = String(req.body?.path ?? '');
      const sandbox = kernel.config.get<string>('sandboxRoot', kernel.rootDir);
      const target = relPath ? resolveInSandbox(sandbox, relPath) : sandbox;
      if (!existsSync(target)) return res.status(404).json({ error: '路径不存在' });
      openInExplorer(target);
      res.json({ ok: true, path: relPath || '.' });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
