# maharness 开发交接

更新日期：2026-11-22（v4 架构提案五期迁移落地）。

## 本地版本与启动

| 项目 | 当前状态 |
| --- | --- |
| 日常运行目录 | `D:\\DEEPSEEK\\maharness\\web-agent` |
| 本地 `maharness` 分支 | 当前 HEAD 见 `git log`；v0.2.0 架构收敛提交见 `CHANGELOG.md` 的 0.2.0 条目 |
| 远端状态 | `origin/maharness` 已同步；GitHub Actions 结果以远端为准 |

在 PowerShell 执行 `maharness`，默认打开 `http://localhost:3000`。前端构建产物位于 `web-agent/ui/dist/`。日常运行仓库的数据目录和本机运行文件不在版本库；提交前按路径检查 Git 状态。

## 产品入口与运行事实

| 入口 | 职责 |
| --- | --- |
| 对话 | 下达任务、指定角色、补充要求、纠偏及从原工作单发起返工 |
| 工作台 | 管理日程、待办、项目、笔记并访问资料与最近交付 |
| AI 社会（`?view=society`） | 查看真实执行状态、角色分工、交付和异常，按需停止、恢复或审批 |

对话、个人事项和自动化共用 Run 执行链。工作单记录目标、来源与返工关系，契约记录角色、权限和交付承诺，Run 记录执行事件、检查点、工具回执、产物和用量。恢复继续原 Run，返工关联原工作单并创建新 Run。模型输出结束与任务交付分别判定。已确认的副作用在恢复时复用记录，结果待核对的写入或外部动作等待确认。

内核及插件 SDK 位于 `web-agent/kernel/`，Agent 与内置工具位于 `web-agent/core/`，HTTP、SQLite 和 Run 服务位于 `web-agent/server/`，产品页面位于 `web-agent/ui/`。插件 API 为 `3.0.0`，加载器兼容 v2。

## 数据库与恢复

日常数据库为 `D:\\DEEPSEEK\\maharness\\web-agent\\data\\agent.db`，当前 schema 为 16（最低支持 v15，v14 及以下 fail-closed）。迁移由 `server/migrations/` 下的不可变 SQL 文件与 `manifest.json` 校验和驱动，`schema_migrations` 记录已应用版本；迁移前生成 SQLite 快照，失败不启动新执行。可用 `npm run db:export` / `db:upgrade` / `db:verify` 单独执行迁移与校验。

清理文件前按明确路径核对 ignored 文件及本地运行数据，避免宽泛的 `git clean`。数据库、WAL、密钥与配置的恢复步骤见 [Windows 运维手册](plan/windows-ops-runbook.md)。

## 已完成的关键改动

- 命令执行器恢复：本机 dsh-ops 的 Niubash 准备目录要求位于会话工作区外；在 `D:\\DEEPSEEK\\.dsh\\profiles\\desktop\\cordis.patch.yml` 的 `dsh-ops` 行配置 `bashPath: D:\\mingit\\bin\\bash.exe`，恢复 `ops_bash`。
- 清理旧规划文档与历史评测报告，统一文档引用；重新生成 `plugins-lock.json`，修复 `workbench` 插件完整性校验。
- 依赖安全基线：后端用 `overrides` 固定 `exceljs→uuid@11.1.1`、`pptxgenjs→image-size@2.1.0`；前端将 `shadcn` CLI 移至 `devDependencies`。`npm audit --omit=dev` 前后端均 0 漏洞。
- `plugin:validate` 支持无参数校验 `plugins/` 下全部插件，并保持单目录参数兼容。
- 浏览器回归固定单 worker，避免并行运行时社会调度用例的时序竞争；本地全量 133/133 通过。
- v0.2.0 架构收敛：`server/host/` 建立宿主服务边界（`container.ts` 装配、`ports.ts` 窄接口、`adapters/` 是唯一访问 core 的入口），`server/tests/boundary.spec.ts` 强制 server 不得直接 import core；`server/services/society/` 拆出 `policy` / `selection` / `health` / `snapshot` / `experiments` / `institutions` / `types`（入口 2,264→1,706 行）；`server/services/organization/` 拆出 `projections`（评分卡与福祉，入口 1,860→1,770 行）；`server/experience.ts` 拆出 `services/experience/facts`（事实账本、证据索引、定价、预算）与 `shared`（入口 1,639→1,077 行）；删除 `Store.MIGRATIONS` 与 `migration-lock.ts`，改为 `server/migrations/` 不可变 SQL + manifest checksum + `schema_migrations` 审计表，最低支持 v15。
- v4 五期迁移（ADR 0007–0011，提案见 [plan/architecture-v4.md](plan/architecture-v4.md)）：
  - 0 期：`scripts/check-complexity.mjs`（文件 400 行 / 函数 60 行 / 圈复杂度 15 / 导出 12，基线只降不升）与 `scripts/check-contracts.mjs`（`contracts/api.ts` 逐字生成 `ui/src/generated/contracts.ts`），`check:quality` 与 CI 同步接入。
  - 1 期：`server/run/`（`state` / `journal` / `usage` / `recovery` / `executor`），`run-service.ts` 1381→719 行改为门面；4 期收尾再抽 `run/{create,society,delegate}`，最终 **289 行**，公开签名不变。
  - 2 期：`server/http/`（`scope` / `sse` / `security` / `exec` / `chat-service`）承接传输工具，`routes/shared.ts` 506→18 行 barrel；Provider 编排下沉到 `server/usecases/`，`routes/providers.ts` 658→86 行只做协议与状态码；`layering.spec.ts` 用 AST 固化"路由不碰 services、用例不碰 express/core"。
  - 3 期：`contracts/api.ts` 成为唯一契约源（零 import），`ui/src/types.ts` 630→518 行改为 re-export 生成物；`contracts.spec.ts` 用真实 Store 载荷验证形状，`check:contracts` 字节比对防漂移。
  - 4 期：`server/store/ports.ts`（按聚合根收窄的仓储端口，`Pick<Store>` 推导）、`server/store/sqlite.ts`（SQLite 适配器与端口统计）、`server/store/write-queue.ts`（进程内单写者：串行可计数、`SQLITE_BUSY` 只重试一次），`RunRepository.transaction` 全部经单写者；SQL 按聚合根搬进 `server/store/sqlite/{providers,models,sessions,tenants}.ts`，`db.ts` 1784→1447 行只剩委托与装配；路由收口：`rules.ts` 411→190（`rules-support` + `rules-policy`）、`runs.ts` 423→210（`run-workspace` + `run-events`）、`organization.ts` 418→202（`organization-society` + `organization-governance`）、`index.ts` 356→241（`health.ts`）；`run/executor.ts` 361→**33**（`executor-start.ts` 109 / `executor-flow.ts` 158 / `executor-support.ts` 243，`executeRun` 只剩编排）；`check:coverage` 目标扩到 **21** 个文件（新增 `run/recovery`、`run/executor`/`-start`/`-flow`、`store/*`、`http/security`、`usecases/*`）。
