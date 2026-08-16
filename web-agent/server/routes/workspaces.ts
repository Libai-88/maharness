/**
 * server/routes/workspaces.ts —— 工作区（切换热生效：沙箱边界、文件 API、Agent 工具立即跟随）
 */
import type { Express } from 'express';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RouteDeps } from './shared';

export function registerWorkspaceRoutes(app: Express, deps: RouteDeps): void {
  const { kernel, store } = deps;

  app.get('/api/workspaces', (_req, res) => {
    const current = resolve(kernel.config.get<string>('sandboxRoot', kernel.rootDir));
    res.json(store.listWorkspaces().map((w) => ({
      id: w.id, path: w.path, current: resolve(w.path) === current,
    })));
  });

  app.post('/api/workspaces', (req, res) => {
    const path = String(req.body?.path ?? '').trim();
    if (!path) return res.status(400).json({ error: '缺少路径' });
    const abs = resolve(path);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return res.status(400).json({ error: '目录不存在或不是目录' });
    const row = store.addWorkspace(abs);
    res.json({ id: row.id, path: row.path });
  });

  app.delete('/api/workspaces/:id', (req, res) => {
    if (!store.removeWorkspace(req.params.id)) return res.status(404).json({ error: '工作区不存在' });
    res.json({ ok: true });
  });

  app.post('/api/workspaces/switch', (req, res) => {
    const path = String(req.body?.path ?? '').trim();
    if (!path) return res.status(400).json({ error: '缺少路径' });
    const abs = resolve(path);
    // C-S3 白名单：仅接受 workspaces 表已登记的路径——沙箱根不可被一次 POST 任意
    // 改到 C:\ 等任意目录（新增工作区须走 POST /api/workspaces 显式登记）。
    // Windows 大小写不敏感路径语义：resolve 后小写比对。
    const registered = store.listWorkspaces().map((w) => resolve(w.path));
    const match = registered.find((p) => p.toLowerCase() === abs.toLowerCase());
    if (!match) {
      return res.status(400).json({ error: '该路径未登记为工作区（请先在工作区列表中添加）', available: registered });
    }
    if (!existsSync(match) || !statSync(match).isDirectory()) return res.status(400).json({ error: '目录不存在或不是目录' });
    kernel.config.set('sandboxRoot', match); // 运行时热切换（文件工具/文件 API 下一轮生效）
    res.json({ ok: true, current: match });
  });
}
