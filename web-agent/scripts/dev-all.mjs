/**
 * scripts/dev-all.mjs —— 一键启动（开发模式）
 * 同时运行：后端（tsx watch server/index.ts，:3000）+ 前端（Vite，:5173，代理 /api → :3000）。
 * Ctrl+C 时两个子进程一起清理（Windows 下杀进程树）。
 * L7：Windows 分支 taskkill 后等待各子进程 close 回调再退出——固定 500ms 延时
 * 在慢机器上会与子进程清理产生竞态（父进程先退，孤儿进程残留）。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url)); // web-agent/
const isWin = process.platform === 'win32';
const procs = [];
let shuttingDown = false;

function run(name, node, args, cwd, url) {
  const p = spawn(node, args, { cwd, stdio: ['inherit', 'inherit', 'inherit'], env: { ...process.env, FORCE_COLOR: '1' } });
  p.on('exit', (code) => {
    console.log(`[dev-all] ${name} 退出（code=${code}），正在停止全部…`);
    shutdown('SIGTERM');
  });
  procs.push(p);
  console.log(`[dev-all] ${name} 启动 → ${url}`);
}

/** 等待全部子进程 close（stdio 流关闭）后退出；兜底超时防挂死 */
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  let closed = 0;
  const tryExit = () => { if (closed >= procs.length) process.exit(0); };
  for (const p of procs) {
    if (p.exitCode !== null || p.signalCode !== null) {
      // 已退出（触发本次 shutdown 的进程）：close 可能已发过，直接计入
      closed++;
      continue;
    }
    p.once('close', () => { closed++; tryExit(); });
    if (isWin) {
      try { spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* 忽略 */ }
    } else {
      try { p.kill(signal); } catch { /* 忽略 */ }
    }
  }
  tryExit();
  // 兜底：close 事件丢失（极端情况）时不无限等待
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log('[dev-all] maharness 一键启动中…');
// 后端：node node_modules/tsx/dist/cli.mjs watch server/index.ts
run('后端', process.execPath, [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'watch', 'server/index.ts'], root, `http://localhost:${process.env.PORT ?? 3000}`);
// 前端：node node_modules/vite/bin/vite.js（cwd = ui/）
run('前端', process.execPath, [join(root, 'ui', 'node_modules', 'vite', 'bin', 'vite.js')], join(root, 'ui'), 'http://localhost:5173');
