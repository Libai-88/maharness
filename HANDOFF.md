# maharness 开发交接

更新日期：2026-11-19。

## 本地版本与启动

| 项目 | 当前状态 |
| --- | --- |
| 日常运行目录 | `D:\\DEEPSEEK\\maharness\\web-agent` |
| 本地 `maharness` 分支 | 当前 HEAD 见 `git log`；关键功能提交 `a082d6f`：四批优化 `aabcf07`、旧库迁移修复 `1934c31`、清理与依赖安全基线 |
| 隔离开发分支 | `codex/maharness-closeout`，停留在 `1934c31`（对比基线） |
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

日常数据库为 `D:\\DEEPSEEK\\maharness\\web-agent\\data\\agent.db`，当前 schema 为 15。`server/db.ts` 的版本迁移会在初始化组织评价标准前建好租户表和默认租户；迁移前生成 SQLite 快照，失败不启动新执行。

清理文件前按明确路径核对 ignored 文件及本地运行数据，避免宽泛的 `git clean`。数据库、WAL、密钥与配置的恢复步骤见 [Windows 运维手册](plan/windows-ops-runbook.md)。

## 本次接手完成

- 命令执行器恢复：本机 dsh-ops 的 Niubash 准备目录要求位于会话工作区外；在 `D:\\DEEPSEEK\\.dsh\\profiles\\desktop\\cordis.patch.yml` 的 `dsh-ops` 行配置 `bashPath: D:\\mingit\\bin\\bash.exe`，恢复 `ops_bash`。
- 清理旧规划文档与历史评测报告，统一文档引用；重新生成 `plugins-lock.json`，修复 `workbench` 插件完整性校验。
- 依赖安全基线：后端用 `overrides` 固定 `exceljs→uuid@11.1.1`、`pptxgenjs→image-size@2.1.0`；前端将 `shadcn` CLI 移至 `devDependencies`。`npm audit --omit=dev` 前后端均 0 漏洞。
- `plugin:validate` 支持无参数校验 `plugins/` 下全部插件，并保持单目录参数兼容。
- 浏览器回归固定单 worker，避免并行运行时社会调度用例的时序竞争；本地全量 133/133 通过。
- 质量审查后的第一批结构修复：插件源码统一走 `kernel/plugin-sdk`，新增 core/plugins 边界测试；`OrganizationService`/`SocietyService` 注入可测试时钟；角色选择权重进入制度版本，任务支持显式能力/写需求；社会健康分标记为 `weighted_heuristic` 并附样本量与权重；`server/society/policy.ts`、`server/society/selection.ts`、`server/society/health.ts` 已从单体 `society.ts` 拆出并归入 `server/society/`；宿主服务装配集中到 `server/host-services.ts`；新增 `check:boundaries`、`check:quality`、`test:coverage` 脚本。

## 验收与发布

| 验收 | 结果 |
| --- | --- |
| 双端类型检查与构建 | 通过 |
| 单测 | 1529 通过、2 跳过、0 失败 |
| 安全回归 | 402/402 |
| 产品自检 | 90/90 |
| 确定性回放 | 28/28 |
| 优化回归 | 108/108 |
| 浏览器 E2E | 133/133（单 worker 全量） |
| 生产依赖审计 | 前后端均 0 漏洞（`npm audit --omit=dev`） |
| 插件清单 | 2 个插件 manifest 通过；插件锁通过 |
| 技能锁 / 技能路由 | 通过，5/5 |
| 威胁模型 / 文档事实 | 通过 |

发布仍以 [发布清单](plan/release-checklist.md) 为准：双 workflow（quality + e2e）必须全绿；版本号与 CHANGELOG 一致后才可打 tag。当前本地功能验收已通过，远端 GitHub Actions 以最终提交的运行结果为准。

## 相关文档

- [四批优化验收汇总](web-agent/evals/acceptance/optimization-closeout/summary.json)
- [AI 社会验收证据](web-agent/docs/AI-SOCIETY-ACCEPTANCE.md)
- [开发环境与测试说明](web-agent/docs/DEVELOPMENT.md)
- [架构文档](web-agent/docs/ARCHITECTURE.md)
