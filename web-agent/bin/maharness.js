#!/usr/bin/env node
/**
 * bin/maharness.js —— 全局启动命令（M4 加固）
 * 任意目录执行 `maharness`：
 *   1. 探测端口：无响应 → 正常启动；
 *   2. 有响应 → 请求 /api/health，校验响应 pid 与本地记录文件（~/.maharness.pid）
 *      一致且 version 匹配 → 复用现有服务（仅打开浏览器）；
 *   3. pid 不一致或 health 异常 → 视为孤儿旧进程，taskkill /PID <pid> /T /F
 *      等待端口释放后重新启动（Windows 语义）。
 * 环境变量：PORT 端口（默认 3000）、MAHARNESS_NO_OPEN=1 跳过打开浏览器。
 */
import { spawn, exec } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..'); // web-agent/
const port = Number(process.env.PORT ?? 3000);
const url = `http://localhost:${port}`;
const pidFile = join(homedir(), '.maharness.pid');
const localVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 健康探测：返回 /api/health 的 JSON（服务不可达/异常 → null） */
async function probeHealth() {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const h = await res.json();
    return h && h.ok === true && Number.isInteger(h.pid) && typeof h.version === 'string' ? h : null;
  } catch { return null; }
}

/** 读取本地 pid 记录文件（无/损坏 → null） */
function readRecordedPid() {
  try { return Number(readFileSync(pidFile, 'utf-8').trim()) || null; } catch { return null; }
}

/** 杀掉整个进程树（Windows: taskkill /T /F；其他平台: SIGTERM），完成后 resolve */
function killProcessTree(pid) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) return resolve(false);
    if (process.platform === 'win32') {
      const tk = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      tk.on('close', () => resolve(true));
      tk.on('error', () => resolve(false));
    } else {
      try { process.kill(pid, 'SIGTERM'); resolve(true); } catch { resolve(false); }
    }
  });
}

/** 等待端口释放（health 不再可达或换主）；超时返回 false */
async function waitPortFree(timeoutMs = 15_000) {
  for (let i = 0; i < timeoutMs / 250; i++) {
    const h = await probeHealth();
    if (!h) return true; // 端口已无健康服务（释放或被无关进程占用，后者由启动阶段报错）
    await sleep(250);
  }
  return false;
}

/** 打开浏览器（幂等：启动日志触发 + 就绪轮询兜底可能都命中，只允许打开一次） */
let opened = false;
function openBrowser() {
  if (process.env.MAHARNESS_DEBUG) console.log(`[maharness] openBrowser: ${opened ? 'skip（已打开过）' : 'open'} ${url}`);
  if (opened || process.env.MAHARNESS_NO_OPEN === '1') return;
  opened = true;
  try {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : `open "${url}"`;
    exec(cmd, { shell: true });
  } catch { /* 打开失败不阻塞 */ }
}

/** 启动成功后记录 pid（供下次执行时校验进程身份） */
function recordPid(pid) {
  try { writeFileSync(pidFile, String(pid), 'utf-8'); } catch { /* 记录失败不影响运行 */ }
}

// ---- 入口：探测 → 复用 / 清孤儿 / 启动 ----
const health = await probeHealth();
if (health && health.version === localVersion && health.pid === readRecordedPid()) {
  // pid 与本地记录一致且版本匹配 → 同一实例仍在运行，直接复用
  console.log(`  maharness 已在运行：${url}（pid=${health.pid} version=${health.version}，直接打开浏览器）`);
  openBrowser();
  process.exit(0);
}

if (health || readRecordedPid()) {
  // pid 不一致或 health 异常（版本不匹配/旧版本无 health 端点/别的进程占用端口）
  // → 视为孤儿旧进程：优先杀 health 上报的实际占用者，其次杀本地记录的 pid
  const victim = health?.pid ?? readRecordedPid();
  console.log(`  检测到孤儿旧进程（占用 ${url}）${health ? `：pid=${health.pid} version=${health.version}` : '（health 异常）'}，正在清理（记录 pid=${readRecordedPid()}）…`);
  const killed = await killProcessTree(victim);
  if (killed) {
    const freed = await waitPortFree();
    if (!freed) {
      console.error('  旧进程清理后端口仍被占用，请手动检查后重试');
      process.exit(1);
    }
  } else if (health) {
    // 无法清理且端口仍被健康服务占用：说明身份校验不匹配但进程活着——保守起见不复用也不强杀记录 pid
    console.error(`  端口被 pid=${health.pid}（version=${health.version}）占用，且与本地记录不一致；已尝试清理失败，请手动处理`);
    process.exit(1);
  }
  // 记录 pid 已失效：清掉，避免下次误判
  try { writeFileSync(pidFile, '', 'utf-8'); } catch { /* 忽略 */ }
}

console.log('  maharness 启动中…');
const child = spawn(process.execPath, [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'server/index.ts'], {
  cwd: root,
  stdio: ['inherit', 'pipe', 'pipe'],
  env: { ...process.env },
});

let pidRecorded = false;
function onServerReady() {
  openBrowser();
  if (!pidRecorded) { pidRecorded = true; recordPid(child.pid); }
}

child.stdout.on('data', (d) => {
  process.stdout.write(d);
  if (String(d).includes('已启动')) {
    onServerReady();
  }
});
child.stderr.on('data', (d) => process.stderr.write(d));

// 兜底：就绪检测（若启动日志模式变化；就绪后记录 pid 并停止轮询）
(async () => {
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const h = await probeHealth();
    if (h && h.version === localVersion) { onServerReady(); return; }
  }
  console.error('  maharness 启动超时，请检查日志');
  child.kill();
  process.exit(1);
})();

child.on('exit', (code) => {
  // 子进程退出：本地 pid 记录随之失效，清空防止下次误复用
  try { writeFileSync(pidFile, '', 'utf-8'); } catch { /* 忽略 */ }
  process.exit(code ?? 0);
});
process.on('SIGINT', () => { child.kill('SIGINT'); });
process.on('SIGTERM', () => { child.kill('SIGTERM'); });
