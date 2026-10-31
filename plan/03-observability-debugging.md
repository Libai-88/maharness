# 运行可视化与调试体验

关联登记项：OB-01、OB-02、OB-03、OB-04、OB-05、OB-06。

## 现状证据

`kernel/trace.ts`、SSE 和 `TracePanel` 已存在，但 `service_call` 噪声占归档 96%~99.5%，归档查询仍缺少会话/插件维度索引；缺少可靠的因果关联、重放和断点调试。

## 目标

Trace 是可查询、可关联、可重放的调试器，不只是日志列表；用户能从最终答案定位到步骤、工具输入输出、审批和模型响应。

## 执行

1. 修复服务访问埋点噪声和 flush 定时器生命周期；分离审计事件与性能指标。
2. 为 run/step/tool/provider/plugin 增加 `traceId`、`parentId`、`attempt`、耗时、成本和结果摘要。
3. 增加按会话、任务、插件、错误、时间范围的查询 API 和分页索引。
4. 增加安全重放模式：只重放决策/工具桩，明确禁止真实副作用默认执行。
5. UI 增加因果时间线、输入输出折叠、失败定位、导出和 diff。

### 已验证范围（2026-10-30）

- Trace 面板可按步骤类型筛选；JSONL 导出遵循当前筛选结果。
- Playwright 用例覆盖实时步骤展示、耗时与详情、类型筛选，以及下载内容只包含筛选后的步骤。
- 验证：`web-agent/ui` 目录 `npm run e2e` 14/14、`npm run typecheck` 和 `npm run build` 通过。
- 已补齐：Trace 步骤 ID 使用进程前缀与单调序号，步骤统一携带兼容性的 `attempt`（首次为 0，重试/failover 递增），旧 JSONL 缺省字段按 0 读取；Trace 与 Provider 重试专项回归 16/16。

- 已补齐真实调用交叉证据：HTTP 聊天 run 的 `llm_call` Trace 可核对实际 Provider/model、耗时、输入/输出 token、Provider 回报的缓存命中 token及按实际模型价格计算的成本；同一 run 的 `retry-policy` Trace 保留错误分类和重试决定，参数错误路径保留停止重试与稳定错误码；另一个 HTTP run 真实执行 `read_file` 两次，`tool_call` Trace 保留两次工具终态、结果摘要与耗时，第二次读取产生唯一 `cache_hit` 且 `cacheLayer=L2`；审批批准、拒绝与过期凭据路径验证凭据下发、工具执行/阻断及同一 Trace 关联。OB-02 交叉验收证据已齐，Provider 诊断专项 `21/21`、全量 `npm test` `900/900`、类型检查与 diff 检查通过。

- 审批过期路径已收口：`server/routes/approvals.ts` 只有一次性凭据验证结果为 `ok` 才允许进入执行器，过期凭据在宽松模式下也被拒绝；`server/tests/auth.spec.ts` 认证专项 28/28 验证凭据过期、错误和重放语义。

- 查询契约已支持时间范围、状态、错误分类和 `before_ts` 游标分页，单页限制 500 并返回 `nextCursor`；真实 HTTP run 已验证分页取得更早步骤。Trace 归档索引已通过 10 万事件定位与多页游标压力回归，会话/插件维度和索引重建均已覆盖。

- 可审计事件全链路按凭据键名脱敏（`apiKey`、`token`、`secret`、`password`、`authorization`、`cookie`、`credential`，含嵌套结构）：`tool_start` 事件帧、`approval_required` 事件帧、审批摘要、审批清单（`GET /api/approvals`）、策略放行摘要、审批等待与策略放行 Trace、工具结果摘要统一经 `redactTraceValue` 处理，原始参数仅用于实际执行。凭据以专用键名承载时不落入任何 trace 或事件帧；普通内容键（如 `content`）的值属正常载荷，大结果走 RESULT_STORE 摘要加引用机制。授权审计信息可经 `/api/security/audit` 定位，认证专项覆盖拒绝与放行审计事件的脱敏落库。验证：Provider 诊断专项 19/19（含审批/清单/SSE/Trace 四处凭据脱敏回归）、全量 `npm test` 896/896、`npm run typecheck`、`npm run ui:typecheck`、`git diff --check` 通过。

