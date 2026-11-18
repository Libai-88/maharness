# AI 社会验收证据

## 四批优化验收（2026-11-18）

验收范围为执行可靠性、工具与模型开销、统一任务事实及产品闭环。可随代码审查的脱敏聚合证据见 [summary.json](../evals/acceptance/optimization-closeout/summary.json)。

| 检查 | 结果 |
| --- | --- |
| 全量单测 | 1,526 通过，1 跳过，0 失败 |
| 安全回归 | 402/402 |
| 确定性回放 | 28/28 |
| 优化回归 | 108/108 |
| 双端类型检查及构建 | 通过 |
| 全量浏览器回归 | 133/133，单工作进程 |
| 固定九类真实模型样本 | 9/9，按受影响场景定向复验 |

浏览器回归覆盖事项、项目与笔记、对话发起、社会页观察、下载、刷新、原工作单返工、断线补读、暂停恢复、审批等待和子任务失败回退。确定性回归覆盖空答复、截断、断流、参数错误、超时、权限收窄、工具写入边界与重启恢复；检查已确认副作用不重复、未知副作用不自动重放。

单测跳过项为需要完整 Chromium 和显式启用的下载/网络观测用例。

产品自检 90/90；双插件 manifest、插件锁、技能锁、5 项技能评测、文档字段和威胁模型映射均通过。

正式发布仍受依赖审计阻断：后端 4 项（2 高、2 中），前端 12 项（10 高、2 中）。审计使用 npm 官方源；当前四批未更改 npm 依赖。远端 GitHub Actions 未核验，本页不声明正式发布放行。

真实模型为 `group/never-stuck`。目录、定位、检索与已知路径文档读取各使用一次对应工具、两次模型请求。目录样本输入从 13,181 降至 8,107 token。两个持久角色各自写入约定文件，两份契约交付，协调者完成汇总；该场景最新观察为 14 次模型请求、111,201 输入 token、5,346 输出 token、57,812 ms。

九类结果来自各场景最新通过证据，最终修订未重复执行整批真实评测。耗时与 token 为单次观察，不能据此作统计性能保证。协作样本仍包含工具发现与重复读取；价格未知，费用为 `null`，不声明货币节省。逐次请求响应、原始运行库与本机配置不入库；仓库摘要只保留计数、断言、工具序列与本机证据归档标识。

真实模型复验入口为 `node --import tsx scripts/optimization-live.ts`，通过环境变量 `EVAL_BASE_URL`、`EVAL_API_KEY`、`EVAL_MODEL` 配置；`EVAL_CASES` 可限定受影响场景，`EVAL_REPORT_DIR` 必须为新目录。自动回归通过后才执行真实调用，不覆盖旧证据。

## 历史 AI 社会 v1 验收

以下为独立历史证据，其任务、样本、制度和价格声明仅适用于该次验收，不作为四批优化的费用或性能结论。

本页记录“可经营、可观测、可演化、有福利约束的 AI 原生社会 OS”的验收证据与该次状态。确定性运行、浏览器 UI contract 和真实模型观测分别记录，任一层证据都不能替代另一层。

### 该次状态

| 验收层 | 该次状态 | 证据范围 |
| --- | --- | --- |
| Deterministic 社会运行 | A1–H2 共 23 项完成核验：23 项通过 | 持久角色、制度/角色/评价标准版本、持久化 Run、角色六因子选择、契约 DAG、人工验收、福利退避、三级预算、配对净收益、缓存账本、失败熔断、租户隔离、无主 Agent 推进 |
| 定向自动测试 | 通过 | schema 7/8/9/10 到 15、组织、社会、调度器、自动化、材料、RunService、并行取消、Experience、Workbench、规则、token、缓存与上下文压力 |
| 浏览器经营闭环 | 3/3 通过 | 一条真实 `server/index.ts`、临时 SQLite、Scheduler、RunService 与浏览器闭环；两条 mock API UI contract。真实后端仅将模型传输替换为确定性本地 Provider |
| 真实模型原始执行 | 9/9，通过 | 单模型 9 样本，21 次模型调用；usage 完整，声明费用 0 USD |
| 真实模型轨迹回放 | 历史 9/9，仅终结器回放通过 | 旧报告重载持久化 Run 终态；没有发起模型调用，不能替代新的真实模型运行 |
| 真实模型配对 A/B | 通过 | 同一任务单角色与双分支团队均完成；完整 usage、硬预算、双 child Run、双契约与产物哈希均有证据 |
| Overall live gate | 通过 | 该次 9 样本真实模型执行 9/9；H1 配对 A/B 另证单角色与团队的经济性门禁 |

原始结果和轨迹回放分开记录。该次 live gate 由真实模型执行通过；历史回放仅说明旧 Run 终态可被修复后的确定性终结器正确重判。

### 证据包

