# 开发环境与测试说明（唯一入口）

从干净 checkout 到跑完核心测试，按本页顺序执行即可。所有命令在仓库根目录运行；PowerShell 与 bash 语法一致处直接给出，不同处分别标注。

## 前置条件

- Node.js >= 20.6（CI 使用 22；`node --version` 确认）。
- npm >= 10（`npm --version` 确认）。
- Windows 本地开发为主目标；CI 在 ubuntu-latest 上验证同一套命令。

## 一、安装依赖

```bash
git clone <仓库地址> maharness
cd maharness/web-agent
npm ci          # 后端依赖（含生产依赖校验）
npm ci --prefix ui   # 前端依赖
```

`npm ci` 按锁文件精确安装，是唯一受支持方式；不要用 `npm install` 替代。

## 二、核心验证（最小闭环）

```bash
npm run typecheck    # 后端类型检查
npm test             # 全量单测（kernel + server + core + plugins，当前 905 项）
```

两项通过即达到核心验证标准。

## 三、完整验证（发布前 / 大改动）

```bash
npm run ui:typecheck      # 前端类型检查
npm run selftest          # 产品级冒烟（隔离数据目录，不触发 LLM；91 项）
npm run eval:ci           # 确定性 golden + baseline 阈值门禁（27 场景）
npm run build             # UI 构建 + 双端类型检查
npm run test:security     # 安全回归（PowerShell/路径/SSRF/MCP/HTTP 鉴权）
npm run check:threat-model # 威胁模型映射检查
```

UI E2E（`npm run e2e`，在 `ui/` 下）需要 Playwright Chromium：`npx playwright install --with-deps chromium`。

## 四、实测耗时（干净 checkout，Windows 11，2026-11-01）

| 步骤 | 耗时 |
| --- | --- |
| `npm ci`（后端） | 4 s |
| `npm ci --prefix ui` | 6 s |
| `npm run typecheck` | 5 s |
| `npm test`（905 项） | 37 s |
| **核心验证合计** | **52 s**（远低于 15 分钟验收门槛） |
| `npm run selftest` | 26 s |

CI runner（ubuntu-latest）完整门禁实测约 6 分钟，同样低于 15 分钟。

## 五、开发模式

```bash
npm run dev:all        # 后端 :3000 + 前端 :5173（热更新）
npm run start:all      # 生产模式：构建前端后单端口 :3000
```

首次启动前需配置至少一个 Provider（`.env` 或设置页录入）；仅跑测试不需要 API Key。

## 六、常见问题

| 现象 | 处理 |
| --- | --- |
| `npm test` 报 better-sqlite3 绑定错误 | 删 `node_modules` 后重新 `npm ci`（Node 版本变更后必须重装） |
| E2E 缺浏览器 | `npx playwright install --with-deps chromium` |
| 端口 3000 被占 | `PORT=3001 npm run dev` 或关闭已有实例 |
| 测试句柄 EBUSY（Windows） | 已知 better-sqlite3 句柄迟释放；测试代码均已兜底，如仍复现请提 issue 附完整输出 |

## 七、与其他文档的关系

- 架构与设计：[ARCHITECTURE.md](ARCHITECTURE.md)。
- API 契约：[api-contract-v1.md](../../plan/api-contract-v1.md)。
- 威胁模型：[threat-model-v1.md](../../plan/threat-model-v1.md)。
- 优化登记册（当前状态）：[13-optimization-register.md](../../plan/13-optimization-register.md)。
