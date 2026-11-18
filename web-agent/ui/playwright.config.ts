// ui/playwright.config.ts —— E2E 冒烟配置
// webServer 每次拉起后端时使用独立的临时数据目录（AGENT_DATA_DIR）：
// 本地与 CI 行为一致（空库 → UI 自动建会话 → spec 种子对话），且不污染真实数据
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

// Playwright 的交互式 reporter 会设置 FORCE_COLOR；同时继承终端级 NO_COLOR
// 会让 Node 在每个 webserver/worker 启动时发出冲突警告。
delete process.env.NO_COLOR;

const agentDataDir = path.join(os.tmpdir(), `maharness-e2e-${process.pid}`);
process.env.AGENT_DATA_DIR = agentDataDir;
const e2ePort = process.env.E2E_PORT ?? '3137';

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/playwright-results.json' }],
  ],
  use: {
    baseURL: `http://localhost:${e2ePort}`,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'npm start --prefix ..',
    url: `http://localhost:${e2ePort}`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      ...process.env,
      PORT: e2ePort,
      AUTO_STOP_IDLE_MS: '0',
      AGENT_DATA_DIR: agentDataDir,
      AGENT_ALLOW_PRIVATE_URLS: '1',
    },
  },
});
