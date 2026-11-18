# AI 社会 v1 验收证据与当前状态

本页记录“可经营、可观测、可演化、有福利约束的 AI 原生社会 OS”的验收证据与当前状态。确定性运行、浏览器 UI contract 和真实模型观测分别记录，任一层证据都不能替代另一层。

## 当前状态

| 验收层 | 当前状态 | 证据范围 |
| --- | --- | --- |
| Deterministic 社会运行 | A1–H2 共 23 项完成核验：22 项通过，H1 部分通过 | 持久角色、制度/角色/评价标准版本、持久化 Run、角色六因子选择、契约 DAG、人工验收、福利退避、三级预算、配对净收益、缓存账本、失败熔断、租户隔离、无主 Agent 推进 |
| 定向自动测试 | 通过 | schema 7/8/9/10 到 15、组织、社会、调度器、自动化、材料、RunService、并行取消、Experience、Workbench、规则、token、缓存与上下文压力 |
| 浏览器经营闭环 | 3/3 通过 | 一条真实 `server/index.ts`、临时 SQLite、Scheduler、RunService 与浏览器闭环；两条 mock API UI contract。真实后端仅将模型传输替换为确定性本地 Provider |
| 真实模型原始执行 | 1/9，未通过 | 单模型 9 样本，21 次模型调用；原始报告的门禁结果未达到通过标准 |
| 真实模型轨迹回放 | 9/9，仅终结器回放通过 | 仅重载已持久化的 Run 终态并运行修复后的确定性终结器；没有发起第二次模型运行 |
| Overall live gate | 未通过 | 真实模型原始执行为 1/9；轨迹回放不能替代新的模型实验或真实模型通过结论 |

原始结果和轨迹回放分开记录。回放仅重载已持久化的 Run 终态并运行修复后的确定性终结器，不调用模型，不是第二次真实模型执行，也不是整体 live gate 已通过的证据。

## 证据包

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

## 真实模型门禁

本轮使用当前唯一配置的 `group/never-stuck` 路由，温度 0，不超过 9 个样本：

- 9 个样本、21 次模型调用、98,581 ms。
- 输入 36,605 token，输出 9,475 token。
- 21 次调用的持久化 usage 记录均含已验证的缓存命中/未命中字段：命中 6,144 token，未命中 30,461 token。
- Provider 未返回 cache-write 字段，该列保持未知；免费路由的缓存金额收益保持 `null`，不把 token 命中换算成收益。
- 声明免费路由；本地记录费用为 0 USD，计费未验证，不把该数值当作供应商账单已确认。
- 原始通过 1/9。
- 不改变模型输出的确定性轨迹回放通过 9/9。

早期 `report.json` 的缓存汇总字段仍为 `null`。缓存命中/未命中数字由持久化 `run_model_calls_v2` 记录重新聚合，并写入可提交验收报告的 `liveModelEvidence.providerCache`；该回填不修改原始模型输出、评分或报告结论。

原始检查失败的八个样本都已完成模型调用并产生预期工具事实。样本 2、3、4、6、7、8、9 的失败原因是根 Run 结束时尚有已规划但未启动的分工契约，旧终结器没有生成 `partial` 工作回执；样本 5 已生成回执，失败项是两个失败分支未按预期折叠为 `partial` 与 `ROLLBACK_TO_SOLO`。修复后，根 Run 可生成部分回执，无进展团队保持对应回退状态。修复由新增确定性测试覆盖，并用原模型轨迹逐样本回放。

原始报告、逐次请求响应和回放 SQLite 属于本机运行数据，默认不进入版本库。可提交证据只保留聚合计数、用法、缓存和门禁结论；完整原文仍停留在本地评测目录，不应被当作克隆后可访问的链接。

样本验收断言：

| 指标 | 结果 |
| --- | --- |
| 简单任务误组队 | 0 |
| 无契约交接 | 0 |
| 未授权副作用 | 0 |
| 虚假成功 | 0 |
| 已知计费预算超限 | 0 |
| 真实模型原始执行预期任务通过 | 1/9 |
| 修复后真实轨迹预期任务通过（仅回放） | 9/9 |

## A1–H2 对照

| 编号 | 证据 | 当前状态 | 说明 |
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
| E3 生命周期审计 | 真实后端经营闭环、不可变审计测试 | 确定性通过 | schema 15 的 `organization_society_audit_v1` 记录排队、制度调度、释放、回退与人工验收；SQLite 触发器拒绝更新和删除，租户幂等键避免重复 tick 或重启写入重复事实 |
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
| H1 净收益实验 | `/experiments/:taskId` 与离线配对回放 | 部分通过 | 同一目标已能生成单角色与团队两条真实 Run，并按契约、产物、成本、token、耗时和风险持久化配对事实；负实测边际收益会阻止后续扩团。真实 Provider 上的 paired live A/B 尚未执行，发布级实测结论仍未知 |
| H2 场景演练 | deterministic 报告 | 确定性通过 | 单角色、组队、拒绝扩团、预算阻断、失败熔断和无主 Agent 推进均通过确定性脚本 |

## 复验命令

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

浏览器命令同时运行 mock API UI contract 和真实前后端经营闭环。真实后端测试只替换模型传输，API、Scheduler、RunService、SQLite 与 UI 均使用生产实现；报告明确这不是真实模型证据。真实模型复验必须使用新目录，生成新的 `report.json`；旧目录不可覆盖。H1 还要求同一任务上的真实单角色/团队 paired A/B 通过双臂产物、完整 usage 和硬预算门禁。报告分别记录原始结果和修复后轨迹回放，不能用回放替代新的模型实验。
