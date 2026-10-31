# Agent 执行与任务完成质量

关联登记项：AG-01、AG-02、AG-03、AG-04、AG-05、AG-06。

## 现状证据

`core/chat/agent.ts` 已有循环、工具调用、审批、缓存和结果回填；目标模式可从明确的文件产物或引号文本提取验收条件，并提取风险、美元预算和截止时间。短语解析覆盖中英文明确输出要求，支持提取多条短语、多个文件产物、文件内容和工具成功条件并去重；文件验收仅接受相对沙箱路径并拒绝绝对路径与 `.`/`..` 路径段；零值、非有限预算或无效时限不进入契约。仅预算或期限的目标也会保留约束；空验收条件不能证明完成。验收状态区分 verified、partial、failed；每项验证证据携来源、说明和关联 Trace step ID，经 runner/SSE 送达调用端，并写入 assistant 消息后可在刷新后恢复。验收通过时最终答复追加可追溯的 `【验证证据】` 段，服务端以 `done.content` 回填持久化消息；验收未通过不进入 `assistant_done`、成功统计或 L1 缓存；超时会停止后续轮次。Provider 重试策略按瞬时/认证/取消分类执行；并行全失败不会伪装为成功工具结果，部分成功保留 partial 状态。Record/Replay 已覆盖成功、部分完成和失败 golden；开放式目标采用有限置信度推断并在执行前要求补齐验收条件。

## 目标

每个任务都有可检查的成功条件；Agent 只能在满足条件时报告完成；失败可分类、可重试、可转人工或生成恢复点。

## 执行

1. 在 `RunOptions`/任务模型增加目标、验收条件、截止时间、风险级别和幂等键。
2. 建立 `task.started/step.started/step.completed/task.verified/task.failed` 事件契约。
3. 增加结果验证器：文件/命令/HTTP/结构化输出四类基础断言。
4. 把重试策略按错误类型分开：瞬时、权限、参数、业务失败、未知失败。
5. 统一子代理和并行任务的预算、取消、错误聚合和最终验收。

## 范围

`kernel/loop.ts`、`core/chat/agent.ts`、`core/goal-plan`、`core/subagent`、`core/parallel`、`kernel/budget.ts`、`evals`。

## 依赖、数据和迁移

依赖 04 的 case manifest；与 09 共用持久化任务状态和幂等键。任务字段采用可选 schema 扩展；旧任务按“无显式验收条件”的兼容策略进入 legacy verifier，不回写或猜测旧目标。先以 shadow mode 记录验证结论，再逐步将结论用于阻止完成。

## 验收

已新增任务验收成功/部分完成/失败 golden，以及审批通过/拒绝 golden；拒绝场景断言受保护 handler 执行次数为零。任务契约解析覆盖多条明确的中英文输出短语、多个相对文件产物、风险、预算及截止时间，并验证提取顺序和去重；否定表达式不会生成相反验收条件，同时拒绝绝对/越界文件路径及无效数值。空验收拒绝和过期截止时间有自动化测试。验证证据可定位到 Trace 步骤；SQLite 重开后验收记录仍可读取，UI 可展开查看各项结果；重复执行不产生重复副作用；工具失败不丢失原始错误。开放式目标先经确认卡补齐验收条件，再进入同一执行链。本轮契约/验证/完成专项回归 34/34，`npm run eval:ci` 27/27，`npm run ui:typecheck` 和 `npm run typecheck` 通过。

测试：单元测试覆盖 schema、验证器、错误分类、重试策略和预算；集成测试覆盖并行、审批、取消和重复副作用。

