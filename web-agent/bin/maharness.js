#!/usr/bin/env node
/**
 * bin/maharness.js —— 全局启动命令
 * 任意目录执行 `maharness`：若 3000 端口已有服务则直接打开浏览器；
 * 否则以 web-agent 为根启动服务器，就绪后打开浏览器。
 * 环境变量：PORT 端口（默认 3000）、MAHARNESS_NO_OPEN=1 跳过打开浏览器。
 */
import { spawn, exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..'); // web-agent/
const port = Number(process.env.PORT ?? 3000);
const url = `http://localhost:${port}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isUp() {
  try {
    const res = await fetch(`${url}/api/plugins`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch { return false; }
}

function openBrowser() {
  if (process.env.MAHARNESS_NO_OPEN === '1') return;
  try {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : `open "${url}"`;
    exec(cmd, { shell: true });
  } catch { /* 打开失败不阻塞 */ }
}

if (await isUp()) {
  console.log(`  maharness 已在运行：${url}（直接打开浏览器）`);
  openBrowser();
  process.exit(0);
}

console.log('  maharness 启动中…');
const child = spawn(process.execPath, [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'server/index.ts'], {
  cwd: root,
  stdio: ['inherit', 'pipe', 'pipe'],
  env: { ...process.env },
});

child.stdout.on('data', (d) => {
  process.stdout.write(d);
  if (String(d).includes('已启动')) {
    openBrowser();
  }
});
child.stderr.on('data', (d) => process.stderr.write(d));

// 兜底：就绪检测（若启动日志模式变化）
(async () => {
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (await isUp()) { openBrowser(); return; }
  }
  console.error('  maharness 启动超时，请检查日志');
  child.kill();
  process.exit(1);
})();

child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => { child.kill('SIGINT'); });
process.on('SIGTERM', () => { child.kill('SIGTERM'); });