- 社会语义：删除 `/100` 聚合健康分，改为带公式/分子分母/样本量的 `observations[]`；协作关系分只由人工复核事件写入；社会任务要求显式 `requiredCapabilities` 与 `needsWrite`。
- 体验复盘：评价标准可配置独立 reviewer；输出上限可借用总预算余量；默认复盘预算按完整复盘所需调整为 fast 8,000 / focused 14,000 / multi 16,000 token，并在截断时以加倍上限重试一次；`evals/experience-v2.ts` 用真实工具事实样本按通过率/裁决一致/证据有效/建议可用四项门禁验收。

## 验收与发布

> 下表的数字是 2026-11-23 **复杂度收口轮**的本地实测快照；用例数会随测试新增变化，
> 以 `npm test` / `npm run test:security` / `npm run check:coverage` 的实际输出为准。

| 验收 | 结果 |
| --- | --- |
| 双端类型检查与构建 | 通过（`npm run build`：ui:typecheck + ui:build + tsc） |
| 单测 | **1610 通过、1 跳过、0 失败**（`npm test`，1611 个用例） |
| 数据库迁移 | 本机 v15 → v16 实测通过（57→58 表，审计表记录两条 checksum） |
| 体验复盘 v2 真实模型 | 6/7，四项门禁通过（通过率 86%、裁决一致 86%、证据有效 100%、建议可用 100%） |
| 安全回归 | 402/402 |
| 产品自检 | 90/90 |
| 确定性回放 | 28/28（安全攻击阻断 4/4） |
| 优化回归 | 108/108 |
| 浏览器 E2E | 133/133（单 worker 全量，3.4 分钟） |
| 代码风格门禁 | `biome check` error 0（warning 1495，见质量审查报告） |
| 关键文件覆盖率 | **21/21 达标**（≥70%，逐文件 73.89%~100%，`npm run check:coverage`；`run/executor` 100%、`run/executor-start` 99.08%、`run/executor-flow` 100%、`run/recovery` 97.28%） |
| 分层边界 / 复杂度预算 | `check:boundaries` 3/3；`check:complexity` 通过（382 文件，基线 **186**，5 处搬迁登记与 `executeRun` 已全部拆到达标） |
| 契约单一来源 | `check:contracts` 一致（188 行，字节比对） |
| 前端单测 | 10/10（`npm --prefix ui run test`） |
| 生产依赖审计 | 前后端均 0 漏洞（`npm audit --omit=dev`）；UI dev 依赖 minimatch 已升至 11.0.9 |
| 插件清单 | 2 个插件 manifest 通过；插件锁通过 |
| 技能锁 / 技能路由 | 通过，5/5 |
| 威胁模型 / 文档事实 | 通过（24 个引用文件 / 11 个安全 spec / 6 个契约字段） |

v0.2.0 已发布并打 tag；发布门禁仍以 [发布清单](plan/release-checklist.md) 为准：双 workflow（quality + e2e）必须全绿，版本号与 CHANGELOG 一致。后续提交需重新跑完整验收并确认远端 Actions 结果。

## 相关文档

- [四批优化验收汇总](web-agent/evals/acceptance/optimization-closeout/summary.json)
- [AI 社会验收证据](web-agent/docs/AI-SOCIETY-ACCEPTANCE.md)
- [开发环境与测试说明](web-agent/docs/DEVELOPMENT.md)
- [架构文档](web-agent/docs/ARCHITECTURE.md)
