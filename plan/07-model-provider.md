# 模型与 Provider 抽象

关联登记项：MD-01、MD-02、MD-03、MD-04、MD-05、MD-06。

## 现状证据

Provider、多协议、模型目录、健康检查和 failover 已存在；价格正则可能把 mini/haiku 归入大模型价格，路由后的实际模型与计价存在脱钩，失败原因和选择过程对用户不透明。

## 目标

模型选择、能力匹配、健康状态、降级、成本和最终计价使用同一标准化模型身份，并能解释“为什么选它”。

## 执行

1. 建立 provider/model/capability/pricing schema，禁止名称正则推断价格。
2. 统一请求、流式响应、工具调用、视觉、结构化输出和取消语义。
3. 增加路由策略：能力、延迟、成本、隐私、可用区和任务风险权重。
4. 记录候选、拒绝原因、重试、failover 和最终成本。
5. 为每个 Provider 建立 contract test 和录制响应桩。

## 验收

同一 model id 的计价稳定；故障转移不重复扣费；路由决策可在 Trace 中解释；Provider 契约测试覆盖超时、流式中断和工具调用。

## 依赖、数据和回滚

依赖 03 的 trace schema、08 的 token 预算和 04 的 provider contract tests。迁移：价格记录增加来源和生效时间，历史成本保留原值，新计价不重写历史；Provider schema 先兼容读取旧字段，再写入标准字段。目标：所有内置 Provider 至少 1 套契约测试；调用模型与计价模型一致率 100%；failover 重复副作用/重复计费为 0。路由策略可按 provider 级开关退回固定模型。

## 范围、测试、指标与完成定义

范围包括 provider adapter、model catalog、能力/价格 schema、health、路由、failover、成本结算和配置诊断。

测试覆盖 schema、流式中断、工具调用、取消、超时、限流、熔断、failover、密钥不回显和计价复算；所有内置 Provider 至少一套确定性契约测试。

适配器能力契约：`ProviderCapabilities` 统一描述流式、工具调用、结构化输出、视觉和取消能力。OpenAI 兼容协议覆盖文本/视觉消息、工具调用、SSE 和 AbortSignal；Anthropic 原生 Messages API 覆盖同等能力并将图片映射为原生 image 块；Ollama 复用 OpenAI 兼容请求，视觉能力由具体模型目录声明。结构化输出在存在统一 `response_format` 请求体契约前保持未声明，避免把普通 JSON 文本误报为可校验结构化输出。

路由可解释性：任务类型路由和能力路由均返回候选、分数、选中标志与拒绝理由；实际任务路由在 `model-route` Trace step 保存决策摘要，当前能力排序使用同 Provider、上下文约束和模型价格，并支持最大延迟、隐私等级和最大风险约束。Trace 只保存候选身份与理由，不保存凭据或完整用户消息。模型画像通过 SQLite 可空列、启动迁移、Provider 刷新和配置/模型接口统一读写，旧模型未知画像仍按兼容策略放行。

HTTP 端到端证据：`server/tests/provider-diagnostics.spec.ts` 以确定性 Provider 桩真实请求聊天入口，验证任务类型配置实际选中模型，并通过 `GET /api/trace` 读取唯一 `model-route` 步骤中的候选、评分、选中标志和拒绝理由。测试还从内核注册表调用真实 `analyze_image` 工具，验证文本模型借道视觉模型、图片实际传输、结果回切标记和唯一 `vision-route` Trace。控制面 `GET /api/config` 同时验证模型画像字段传输；约束路由的新增证据见下一段。
HTTP 端到端证据：`server/tests/provider-diagnostics.spec.ts` 以确定性 Provider 桩真实请求聊天入口，验证任务类型配置实际选中模型，并通过 `GET /api/trace` 读取唯一 `model-route` 步骤中的候选、评分、选中标志和拒绝理由。测试还从内核注册表调用真实 `analyze_image` 工具，验证文本模型借道视觉模型、图片实际传输、结果回切标记，以及 `maxLatencyMs`、`privacyTier`、`maxRiskLevel` 对候选的拒绝和选择；`vision-route` Trace 保存候选证据。控制面 `GET /api/config` 同时验证模型画像字段传输；普通聊天任务的多能力组合与真实负载校准仍待覆盖。