错误分类固定集包含 20 条标注样本，覆盖 transient、auth、parameter、business、aborted、unknown；宏 F1 为 1.0，每个样本均校验原始 cause 引用。Provider 执行器集成测试覆盖瞬时 500 同线路一次退避重试、401 同线路不重试并切换备用 Provider；工具通过 `idempotent` + `retry` 声明后才允许瞬时失败重试，默认不重试；审批通过后同样沿用该工具重试契约，拒绝则不执行 handler；retry-policy、tool-retry 与 failover 均有事件证据。ReplayProvider 确定性故障帧覆盖 Provider 500/429 重试完成，以及 401/400/业务拒绝/AbortError 单次终止；manifest 测试固定限流重试和认证、参数、业务、取消停止用例。该固定集属于确定性回归证据，尚不代表真实 Provider/工具错误分布上的泛化质量。

HTTP 执行证据：`server/tests/provider-diagnostics.spec.ts` 真实调用聊天入口，确定性 Provider 首次返回 500、第二次成功，验证 SSE 重试事件、实际调用次数和 `retry-policy` Trace 分类/决定；真实 Provider/工具错误分布采样仍待用于退避参数校准。

AG-04 确定性回归（2026-10-31）：`npm run eval` 全部 `27/27` 通过，覆盖超时、限流、瞬时错误重试，以及认证、参数、业务拒绝和取消停止；确定性 case manifest 与运行结果一致。真实 Provider/工具错误分布采样和退避参数校准仍待完成。

AG-04 上游退避校准（2026-10-31）：OpenAI 兼容和 Anthropic 适配器读取标准 `Retry-After` 秒数/HTTP 日期并传入统一错误策略；非法、负数和超长值被拒绝或限制为最多 5 分钟，取消信号仍可中断等待。Provider 协议、错误分类与 AgentRunner 专项 `36/36`，覆盖两条适配路径、实际限流重试等待和取消不发起下一次调用；`npm test` `878/878`、`npm run eval:ci` `27/27`、`npm run typecheck`、`git diff --check` 通过。真实 Provider/工具错误分布采样仍待完成。

AG-04 failover Trace 口径补充（2026-10-31）：修正 `core/chat/agent.ts` 在备用 Provider/model 成功或最终失败时更新 `llm_call` Trace 名称，确保记录最终实际调用线路；新增真实 HTTP 聊天回归，认证失败主线路只调用一次，备用线路成功，并核对 `llm_call`、`retry-policy` Trace 的最终身份与 `HTTP_401` 停止决定。Provider 重试与诊断专项 `25/25`，全量 `npm test` `880/880`，`npm run typecheck`、`git diff --check` 通过。真实 Provider/工具错误分布采样与退避参数校准仍待完成。

AG-04 混合错误分布回放验收（2026-11-01）：`server/tests/provider-diagnostics.spec.ts` 新增真实 HTTP 聊天回归，主线路按 503→429 分布回放（503 走 1200ms 默认退避重试、429 记录 Retry-After 40ms 后停止并交棒 failover），备用线路按超时→成功分布回放（超时走 1200ms 默认退避重试），核对两次 `retry:attempt`、一次 `retry:failover`、四次调用的退避间隔下限，以及 `retry-policy` Trace 三条决策 `HTTP_503 retry/1200ms`、`HTTP_429 stop/40ms`、`NETWORK_TRANSIENT retry/1200ms` 与最终 `llm_call` 线路身份。Provider 诊断专项 `21/21`，全量 `npm test` `900/900`、`npm run eval:ci` `27/27`、`npm run typecheck` 通过。AG-04 已验收。

任务契约解析补充：输出验收现支持带引号的“回答/返回”、`respond/reply/answer/return with` 和 `must contain/include` 明确表达式；无引号普通问句继续保持零验收条件，避免开放式语义猜测。专项 `kernel/tests/task-contract.spec.ts` 10/10 通过。

任务契约绝对期限补充（2026-10-31）：`deriveTaskContract` 支持带明确标记的 ISO 日期/日期时间绝对截止点，并在相对期限与绝对期限同时出现时选择更早时间；未带标记的普通日期数字不触发推断。新增确定性回归覆盖绝对期限和优先级，AG-01/AG-02 保持进行中。

