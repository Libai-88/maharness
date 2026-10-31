# 上下文、记忆与缓存

关联登记项：CT-01、CT-02、CT-03、CT-04、CT-05、CT-06、CT-07。

## 现状证据

已有 L0/L1/L2/L3 缓存、上下文压缩、长期记忆和失败教训；已确认压缩可能吞掉 system prompt，L1 阈值代码与 UI 不一致，embedding 分支错误隔离和命中解释不足。

## 目标

上下文预算可计算、压缩不破坏契约；记忆召回有来源和置信度；缓存命中、失效、节省和风险可解释。

## 范围

`web-agent/core/chat/compact.ts`、`web-agent/core/memory`、`web-agent/kernel/cache.ts`、`web-agent/server/context.ts`、`web-agent/server/routes/stats.ts`。

## 执行

1. 定义 token budget 分配：system、任务、历史、工具结果、记忆、输出保留区。
2. 压缩前后做 system/工具契约校验，支持 dry-run 预览和原因记录。
3. 统一 L1 阈值、embedding 维度、错误降级和命中解释；清理统计口径漂移。
4. 记忆增加来源、时间、置信度、冲突和删除策略；敏感信息默认不入长期记忆。
5. L2/L3 增加版本、依赖、TTL、失效原因和成本收益指标。

## 验收

不同上下文规模下 system prompt 始终存在；缓存命中不会返回过期/错误作用域结果；统计能区分累计、窗口和单次节省。

## 依赖、迁移和指标

依赖 07 的模型 tokenizer/价格契约和 04 的质量基线。记忆条目增加 schema version 与来源字段，旧记录可懒迁移；缓存键版本变化时自然冷启动，不删除用户记忆。目标：system prompt 丢失率 0；压缩后 token 超预算率 < 1%；缓存误命中率 < 0.1%；记忆召回可追溯率 100%。新召回/压缩策略可按会话切回旧版本。

## 测试、回滚与完成定义

测试覆盖上下文预算、压缩完整性、敏感信息过滤、记忆冲突/过期/删除、缓存作用域和 provider 变更失效；长上下文 golden 必须通过。

策略按会话或租户切换；缓存键升级允许自然冷启动，记忆 schema 迁移失败时保留旧记录并停止写入新格式。CT-01 至 CT-07 均有实现、指标复算、自动化验证、文档和回滚路径后关闭。

当前证据（2026-10-30）：`kernel/tokens.ts` 已提供 `allocateTokenBudget` 与可选 `TokenizerAdapter`，`core/chat/compact.ts` 已在压缩/截断决策中扣除 output 保留区并优先使用 Provider tokenizer；无适配器时回退估算器。`kernel/tests/tokens.spec.ts` 与 `core/chat/tests/compact.spec.ts` 合计 10/10 通过。真实 Provider tokenizer、system/task/tools/memory 运行时细分和真实超限指标仍待接入。

压缩完整性证据（2026-10-30）：`contextBoundaryPreservesTools` 防止压缩切点拆分 assistant 工具调用与 tool 回执；头部 system 保留回归继续通过。任务契约、验收条件和记忆约束的完整性校验仍待接入。

CT-01 AgentRunner 预算口径补充（2026-10-30）：`core/chat/agent.ts` 的预检查与 `compactHistory` 统一扣除 `allocateTokenBudget(ctxMaxTokens).output` 的 output 保留区后再判断上下文是否超限；压缩和预检查因此采用同一 context budget。`core/chat/tests/compact.spec.ts` 与 `kernel/tests/task-completion.spec.ts` 合计 `15/15`，`npm run typecheck`、`git diff --check` 通过。真实 Provider tokenizer、运行时分项指标和超限指标校准仍待完成。

