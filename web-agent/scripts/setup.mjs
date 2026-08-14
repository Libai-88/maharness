/**
 * scripts/setup.mjs —— 一键安装（首次使用）
 * 1. 安装后端依赖  2. 安装前端依赖  3. 无 .env 时从 .env.example 复制并提示填写 API Key
 * 4. npm link 注册全局 maharness 命令（任意目录输入 maharness 一键启动 + 打开浏览器）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const isWin = process.platform === 'win32';

function run(label, cmd, args, cwd) {
  console.log(`\n[setup] ${label}…`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: isWin, env: process.env });
  if (r.status !== 0) {
    console.error(`[setup] ${label} 失败（code=${r.status}）`);
    process.exit(r.status ?? 1);
  }
}

run('安装后端依赖（npm install）', 'npm', ['install'], root);
run('安装前端依赖（npm --prefix ui install）', 'npm', ['--prefix', 'ui', 'install'], root);

const envFile = join(root, '.env');
if (!existsSync(envFile)) {
  copyFileSync(join(root, '.env.example'), envFile);
  console.log('\n[setup] 已生成 .env（从 .env.example 复制）。');
  console.log('[setup] ⚠ 请编辑 .env，填入至少一个 API Key（如 DEEPSEEK_API_KEY 或 TAVILY_API_KEY）后再启动。');
} else {
  console.log('\n[setup] .env 已存在，跳过生成。');
}

// 注册全局命令（失败不阻塞：可后续手动 npm link）
console.log('\n[setup] 注册全局命令 maharness…');
const link = spawnSync('npm', ['link'], { cwd: root, stdio: 'inherit', shell: isWin, env: process.env });
if (link.status === 0) {
  console.log('[setup] ✓ 全局命令已注册：任意目录输入 maharness 即可一键启动并打开浏览器');
} else {
  console.warn('[setup] ⚠ npm link 失败（可能权限不足）。可手动执行 `cd web-agent && npm link` 注册全局命令，或直接用 npm run start:all。');
}

console.log('\n[setup] 完成！启动方式：');
console.log('  maharness               # 全局命令：任意目录一键启动（已在运行则直接打开浏览器）');
console.log('  npm run dev:all         # 开发模式（后端 :3000 + 前端 :5173，热更新）');
console.log('  npm run start:all       # 生产模式（构建前端，单端口 http://localhost:3000）');
