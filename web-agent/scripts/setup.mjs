/**
 * scripts/setup.mjs —— 一键安装（首次使用）
 * 1. 安装后端依赖  2. 安装前端依赖  3. 无 .env 时从 .env.example 复制并提示填写 API Key
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

console.log('\n[setup] 完成！启动方式：');
console.log('  npm run dev:all      # 开发模式（后端 :3000 + 前端 :5173，热更新）');
console.log('  npm run start:all    # 生产模式（构建前端，单端口 http://localhost:3000）');
