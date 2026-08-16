/**
 * server/routes/git.ts —— Git（沙箱仓库状态 / 提交 / 推送）
 */
import type { Express } from 'express';
import { gitIn, type RouteDeps } from './shared';

export function registerGitRoutes(app: Express, deps: RouteDeps): void {
  const { kernel } = deps;

  app.get('/api/git/status', async (_req, res) => {
    try {
      const sandbox = kernel.config.get<string>('sandboxRoot', kernel.rootDir);
      const out = await gitIn(sandbox, ['status', '--porcelain=v1', '-b']);
      if (out === null) return res.json({ repo: false, branch: '', ahead: 0, staged: [], changes: [] });
      const lines = out.split('\n').filter(Boolean);
      const head = lines[0]?.startsWith('## ') ? lines.shift()! : '';
      const branch = head.replace('## ', '').split('...')[0] || '';
      const ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0);
      const staged: { path: string; status: string }[] = [];
      const changes: { path: string; status: string }[] = [];
      for (const line of lines) {
        const x = line[0] ?? ' ', y = line[1] ?? ' ', p = line.slice(3);
        if (!p) continue;
        if (x === '?' && y === '?') { changes.push({ path: p, status: '??' }); continue; }
        if (x !== ' ' && x !== '?') staged.push({ path: p, status: x });
        if (y !== ' ' && y !== '?') changes.push({ path: p, status: y });
      }
      res.json({ repo: true, branch, ahead, staged, changes });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/git/commit', async (req, res) => {
    try {
      const sandbox = kernel.config.get<string>('sandboxRoot', kernel.rootDir);
      const message = String(req.body?.message ?? '').trim();
      if (!message) return res.status(400).json({ error: '提交信息不能为空' });
      await gitIn(sandbox, ['add', '-A']);
      const out = await gitIn(sandbox, ['commit', '-m', message]);
      if (out === null) return res.status(400).json({ error: '沙箱不是 git 仓库' });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/git/push', async (req, res) => {
    try {
      // M8：push 改变远端共享状态（不可逆、影响他人）——必须显式确认；
      // commit 仍是本地可回退操作，保持自动。
      if (req.body?.confirm !== true) {
        return res.status(400).json({ error: '推送需要显式确认：请在请求体传 { "confirm": true }' });
      }
      const sandbox = kernel.config.get<string>('sandboxRoot', kernel.rootDir);
      const out = await gitIn(sandbox, ['push']);
      if (out === null) return res.status(400).json({ error: '沙箱不是 git 仓库' });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