任务契约正则验收补充（2026-10-31）：`deriveTaskContract` 支持带明确“匹配正则/符合正则”标记的中英文引号表达式和 `/pattern/flags` 表达式，编译失败的正则、重复条件和普通匹配问句均不生成验收条件。`kernel/tests/task-contract.spec.ts` 正则专项 13/13 通过，`npm run typecheck` 与 `git diff --check` 通过。

开放式目标推断补充（2026-10-31）：`TaskContract.inference` 增加可选的 `confidence`、`basis`、`needsConfirmation` 和 `rationale` 字段。明确验收条件为 `confidence=1/explicit`；识别到行动意图但缺少验收标准时为 `0.45/inferred`；开放式问题或无法识别目标时标记为低置信度并要求确认。推断元数据不单独生成验收条件，聊天路由仍只把明确验收、预算或期限的契约交给执行器，保持完成验证 fail-closed；`validateTaskContract` 校验置信度范围和字段结构。

开放式目标 golden 补充（2026-10-31）：新增 `kernel/tests/fixtures/task-contract-golden.json` 与 `task-contract-golden.spec.ts`，固定明确文件/预算、开放式行动目标、开放式问题和明确输出/工具四类输入，逐项核对验收条件、风险、期限、预算及推断置信度；需要确认的样本断言不会生成验收条件。golden `4/4`，连同契约与验证专项 `26/26`，类型检查和差异检查通过。确认结果已接入聊天路由和 UI 确认卡，并由 Playwright 回归覆盖。

并行取消回归覆盖父信号传递至全部子任务、两个子任务取消、保留已结算成本与 token，并断言取消结束后活动槽位归零。`node --import tsx --test kernel/tests/runner-seam.spec.ts kernel/tests/budget.spec.ts kernel/tests/parallel-aggregate.spec.ts` 22/22 通过。AG-05 仍需真实 Provider 负载压力验收。

AG-05 真实 HTTP 确定性负载补充（2026-10-31）：`server/tests/provider-diagnostics.spec.ts` 通过真实聊天入口驱动四项并行子任务，验证四项同时启动、峰值并发为 4、结束后活动请求归零，父任务累计用量为输入 50/输出 25，成本等于四个子任务实际成本与最终汇总调用之和；六次 Provider 调用及四个子任务的 Provider Trace 均完成，并关联到并行工具父步骤。Provider 诊断专项 `18/18`、全量 `npm test` `881/881`、`npm run typecheck`、`git diff --check` 通过。该回归覆盖确定性 Provider 负载下的并发、聚合和 Trace 口径，不代表真实线上 Provider/工具错误分布采样；AG-05 仍需线上分布与退避参数校准。

AG-05 预算耗尽回放验收（2026-11-01）：`server/tests/provider-diagnostics.spec.ts` 新增目标模式真实 HTTP 回归，任务预算 `$0.42` 下 Provider 第一轮发 `read_file` 工具调用并按 400000 USD/百万 token 计价回报 usage（输入 1010/输出 10，单轮成本 $0.408），第二轮循环前成本熔断拦截，SSE 推送 `budget_hit` 与 `error kind:"budget"`、无 `done`，`cost-breaker` Trace 记录熔断终态。Provider 诊断专项 `21/21`，全量 `npm test` `900/900`、`npm run eval:ci` `27/27`、`npm run typecheck` 通过。AG-05 已验收。

## 证据呈现

任务验收事件携带逐项检查结果及其 Trace step ID；服务端将结果写回 assistant 消息，刷新后可恢复。会话气泡在答复旁展示验收状态、通过项数量、检查结果和对应 Trace 步骤。`server/tests/db.spec.ts` 验证数据库关闭重开后证据引用保留，`ui/e2e/bubble-menu.spec.ts` 验证完成答复与逐项结果、Trace 引用同时可见。该呈现不改写模型答复正文。

## 指标与回滚

golden 任务完成率目标 >= 90% 且不得低于当前基线；错误分类宏 F1 >= 0.85；无效重试率下降 30%；重复副作用为 0。先以兼容模式旁路旧完成判定，稳定后切换默认；异常可通过配置恢复旧判定。