CT-02 约束完整性补充（2026-10-30）：压缩切点会跳过 `【任务约束】`、`【验收条件】`、`【核心记忆块】`、`【长期记忆】` 和 `【失败教训】` 消息；`contextIntegrityPreservesConstraints` 在摘要结果生成后逐字校验这些消息，失败即降级截断。工具调用边界与约束保留回归均已覆盖，全量测试 `802/802`，`npm run typecheck`、`git diff --check` 通过。真实长任务的端到端任务契约与记忆注入覆盖仍待补齐。

CT-02 长上下文端到端补充（2026-10-31）：AgentRunner 集成回归在低上下文预算下实际调用压缩 Provider，再发送任务请求；任务约束、验收条件和长期记忆消息逐字保留，任务仍通过结构化验收。上下文与任务完成专项 `19/19`、`npm run typecheck`、`git diff --check` 通过；真实 Provider 超限率和更复杂工具回执组合仍待完成。

CT-03 可解释上下文验收（2026-10-30）：压缩 Trace 记录被处理的历史范围与 token 节省，截断 Trace 记录被省略范围、数量和 output 保留区原因；TracePanel 展示来源与摘要。上下文专项 `12/12`，长上下文 Trace UI E2E 与 UI E2E 总计 `16/16` 通过，后端/UI typecheck 和 diff 检查通过。CT-03 已验收。

CT-04 schema 与运行时验收（2026-10-30）：长期记忆事实新增来源、置信度、过期时间、撤回时间和冲突引用；旧记录通过 `normalizeFact` 懒迁移，`isFactActive` 统一过滤过期/撤回事实。记忆工具支持元数据召回、`revoke_fact` 审计撤回与 `forget_fact` 删除；schema 与 memory 插件专项 `4/4`、类型检查和 diff 检查通过。CT-04 已验收。

CT-05 敏感信息拦截验收（2026-10-31）：长期记忆统一使用 `inspectMemoryText` 拦截凭据、私钥、`.env`、secret key、SSH 和凭据文件路径；拒绝结果不落盘，普通事实不受影响。Memory 插件负向专项 `5/5`、类型检查和 diff 检查通过。CT-05 已验收。

CT-06 缓存边界补充（2026-10-31）：L1 查询与回填键统一纳入 Provider、模型和 system prompt，避免同名模型跨 Provider 误命中；会话 scope 继续限制依赖工具观察的答案。L2 `env_probe` 键纳入平台与 Node 版本，缓存持久化只恢复 schema `v2`；文件类读缓存按路径状态并在写/编辑/删除成功后失效，命名空间失效保持精确范围。缓存专项 `13/13`、`npm run typecheck`、`git diff --check` 通过。外部文件变更检测、L3 provider 真实命中窗口和全量误命中率校准仍待完成。

CT-06 文件缓存外部变更补充（2026-10-31）：`list_dir` 键纳入直接子项名称、类型、大小和时间指纹；`glob`/`grep` 键纳入匹配文件树指纹，`grep` 对缓存范围内文件加入内容摘要；`read_file` 对不超过 2 MB 的文件加入内容摘要。单文件超过 2 MB、grep 单次内容指纹累计超过 8 MB 或文件树扫描不完整时跳过缓存。这样可识别工具外新增/删除/重命名及同尺寸原位内容修改；文件树指纹专项与真实文件工具缓存回归 `26/26`，完整后端 `npm test` `869/869`、`npm run typecheck` 和 `git diff --check` 通过。该证据是确定性正确性回归，不代表生产误命中率统计；L3 Provider usage 真实命中窗口、多 Provider 作用域交叉验证及全量误命中率仍待完成，CT-06 保持进行中。

CT-07 统计口径补充（2026-10-31）：`/api/stats` 的 `cache.metrics` 分开返回 hits、avoidedCalls、tokensSaved 和 costSaved；L1 命中计为避免 LLM 调用，L2 命中计为避免工具调用，L3 同时保留本地估算与 Provider usage 真实 token。真实聊天回归可从 Provider 命中/未命中 token 与价格复算成本节省；更长时间窗口和多 Provider 账单交叉校准仍待完成。
