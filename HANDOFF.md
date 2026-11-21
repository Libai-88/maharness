# maharness 开发交接

更新日期：2026-11-21（v0.2.0 架构收敛）。

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
- 社会语义：删除 `/100` 聚合健康分，改为带公式/分子分母/样本量的 `observations[]`；协作关系分只由人工复核事件写入；社会任务要求显式 `requiredCapabilities` 与 `needsWrite`。
- 体验复盘：评价标准可配置独立 reviewer；输出上限可借用总预算余量；默认复盘预算按完整复盘所需调整为 fast 8,000 / focused 14,000 / multi 16,000 token，并在截断时以加倍上限重试一次；`evals/experience-v2.ts` 用真实工具事实样本按通过率/裁决一致/证据有效/建议可用四项门禁验收。

## 验收与发布

| 验收 | 结果 |
| --- | --- |
| 双端类型检查与构建 | 通过 |
| 单测 | 1536 通过、2 跳过、0 失败 |
| 数据库迁移 | 本机 v15 → v16 实测通过（57→58 表，审计表记录两条 checksum） |
| 体验复盘 v2 真实模型 | 6/7，四项门禁通过（通过率 86%、裁决一致 86%、证据有效 100%、建议可用 100%） |
| 安全回归 | 402/402 |
| 产品自检 | 90/90 |
| 确定性回放 | 28/28 |
| 优化回归 | 108/108 |
| 浏览器 E2E | 133/133（单 worker 全量） |
| 生产依赖审计 | 前后端均 0 漏洞（`npm audit --omit=dev`） |
| 插件清单 | 2 个插件 manifest 通过；插件锁通过 |
| 技能锁 / 技能路由 | 通过，5/5 |
| 威胁模型 / 文档事实 | 通过 |

v0.2.0 已发布并打 tag；发布门禁仍以 [发布清单](plan/release-checklist.md) 为准：双 workflow（quality + e2e）必须全绿，版本号与 CHANGELOG 一致。后续提交需重新跑完整验收并确认远端 Actions 结果。

## 相关文档

- [四批优化验收汇总](web-agent/evals/acceptance/optimization-closeout/summary.json)
- [AI 社会验收证据](web-agent/docs/AI-SOCIETY-ACCEPTANCE.md)
- [开发环境与测试说明](web-agent/docs/DEVELOPMENT.md)
- [架构文档](web-agent/docs/ARCHITECTURE.md)