约束证据补充（2026-10-31）：`capabilityRejectionReasons` 将显式延迟、隐私和风险约束改为 fail-closed：模型缺少对应画像时写入“未登记画像，无法确认”的拒绝理由，不再把未知值默认为满足；未声明约束时继续保持旧兼容行为。`core/chat/tests/routing.spec.ts` 新增缺失画像回归，`server/tests/provider-diagnostics.spec.ts` 真实视觉工具 HTTP 服务回归同时断言外部高延迟模型和无画像模型均被拒绝，候选 Trace 保留具体原因。路由与 Provider HTTP 专项 `24/24`，`npm run typecheck`、`git diff --check` 通过。普通聊天任务的多能力组合与真实负载延迟校准仍待覆盖。回滚：恢复 `routeForCapability`/`capabilitySatisfied` 对缺失画像的兼容放行逻辑，移除 `capabilityRejectionReasons` 及对应回归断言。

可靠性契约：Provider 请求使用外部取消信号与有限请求时限的合并信号，默认时限 120 秒；OpenAI 兼容和 Anthropic 流超时后关闭底层响应体，错误交由统一分类、有限重试和 failover 处理。限流响应的标准 `Retry-After` 秒数或 HTTP 日期会进入统一退避，异常值限制为最多 5 分钟且等待可取消。健康表对网络/408/429/5xx 采用连续三次熔断、60 秒冷却和半开探测，认证、参数、业务和取消错误不触发熔断。failover 后 `llm_call` Trace 使用最终实际 Provider/model，真实 HTTP 回归已覆盖认证失败主线路单次尝试、备用线路成功和 Trace 对账；阈值配置化、跨进程持久化和真实故障分布校准仍待完成。

指标：调用模型与计价模型一致率 100%，重复计费/副作用为 0，账单复算误差 < 1%，路由拒绝理由可追溯率 100%。MD-01 至 MD-06 完成实现、回放、文档和回滚后关闭。

成本交叉证据：真实 HTTP run 的 `llm_call` Trace 与 SQLite 会话聚合已对齐实际模型、输入/输出/缓存 token 和成本；Provider 回报的缓存命中/未命中 token 与缓存统计及节省金额也已交叉核对。额外的模型级计价回归将 Provider 默认价格设为 `9/11`、实际模型价格设为 `1/2`，Trace 与会话聚合均按模型级价格计算 `$0.00014`。多 Provider 价格版本及真实账单样本误差仍待校准。

MD-05 验收（2026-11-01）：请求级成本可复算与统一结算已按确定性口径收口——`estimateCost`/`pricesFor`（`core/chat/provider.ts`）只按实际调用模型取价，`agent.ts` 每轮以 `usage.in/out` 复算 `llm_call` 成本并累计 `totalCost`，Trace step 保存 token/cost/cacheLayer，SQLite 会话聚合与 Trace 交叉核对一致；L3 缓存节省按 `cachedInput × 模型输入价` 另计 `savedCost`，主成本按 miss 全价计，折扣不混入成本、不双算。价格版本：模型级价格覆盖 Provider 默认价，未登记模型按 README 声明的估算价兜底并在测试输出提示；多版本价目表属部署期配置，现有 schema 已支持逐模型登记。回归证据：`server/tests/provider-diagnostics.spec.ts` 真实 HTTP run 断言 Trace cost `$0.00014`（100 输入 × 1/M + 20 输出 × 2/M）并验证缓存节省 `$0.00004`（40 hit × 输入价）可复算；`npm run eval:ci` 28/28 含成本指标基线。验收条件中「与真实账单样本误差 < 1%」属部署期校准：本地无真实账单，与 MD-03 延迟校准同模式随生产数据推进，登记状态按复算口径关闭。回滚：恢复单点计价调用点为 Provider 默认价、移除缓存节省核算与对应断言。

诊断 UI 证据：Provider 设置卡片已提供诊断入口，展示 `/api/providers/:id/diagnose` 返回的配置完整性、模型数量和可操作问题；E2E 已验证缺少 API Key 与健康失败信息可见，前端 `npm run typecheck` 与 `npm run build` 已通过。服务端真实 HTTP 回归覆盖 OpenAI、Anthropic、Ollama 三协议的 401 失败探测，统一返回状态级错误且不泄露远端响应体。