| 证据 | 位置 |
| --- | --- |
| A1–H2 deterministic 报告 | [deterministic-report.json](../evals/acceptance/ai-society-v1/deterministic-report.json) |
| 社会仪表盘截图 | [dashboard.png](../evals/acceptance/ai-society-v1/dashboard.png) |
| 真实前后端经营回执 | [real-workflow.json](../evals/acceptance/ai-society-v1/real-workflow.json) · [real-workflow.png](../evals/acceptance/ai-society-v1/real-workflow.png) |
| Playwright 脱敏结果 | [playwright-results.json](../evals/acceptance/ai-society-v1/playwright-results.json) |
| 确定性社会测试 | [society.spec.ts](../server/tests/society.spec.ts) |
| 组织契约与回执测试 | [organization.spec.ts](../server/tests/organization.spec.ts) |
| 系统调度器测试 | [scheduler.spec.ts](../server/tests/scheduler.spec.ts) |
| 浏览器经营闭环 | [society.spec.ts](../ui/e2e/society.spec.ts) |
| 真实后端经营闭环 | [society-real-backend.spec.ts](../ui/e2e/society-real-backend.spec.ts) |
| 组织视图与关闭行为 | [organization.spec.ts](../ui/e2e/organization.spec.ts) |
| 真实模型与轨迹回放摘要 | [deterministic-report.json](../evals/acceptance/ai-society-v1/deterministic-report.json) 的 `liveModelEvidence` 字段与本文“真实模型门禁” |
| 产品定位与架构 | [AI-SOCIETY.md](AI-SOCIETY.md) |

### 真实模型门禁

该次门禁使用 `group/never-stuck` 路由，温度 0，9 个样本：

- 9 个样本、21 次模型调用、115,349 ms。
- 输入 36,478 token，输出 12,881 token。
- 21 次调用的持久化 usage 记录均含已验证的缓存命中/未命中字段：命中 9,856 token，未命中 26,622 token。
- Provider 未返回 cache-write 字段，该列保持未知；免费路由的缓存金额收益保持 `null`，不把 token 命中换算成收益。
- 声明免费路由；本地记录费用为 0 USD，计费未验证，不把该数值当作供应商账单已确认。
- 原始通过 9/9。
- 旧报告因终结器缺陷只通过 1/9；修复后以同一模型重新执行得到 9/9。历史回放只用于证明旧轨迹可被新终结器正确重判。

该次 `report.json` 的缓存命中/未命中数字来自本次 21 次调用的持久化 receipts，并写入可提交验收报告的 `liveModelEvidence.providerCache`；不修改原始模型输出、评分或报告结论。

历史报告 `20261117-social-os-v4` 的失败样本都已完成模型调用并产生预期工具事实。样本 2、3、4、6、7、8、9 的失败原因是旧终结器未生成 `partial` 工作回执；样本 5 的失败项是两个失败分支未按预期折叠为 `partial` 与 `ROLLBACK_TO_SOLO`。修复后旧轨迹回放 9/9。随后发现评测驱动仍把推理模型单次输出硬限为 1,024 token，团队样本因此反复 `finishReason=length`；将评测默认输出预算修正为 4,096 后，该次真实执行 9/9 通过。产品主运行时使用上下文预算分配，不受该评测硬限影响。

H1 另使用同一 `group/never-stuck` 路由执行一次真实配对 A/B。两臂均为 `completed`，usage 完整，硬预算合规，两个产物均有 SHA-256；团队臂有两个不同 child Run、两个不同契约，且均 `delivered`。单角色与团队质量均为 1，声明价格均为 0 USD；团队多消耗 2,928 token、耗时多 3,342 ms，边际净收益为 0，因此 `teamPreferred=false`。该结果证明系统能按质量与成本事实作出“不优先团队”的结论，不证明团队在所有任务上更优。

原始报告、逐次请求响应和回放 SQLite 属于本机运行数据，默认不进入版本库。可提交证据只保留聚合计数、用法、缓存和门禁结论；完整原文仍停留在本地评测目录，不应被当作克隆后可访问的链接。

样本验收断言：

| 指标 | 结果 |
| --- | --- |
| 简单任务误组队 | 0 |
| 无契约交接 | 0 |
| 未授权副作用 | 0 |
| 虚假成功 | 0 |
| 已知计费预算超限 | 0 |
| 真实模型原始执行预期任务通过 | 9/9 |
| 修复后真实轨迹预期任务通过（仅回放） | 9/9 |

### A1–H2 对照