- 新增 `kernel/trace-diff.ts` 的纯数据步骤差异比较，按步骤 ID 报告新增、删除和字段变化；比较过程不触发任何 Provider、工具或副作用。安全重放、工具桩和真实副作用阻断仍待实现。
- 安全重放已落地：`kernel/tool-replay.ts` 提供工具录音（`recordTools`）与桩回放（`stubTools`）——桩工具按「工具名 + 键序无关参数」匹配预录结果返回，真实 handler 不进入桩实现；匹配失败或录音缺工具 fail-closed 报错，不回退真实执行。回归 `kernel/tests/tool-replay.spec.ts` 以真实写文件工具验证：桩模式重放的最终答案与录制 run 一致、真实副作用执行次数不增加、参数漂移只产生失败结果。与 LLM 层 `ReplayProvider`/`RecordingProvider` 及 `diffTraceSteps` 组成完整重放与差异链路。验证：安全重放专项 2/2、全量 `npm test` 898/898、类型与 diff 检查通过。
- 已补齐真实子代理因果链证据：`server/tests/provider-diagnostics.spec.ts` 通过真实 HTTP 聊天入口触发 `run_subagent`，核对主 run 的父工具步骤、子 run 的 `llm_call` 与 `read_file` 步骤均携带同一 `parentId`，且子 run 使用独立 `traceId`；`GET /api/trace?include_parents=1` 返回完整父链，`validateTraceSteps(..., { requireResolvedParents: true })` 通过。Provider 与工具步骤未出现孤儿或错误父节点。
- 已补齐插件服务解析事件的 Trace ID：`kernel/plugin-loader.ts` 为每条 `service_call` 事件生成进程号、进程随机前缀和单调序列组成的独立 `traceId`，不再写入空 ID；服务绑定回归验证默认去重与 `always` 调试模式下的唯一性、插件身份和严格 Trace schema 均通过。
- 已补齐 Trace 入口兜底：`kernel/trace.ts` 对插件/扩展误传的空 `traceId` 自动生成 `unscoped` 可查询 run，避免任何落盘事件绕过 schema；Trace 回归验证该事件可查询且严格完整图校验通过。
- 已补齐 Trace 可选字段 schema：`validateTraceSteps` 现在校验会话/插件与摘要字符串、结束时间和耗时、token/成本非负范围、缓存层、错误分类、重试字段等运行时类型；非法字段回归已覆盖。
- 已补齐旧归档兼容：JSONL 尾部读取和索引随机读取统一把历史缺失的 `attempt` 补为 `0`，旧事件经过当前 schema 校验仍可被查询和导出。
- 仍待完成：跨 run/provider/plugin 的生产事件全量 schema 校验、长 run 大事件量 UI 性能、错误定位与服务端集成验收。
- Trace UI 时间线已收口：有子步骤的根步骤可折叠/展开（折叠隐藏整棵子树）；类型筛选切换为平铺视图，被筛掉的父步骤不再吞掉子树；孤儿兜底在平铺模式下不重复渲染。E2E 覆盖 span 树父子展开、错误定位、类型筛选平铺计数与 200 步大事件量双向滚动。验证：轨迹专项 4/4、UI E2E 24/24、全量 `npm test` 898/898、双端 typecheck 与 `git diff --check` 通过。
- OB-02 验收（2026-11-01）：实现提交 `0c40c86` 关联完成。验证：Provider 诊断专项 21/21、全量 `npm test` 900/900、`npm run eval:ci` 27/27、`npm run typecheck` 通过。回滚方式见登记册。

## 范围

`kernel/trace.ts`、`kernel/plugin-loader.ts`、`server/routes/traces.ts`、`server/db.ts`、`ui` Trace 组件。

## 依赖、迁移和风险

依赖 04 固化评测事件，配合 09 的 run/checkpoint 标识。旧 JSONL 保持只读兼容，新事件采用 schema version；索引可重建，不作为唯一数据源。敏感工具参数按既有脱敏规则存储；重放使用工具桩，执行真实副作用需显式人工授权。

## 验收

真实对话步骤占比可测且不被 service_call 挤出；同一 run 可还原完整父子链；重放结果与 golden 一致；百万级事件查询不整文件同步读取。

## 回滚

保留旧 JSONL 读取适配器；新索引写入失败时降级旧归档并告警；重放默认 dry-run。目标指标：查询 P95 < 500ms（10 万事件）、事件丢失率 0、常规 trace 存储量相对当前每 run 增长不超过 20%。

## 测试与完成定义

- 单测覆盖事件 schema、父子关联、脱敏、分页游标和重放权限。
- 集成测试覆盖并发写入、索引重建、旧 JSONL 读取、导出和 dry-run 重放。
- UI E2E 覆盖长 run 展开、错误定位、筛选、导出和大事件量滚动。
- 完成条件：OB-01 至 OB-06 均有实现提交、自动化验证、运行证据、文档事实更新和回滚路径。

当前证据（2026-10-30）：Trace 每日 JSONL 同步维护可重建的 `.idx` 偏移索引；跨重启按 `traceId`、`sessionId`、`pluginId` 查询时优先随机读取索引命中的事件，旧 JSONL 无索引时保留尾部读取兼容路径。`kernel/tests/trace.spec.ts` 覆盖 10 万事件定位、索引重建和多页游标，分页 P95 低于 500ms；类型检查与 diff 检查通过。OB-03 已验收。

OB-03 维度索引补充（2026-10-30）：Trace 步骤支持可选 `sessionId`、`pluginId`，每日 `.idx` 同步记录维度；归档查询和 `/api/trace` 支持会话、插件、时间、状态、错误分类过滤，并保留 `limit`/`before_ts` 游标分页。聊天路由、LLM 步骤和 service_call 已写入对应维度；跨实例归档过滤回归通过。Trace 专项 `8/8`、归档压力 `5/5`，全量测试 `803/803`，类型检查和 diff 检查通过。索引重建与完整分页压力仍待完成。

OB-03 索引重建与分页补充（2026-10-30）：`Trace.rebuildArchiveIndexes()` 从原始 JSONL 可重复重建每日 `.idx`，并通过临时文件替换保证索引更新不覆盖原始事件；无索引旧归档重建后可按 traceId/sessionId/pluginId 随机读取。索引查询先按时间游标和 limit 选择候选偏移，再随机读取事件；10 万事件多页游标无重叠，Trace 专项 `15/15` 且分页 P95 低于 500ms，类型检查和 diff 检查通过。

OB-01 验收（2026-10-31）：Trace ID、父子关系、attempt、旧 JSONL 默认值及步骤 schema 均有运行时校验和回归覆盖。真实 HTTP 子代理链跨 trace 返回完整父链并通过严格完整图校验；`service_call` 使用独立可查询 ID 并通过严格 schema 校验。`kernel/tests/trace.spec.ts` `20/20`、`kernel/tests/services.spec.ts` `17/17`、`server/tests/provider-diagnostics.spec.ts` `15/15`、`npm run typecheck`、`git diff --check` 均通过。OB-01 已验收。
