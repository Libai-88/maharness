// ui/playwright.config.ts —— E2E 冒烟配置
// webServer 每次拉起后端时使用独立的临时数据目录（AGENT_DATA_DIR）：
// 本地与 CI 行为一致（空库 → UI 自动建会话 → spec 种子对话），且不污染真实数据
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3000',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'npm start --prefix ..',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      ...process.env,
      AGENT_DATA_DIR: path.join(os.tmpdir(), 'maharness-e2e-data'),
    },
  },
});