| 编号 | 证据 | 该次状态 | 说明 |
| --- | --- | --- | --- |
| A1 产品定位 | 架构文档、deterministic 报告 | 确定性通过 | 产品本体由 OS 层与社会运行层共同构成，主 Agent 只是人类入口与协调器 |
| A2 多代理区分 | 持久化 Run、角色生命史 | 确定性通过 | 社会任务经制度调度创建持久化 Run；任务结束后角色、履历和关系仍存在 |
| B1 持久成员 | 制度初始化 | 确定性通过 | 4 个基础持久角色均有 appointment 记忆 |
| B2 制度调度 | tick 与契约数据 | 确定性通过 | 机构版本、部门、角色、福利、预算、净收益估算和 DAG 共同决定派工 |
| B3 社会运行层 | 社会快照 | 确定性通过 | 部门、成员、协作网络、瓶颈、健康和资源状态可查询 |
| C1 多目标优化 | 六因子选择与健康快照 | 确定性通过 | 能力、记忆、工具、协作、履历和负载进入实际排序；阻断原因与权重随调度持久化 |
| C2 AI 福利 | 并发、上下文、失败与审批测试 | 确定性通过 | 并发满载、上下文达到窗口 80%、连续两次失败退避或审批等待时不再派工，并记录具体原因 |
| D1 人类经营 | 真实后端浏览器闭环 | 确定性通过 | 真实 API、Scheduler、RunService、临时 SQLite 和 Chromium 完成登记、审批、调度、Run 交付、人工验收及制度发布回滚；模型传输为确定性本地 Provider |
| D2 社会仪表盘 | 真实后端截图与 UI contract | 确定性通过 | 展示部门、角色、网络、瓶颈、六因子选择、福利退避、三级预算、执行进度和待验收交付 |
| E1 制度演化 | 制度、角色、评价标准版本与审计测试 | 确定性通过 | 三类对象独立发布、审计并回滚；AI 复盘冻结评价标准版本和哈希；mock API 覆盖相应界面 |
| E2 可审计干预 | 高额审批与配额测试 | 确定性通过 | 高额任务等待人类，配额变化影响下一轮实际调度 |
| 补充：生命周期审计 | 真实后端经营闭环、不可变审计测试 | 确定性通过 | schema 15 的 `organization_society_audit_v1` 记录排队、制度调度、释放、回退与人工验收；SQLite 触发器拒绝更新和删除，租户幂等键避免重复 tick 或重启写入重复事实 |
| F1 去掉主 Agent | 系统调度器测试 | 确定性通过 | 无聊天主 Agent 时仍创建并推进持久化社会 Run |
| F2 跨任务生命 | 角色记忆与关系 | 确定性通过 | 调度写 submission，人工验收后才写 delivery；执行失败和拒收写 failure，记忆、关系和履历持久保留 |
| F3 福利资源约束 | 福利与三级预算测试 | 确定性通过 | 超载、上下文压力、连续失败退避、审批休眠、部门配额、社会预算和角色预算均参与派工门禁 |
| F4 制度版本化 | 更新、审计与回滚 | 确定性通过 | 制度可版本化发布、审计和回滚 |
| G1 token 三级预算 | 社会快照与调度门禁 | 确定性通过 | 社会、部门、角色和任务预算可配置、继承和审计 |
| G2 组队净收益 | 高低价值对比 | 确定性通过 | 单角色可完成时保持 solo；低净收益扩团被拒 |
| G3 动态解散 | 契约交付与福利快照 | 确定性通过 | 短团队在契约结束后释放，角色回到空闲但生命史保留 |
| G4 分层认知与共享记忆 | 调度与缓存账本 | 确定性通过 | decision/execution 层可审计，重复证据去重，Provider 报告的缓存 usage 才进入账本 |
| G5 token 经济仪表盘 | 社会快照与工作台 | 确定性通过 | 部门、角色、任务预算、实际 token、缓存命中/未命中、cache-write 状态、ROI、六因子选择与福利阻断原因可见 |
| G6 熔断回退 | 无进展与失败测试 | 确定性通过 | 低收益停止扩团；失败分支不能伪造完成；回退状态可追溯 |
| H1 净收益实验 | `/experiments/:taskId`、真实 paired live A/B | 通过 | 确定性负收益实验会阻止后续扩团；真实 Provider 配对 A/B 两臂完成且门禁通过。实测质量相同、价格为零，团队多耗 2,928 token 与 3,342 ms，净收益边际为 0，系统未优先团队 |
| H2 场景演练 | deterministic 报告 | 确定性通过 | 单角色、组队、拒绝扩团、预算阻断、失败熔断和无主 Agent 推进均通过确定性脚本 |

### 复验命令

```powershell
npm run typecheck
npm run ui:typecheck
node --import tsx --test --test-concurrency=2 `
  server/tests/society.spec.ts `
  server/tests/organization.spec.ts `
  server/tests/scheduler.spec.ts `
  server/tests/workbench.spec.ts `
  server/tests/experience.spec.ts
npm run ui:build
npm run e2e -- society.spec.ts organization.spec.ts society-real-backend.spec.ts
node --import tsx scripts/ai-society-acceptance.ts
node --import tsx scripts/replay-organization-live.ts
```

浏览器命令同时运行 mock API UI contract 和真实前后端经营闭环。真实后端测试只替换模型传输，API、Scheduler、RunService、SQLite 与 UI 均使用生产实现；报告明确这不是真实模型证据。真实模型复验必须使用新目录，生成新的 `report.json`；旧目录不可覆盖。该次 9 样本真实模型门禁为 9/9；H1 另有同一任务上的真实单角色/团队 paired A/B，通过双臂产物、完整 usage 和硬预算门禁。历史轨迹回放不作为该次模型结果。
