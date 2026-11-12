# maharness 全系统成熟度优化路线图

## 1. 文档定位

本路线图面向工具、缓存、技能、MCP、插件、Agent 核心、上下文、记忆、安全、可观测性、评测、租户与 UI 十一个功能区，目标是把 maharness 从“功能完整的本地 Agent Harness”推进到“可交付、可治理、可扩展的产品级 Agent 平台”。

本轮不按“再增加多少工具”规划，而按四条成熟度主线组织：

1. **可信执行**：权限、隔离、审批、副作用、租户和供应链边界可机器验证。
2. **任务完成质量**：工具调用可验证，长任务可恢复，模型输出可修复，结果有证据。
3. **生态治理**：插件、技能和 MCP 可安装、升级、回滚、诊断和评测。
4. **可运营性**：成本、延迟、命中率、失败率和安全事件可观测、可比较、可回归。

## 2. 当前基线与成熟度判断

### 2.1 已有底座

| 区域 | 当前能力 |
| --- | --- |
| Agent 核心 | Provider 能力矩阵、结构化输出修复、checkpoint、副作用账本、handoff、子代理、依赖 DAG 并行 |
| 工具 | JSONSchema 参数校验、审批、沙箱、超时/取消、幂等账本、文件/搜索/代码/浏览器/文档工具 |
| 缓存 | L1 语义缓存、L2 工具结果缓存、L3 前缀复用、命中与节省成本统计 |
| 技能 | frontmatter 版本/依赖/allowed-tools、语义路由、覆盖安装快照、回滚 |
| MCP | stdio/http 客户端、server JSON-RPC 端点、allowlist、默认审批、最小环境透传 |
| 插件 | manifest、热加载、事务回滚、EffectScope、服务接管、依赖拓扑、静态审查、隔离试运行、依赖白名单 |
| 观测 | Trace span 树、JSONL 归档与索引、OTLP 导出、运行轨迹面板 |
| 评测 | 确定性 golden、任务验收、审批/恢复/缓存/安全攻击回放、UI E2E |
| 租户 | 会话级 tenant scope、admin/readonly 角色、租户注册表、会话配额 |

### 2.2 成熟度分级

| 等级 | 判定标准 | 当前状态 |
| --- | --- | --- |
| L0 功能原型 | 单个任务能跑通，失败靠人工排查 | 已超过 |
| L1 本地强力工具 | 单人本机可用，能力和插件丰富，有基本 Trace | 当前主体 |
| L2 可交付团队产品 | 隔离、权限、配额、迁移、恢复、评测和运营指标可证明 | 主要目标 |
| L3 开放生态平台 | 插件/技能/MCP 可签名分发、版本治理、市场安装和兼容承诺 | 后续目标 |
| L4 多租户云平台 | 强隔离运行时、集中身份、弹性资源、SLA 和多区域数据治理 | 不在近期范围 |

**结论**：当前处于 L1 向 L2 过渡阶段。功能数量不是主要瓶颈，缺口集中在“权限真正被执行、结果真正被证明、生态对象真正可治理”。

## 3. 全系统改造区域

| 系统 | 主要改造区域 | 不应改动 |
| --- | --- | --- |
| 工具执行 | `kernel/loop.ts`、`kernel/types.ts`、`kernel/validate.ts`、`core/chat/agent.ts`、`core/tools-fs`、`core/code-intel`、`core/browser`、`core/document` | 不在内核里加入具体工具业务 |
| 缓存 | `kernel/cache.ts`、`core/chat/agent.ts`、`core/chat/compact.ts`、`server/routes/stats.ts`、`ui` 统计面板 | 不把缓存策略焊死为单一 embedding 实现 |
| 技能 | `core/skills`、`kernel/skillsSync.ts`、`server/routes/skills.ts`、`ui` 技能页 | 不让技能执行绕过工具权限 |
| MCP | `core/mcp/index.ts`、`core/mcp/server.ts`、`kernel/plugin-loader.ts`、`config.example.json` | 不把外部 MCP server 当可信内置工具 |
| 插件 | `kernel/plugin-loader.ts`、`kernel/plugin-review.ts`、`kernel/plugin-trial.ts`、`kernel/types.ts`、`scripts/plugin-*`、`ui` 插件页 | 不在同进程内用 Node `vm` 冒充安全隔离 |
| Agent 核心 | `kernel/loop.ts`、`kernel/tokens.ts`、`core/chat/provider.ts`、`core/chat/agent.ts`、`core/goal-plan`、`core/subagent`、`core/parallel`、`core/blackboard` | 不把 LangGraph/CrewAI 等整体框架塞进内核 |
| 上下文与记忆 | `core/chat/compact.ts`、`server/context.ts`、`core/memory`、`core/search`、`core/document` | 不让无来源内容进入长期记忆 |
| 安全与策略 | `kernel/sandbox.ts`、`core/powershell`、`core/rules`、`core/mcp`、`server/security-policy.ts`、`server/secrets.ts` | 不用提示词代替运行时权限 |
| 观测与评测 | `kernel/trace.ts`、`server/routes/trace.ts`、`scripts/agent-eval.ts`、`evals/`、`ui` Trace 组件 | 不让 Trace 成为业务数据唯一来源 |
| 租户与运维 | `server/db.ts`、`server/routes/*`、`server/deploy-mode.ts`、`server/index.ts` | 不在未完成隔离时开放共享部署 |
| UI/UX | `ui/src/components/*`、`ui/src/components/chat/*`、插件独立页面 | 不把权限判断只放在 UI |

## 4. 跨系统设计原则

1. **权限在运行时执行，不在提示词里声明。** 工具、插件、技能、MCP 和 UI 都必须经过同一审批/策略层。
2. **每个副作用有身份、版本和账本。** 文件、HTTP、进程、外部 MCP 调用都能按 run/step 恢复，重复恢复不重复执行。
3. **每个能力有输入/输出契约。** 工具、技能、MCP、插件和上下文注入项都应有机器可判的 schema。
4. **每个生态对象有生命周期。** 安装、启用、升级、回滚、卸载和迁移都必须可追溯。
5. **每个优化有量化证据。** 不以“看起来更好”验收，以错误率、命中率、恢复率、延迟、成本、覆盖率和攻击阻断率验收。
6. **所有扩展保持单向依赖。** `core`/`plugins` 依赖 `kernel` 契约，内核不反向依赖具体能力。
7. **默认拒绝，显式放行。** 网络、文件范围、外部依赖、MCP 工具、插件权限和租户资源都采用 allowlist。
8. **渐进增强，旧版本可回退。** schema、索引、缓存键和 manifest 都带版本；升级失败保留旧版本和只读兼容路径。

## 5. 系统间统一契约

在推进单系统优化前，先固定七个跨系统契约。它们决定后续能力是否能组合，而不是各自为政。

| 契约 | 作用 | 先落地区域 | 验收方式 |
| --- | --- | --- | --- |
| Tool Effect Contract | 声明工具是否幂等、是否有副作用、如何生成 effect key | `kernel/types.ts`、`kernel/loop.ts`、工具插件 | 文件/HTTP/进程重复恢复测试 |
| Context Item Contract | 统一来源、时间、置信度、引用锚点和预算 | `server/context.ts`、`core/memory`、`core/search`、`core/document` | 每条注入项可回指来源 |
| Cache Key Contract | 统一租户、会话、模型、提示词、工具版本、资源指纹和策略版本 | `kernel/cache.ts`、各工具插件 | 跨租户/换模型/换版本不误命中 |
| Skill Manifest Contract | 技能版本、依赖、权限、输入输出、触发/拒绝条件和 eval case | `core/skills`、`kernel/skillsSync.ts` | 安装、升级、回滚、评测全链路 |
| Plugin Permission Contract | 能力、网络域、文件范围、进程、依赖和资源配额 | `kernel/types.ts`、`kernel/plugin-loader.ts` | 越权注册和越权执行均拒绝 |
| MCP Capability Contract | server、工具、资源、提示词、认证、健康与 schema 版本 | `core/mcp`、`server/routes/mcp` | 外部客户端与内部 Agent 同契约 |
| Trace Event Contract | run/step/attempt、父链、成本、错误分类、证据引用和脱敏 | `kernel/trace.ts`、`server/routes/trace.ts` | 跨 run、跨 agent、跨插件可还原 |

## 6. 分系统优化方案

### 6.1 工具系统

**目标**：从“工具可调用”升级为“工具可发现、可选择、可验证、可恢复、可运营”。

**优化方向**

1. **能力发现与选择**
   - 在能力注册表中增加分类、适用任务、输入成本、延迟画像、失败历史和替代工具。
   - 增加“工具包”视图，让 LLM 先选择能力域，再选择具体工具，减少长工具清单造成的误选。
   - 为同名/近义工具建立冲突消解规则；MCP 工具与内置工具重名时默认保留内置并标记冲突。
   - 区域：`kernel/types.ts`、`server/routes/capabilities`、`core/chat` 系统提示组装。

2. **执行契约**
   - 工具定义补齐 `idempotent`、`sideEffect`、`retryable`、`timeoutClass`、`cancelBehavior`、`resultSchema`。
   - 统一错误分类：参数错误、权限拒绝、资源不存在、瞬时故障、超时、取消、外部系统错误、结果不确定。
   - 为长工具增加流式进度与中间结果，禁止只返回最终文本。
   - 区域：`kernel/loop.ts`、`kernel/validate.ts`、`core/chat/agent.ts`、各 `core/*` 工具。

3. **结果验证**
   - 把“工具返回 ok”与“任务目标达成”分开建模，增加结果证据、文件 diff、命令退出码、页面状态和引用锚点。
   - 对写文件、发请求、改数据库、发消息等副作用工具，要求返回可复核的观察结果。
   - 增加“工具结果—任务验收”关联，失败时能指出缺少哪条证据。
   - 区域：`core/chat/agent.ts`、`kernel/task-verifier`、`core/tools-fs`、`core/browser`、`core/document`。

4. **工具组合**
   - 建立通用组合原语：读取、转换、写入、验证、回滚；插件只提供能力，不重复实现编排。
   - 增加补丁/测试闭环、代码搜索到修改到诊断的稳定链路。
   - 浏览器与文档工具共享“证据对象”，避免每个工具输出不同结构。
   - 区域：`core/code-intel`、`core/browser`、`core/document`、`core/search`。

5. **工具 UI**
   - 用统一的工具卡承载输入、审批、进度、结果摘要、证据和重试。
   - 对长输出使用结果存储和按需展开，不把全文塞回模型上下文。
   - 区域：`ui/src/components/chat/message.tsx`、`ui/src/components/chat/tool-*`、`ui/src/types.ts`。

**验收指标**

- 工具调用参数合法率 100%。
- 无效工具调用率持续低于 3%。
- 副作用重复执行次数为 0。
- 工具失败可在 1 分钟内定位到输入、错误分类和 Trace。
- 关键工具链路（读→改→诊断→测试）有确定性回归。

### 6.2 缓存系统

**目标**：从“命中率高”升级为“命中正确、边界清楚、可解释、可运营”。

**优化方向**

1. **缓存身份**
   - 统一缓存键版本：租户、会话、Provider、模型、system prompt、工具版本、embedding 模型、策略版本、资源指纹。
   - 多租户模式下缓存默认按租户隔离；共享缓存必须显式声明为“公共、无敏感、可复用”。
   - 区域：`kernel/cache.ts`、`core/chat/agent.ts`、`core/tools-fs`、`core/chat/provider.ts`。

2. **L1 语义缓存**
   - 将 embedding 提供者做成可替换服务，记录模型版本、维度和距离阈值。
   - 增加阈值校准集、负样本和误命中回放；低置信度结果不直接返回，而是降级到正常模型调用。
   - 对时效性、个性化、工具观察依赖的答案默认不进入语义缓存。
   - 区域：`kernel/cache.ts`、`core/memory`、`server/routes/stats.ts`。

3. **L2 工具缓存**
   - 缓存键纳入资源版本/内容指纹/策略版本；对文件、网页、数据库和外部 API 分别定义失效条件。
   - 对可变资源使用短 TTL 或显式失效；对副作用工具默认不缓存。
   - 大结果进入结果存储，缓存只保存摘要、引用和校验信息。
   - 区域：`kernel/cache.ts`、`core/tools-fs`、`core/search`、`core/document`。

4. **L3 前缀复用**
   - 固化 system → 人设 → 插件规则 → 任务 → 历史 → 工具结果的组装顺序。
   - 记录 Provider 真实缓存命中/未命中 token，区分“本地估算”和“账单回执”。
   - 多轮任务避免重写前缀；插件动态注入必须追加到稳定前缀之后。
   - 区域：`core/chat/index.ts`、`core/chat/agent.ts`、`kernel/tokens.ts`。

5. **缓存运营**
   - 增加命中原因、失效原因、节省成本、误命中投诉和按模型/工具的命中质量面板。
   - 缓存条目支持手动清除、按租户清除、按版本整体冷启动。
   - 区域：`server/routes/stats.ts`、`ui/src/components/StatsView.tsx`、`kernel/cache.ts`。

**验收指标**

- 跨租户误命中为 0。
- 缓存作用域/版本错误导致的错误答案为 0。
- 误命中率低于 0.1%，低置信度缓存可自动降级。
- 每个命中都能解释“哪一层、为什么命中、省了多少”。
- 缓存清理和版本切换不导致服务不可用。

### 6.3 技能系统

**目标**：从“按需读取的 Markdown 指南”升级为“可安装、可解析、可隔离、可评测的技能包”。

**优化方向**

1. **技能 manifest v2**
   - 增加版本范围、技能依赖、工具依赖、模型能力、OS/运行时要求、输入输出 schema、权限、适用/拒绝条件和 eval case。
   - 引入锁文件和内容哈希；同名冲突、版本冲突和缺失依赖在安装前解析。
   - 区域：`core/skills`、`kernel/frontmatter`、`kernel/skillsSync.ts`。

2. **安装与版本治理**
   - 支持本地目录、压缩包和远程 registry 三种来源；安装前做 manifest、哈希、权限和依赖检查。
   - 升级采用 staging → 校验 → 原子切换；保留可回滚快照和版本元数据。
   - 区域：`kernel/skillsSync.ts`、`server/routes/skills.ts`、`ui/src/components/SkillsView.tsx`。

3. **运行时边界**
   - 技能可以使用哪些工具、读取哪些文件、访问哪些网络域，必须由 manifest 声明并在执行器侧强制。
   - 技能资产（references/templates/scripts）与技能正文分离；脚本执行进入受审批的工具通道。
   - 技能不得通过 `allowed-tools` 间接获得未授权能力。
   - 区域：`core/skills`、`kernel/loop.ts`、`core/chat/agent.ts`、`core/tools-fs`。

4. **评测闭环**
   - 每个技能至少有一个正例、一个拒绝例和一个回归例。
   - 安装/升级前运行 dry-run 评测；失败阻止进入默认技能集。
   - 记录技能触发率、成功率、工具失败率和人工纠正率。
   - 区域：`evals/`、`scripts/agent-eval.ts`、`core/skills`。

5. **组合与市场**
   - 支持技能依赖图和阶段编排，但编排仍由 Agent/插件执行，不把业务逻辑塞进技能正文。
   - 市场对象必须带签名/哈希、版本、权限、兼容范围和评测报告。
   - 区域：`core/skills`、`plan/supply-chain-policy-v1.md`、未来 `skills-registry`。

**验收指标**

- 安装成功率 ≥ 95%，坏版本回滚成功率 100%。
- 缺依赖、版本冲突、权限越界在安装前拒绝。
- 技能触发的工具 100% 受全局权限和审批约束。
- 关键技能正例/拒绝例/回归例全部通过。

### 6.4 MCP 系统

**目标**：从“能接外部工具”升级为“可认证、可发现、可重连、可治理的 MCP 生态入口”。

**优化方向**

1. **连接与认证**
   - stdio 保持最小环境透传；http 增加 OAuth 2.1/Token 刷新、header 配置和凭据轮换。
   - 增加连接健康、自动重连、退避、超时和断线状态；重连不重复注册工具。
   - 区域：`core/mcp/index.ts`、`server/routes/mcp`、`config.example.json`。

2. **能力发现**
   - 支持 `tools/list`、`resources/list`、`prompts/list` 和 capability negotiation。
   - 工具 schema 归一化为内部契约；名称冲突、参数不兼容和版本漂移要在注册前诊断。
   - 增加 server registry、安装来源、版本锁定和健康检查。
   - 区域：`core/mcp`、`kernel/plugin-loader.ts`、`kernel/validate.ts`。

3. **安全治理**
   - allowlist 从工具名扩展到 server + 工具 + 资源 + 网络域 + 版本。
   - 外部工具默认审批；读取外部资源时做内容净化和提示注入检测。
   - server 进程/HTTP 请求有资源上限、超时、取消和日志脱敏。
   - 区域：`core/mcp`、`core/rules`、`kernel/plugin-review.ts`。

4. **MCP server 端**
   - maharness 对外暴露的工具必须带 allowlist、租户、审批和调用配额。
   - 支持 resources/prompts 暴露时，必须有只读/敏感数据分级。
   - 区域：`core/mcp/server.ts`、`server/routes`。

5. **多 server 编排**
   - 同名工具冲突、跨 server 依赖和失败隔离要有明确策略。
   - 外部调用结果统一进入 Trace 和证据链，不直接当内置工具结果。

**验收指标**

- 未授权 MCP 工具/资源调用拒绝率 100%。
- 断线重连成功率 ≥ 99%，重连不产生重复工具。
- schema 不兼容在注册前拒绝，不拖到运行时。
- 每个外部调用可追溯到 server、版本、工具、参数摘要和结果。

### 6.5 插件系统

**目标**：从“可热加载的受信任代码”升级为“可治理的插件平台”。

**优化方向**

1. **manifest v2 与权限**
   - 增加 API 兼容范围、文件范围、网络域、进程/子进程、依赖、资源配额、配置 schema、健康检查和卸载清理策略。
   - 权限在 `ctx.register` 与真正执行工具时双重校验；运行时不能只靠 manifest 声明。
   - 区域：`kernel/types.ts`、`kernel/plugin-loader.ts`、`kernel/plugin-review.ts`。

2. **安装与供应链**
   - 插件来源支持本地目录、压缩包、registry；安装前做签名/哈希、依赖解析、兼容性检查和静态审查。
   - 引入插件锁文件和可重复构建；升级保留旧版本快照，失败自动回滚。
   - 区域：`scripts/plugin-scaffold.mjs`、`kernel/plugin-loader.ts`、`plan/supply-chain-policy-v1.md`。

3. **运行时隔离**
   - 高风险插件进入独立进程/worker/容器执行，按插件配置资源配额、工作目录、环境变量和网络出口。
   - 不允许以 Node `vm` 作为安全边界；隔离等级在 UI 明示。
   - 区域：`kernel/plugin-loader.ts`、`kernel/plugin-trial.ts`、`server` 执行边界。

4. **SDK 与开发体验**
   - 插件 SDK 固化能力注册、配置、存储、日志、Trace、权限和测试工具。
   - 提供参考插件、manifest 校验、生命周期测试、权限模拟器和兼容矩阵。
   - 区域：`kernel/plugin-sdk.ts`、`scripts/plugin-*`、`plugins/reference-*`。

5. **运行治理**
   - 增加插件健康度、错误率、启动耗时、资源使用、依赖冲突和版本分布面板。
   - 插件停用/卸载必须回收工具、服务、监听、配置、存储和 UI 贡献。
   - 区域：`ui/src/components/PluginsView.tsx`、`server/routes/plugins.ts`、`kernel/trace.ts`。

6. **UI 贡献契约**
   - iframe、panel、module 三种模式的信任等级、能力边界和数据通道保持稳定。
   - 插件 UI 的错误、空态、权限拒绝和版本不兼容有统一呈现。
   - 区域：`ui/src/components/PluginTabView.tsx`、`ui/src/plugins`。

**验收指标**

- manifest/权限/兼容性错误在安装或加载前拒绝。
- 坏版本回滚成功率 100%，卸载后无残留能力/监听/服务。
- 高风险插件无法越权访问未声明文件、网络或进程。
- 插件安装、升级、停用、卸载全流程有自动化回归。

### 6.6 Agent 核心与上下文

**目标**：把“能循环”升级为“能稳定完成长任务，并解释为什么完成”。

**优化方向**

1. **Provider Gateway**
   - 统一 chat/embedding/rerank/vision/structured-output 能力，统一 tokenizer、价格版本、健康状态和 failover。
   - 路由前验证模型能力，避免运行中才失败。
   - 区域：`core/chat/provider.ts`、`core/chat/index.ts`、`kernel/modelCatalog.ts`。

2. **Durable Task Runtime**
   - 在现有 checkpoint/副作用账本上补步骤级状态机、定时器、人工节点、暂停/继续/重试和过期清理。
   - 任务合同、预算、验收条件和证据随 checkpoint 持久化。
   - 区域：`kernel/loop.ts`、`core/chat/agent.ts`、`core/goal-plan`、`server/db.ts`。

3. **上下文组装**
   - 分成 system、task、memory、skills、retrieval、tool-result 六段预算；每段可单独限流、压缩和引用。
   - 检索结果统一为 Context Item，带来源、时间、置信度和引用锚点。
   - 压缩前后校验 system、工具契约和任务约束，失败自动降级截断。
   - 区域：`server/context.ts`、`core/chat/compact.ts`、`core/memory`、`core/search`、`core/document`。

4. **多 Agent 编排**
   - 完善 supervisor graph、依赖 DAG、handoff 契约、共享黑板和局部失败重试。
   - 子代理只接收结构化上游结论，不复制完整上下文。
   - 区域：`core/subagent`、`core/parallel`、`core/blackboard`、`kernel/budget.ts`。

5. **任务完成语义**
   - 把回答、工具证据、文件 diff、命令退出码和引用统一成 completion evidence。
   - 完成状态区分 verified/partial/failed/blocked，禁止把“说了完成”当完成。
   - 区域：`kernel/task-verifier`、`core/chat/agent.ts`、`ui` 验收卡。

**验收指标**

- 强杀恢复成功率 ≥ 99%，重复副作用为 0。
- 结构化输出失败可修复或明确终止。
- 长上下文约束保留率 100%，压缩后预算超限率 < 1%。
- 有依赖的并行任务可串并行混合执行，失败只影响相关分支。

### 6.7 记忆与检索

**目标**：让记忆和检索成为有来源、有时效、可撤回的上下文来源，而不是不可控的文本堆积。

**优化方向**

1. 记忆分层：working / episodic / semantic / procedural；不同层采用不同 TTL 和注入策略。
2. 存储升级：SQLite + 向量索引为默认，外部向量库作为可选服务；记录 embedding 模型和维度。
3. 召回质量：query rewrite、hybrid retrieval、rerank、去重和冲突消解。
4. 记忆治理：来源、置信度、时间、撤回、敏感信息拦截、租户隔离。
5. 评测：recall@k、冲突消解、过期清理、敏感写入拦截和跨会话稳定性。

**验收指标**

- 召回结果 100% 可追溯来源。
- 过期/撤回记忆立即失效。
- 敏感信息写入拦截率 100%。
- 跨会话召回稳定，不因缓存/模型切换产生串话。

### 6.8 安全、权限与信任

**目标**：把安全边界从“代码里的若干检查”升级为“版本化、可模拟、可审计的策略层”。

**优化方向**

1. **策略即代码**
   - 统一资源、工具、路径、网络、时间和租户约束；支持 dry-run、差异比较和回滚。
   - 策略变更进入审计，不以 UI 开关作为唯一授权。
   - 区域：`core/rules`、`server/security-policy.ts`、`kernel/sandbox.ts`。

2. **运行时隔离**
   - 高风险工具和插件优先进入独立进程/容器；定义文件 ACL、网络出口、资源配额和进程树回收。
   - 区域：`core/powershell`、`core/mcp`、`kernel/plugin-loader.ts`、未来 sandbox provider。

3. **内容安全**
   - 对网页、文档、MCP 返回和插件输出做提示注入检测、敏感信息检测和内容净化。
   - 不把检测结果当绝对安全，仍保留审批和最小权限。
   - 区域：`core/search`、`core/document`、`core/mcp`、`server/security-policy.ts`。

4. **凭据与供应链**
   - Provider/MCP/插件凭据按租户和用途隔离；密钥轮换、吊销和审计可追。
   - 插件、技能、MCP server 的签名/哈希、版本和安装来源必须可验证。
   - 区域：`server/secrets.ts`、`kernel/plugin-review.ts`、`kernel/skillsSync.ts`。

**验收指标**

- 未授权文件/网络/进程/租户访问拒绝率 100%。
- 策略误拒绝率 < 1%，安全事件可 1 分钟内定位。
- 高风险插件隔离逃逸为 0；无法证明隔离时不开放 team/remote。

### 6.9 可观测性与评测

**目标**：从“事后看日志”升级为“能定位、能比较、能重放、能阻断回归”。

**优化方向**

1. **统一事件模型**
   - run/step/attempt、父链、工具副作用、缓存、审批、插件、MCP、租户和成本统一字段。
   - Trace 与审计事件分离；业务事件可采样，安全事件不可丢失。
   - 区域：`kernel/trace.ts`、`server/routes/trace.ts`、`core/otel`。

2. **跨系统指标**
   - 工具成功率、无效调用率、缓存误命中率、技能触发率、MCP 重连率、插件错误率、恢复率、P95 延迟和成本。
   - 指标按版本、模型、租户、插件和任务类型切片。
   - 区域：`server/routes/stats.ts`、`ui/src/components/StatsView.tsx`、`scripts/agent-eval.ts`。

3. **评测分层**
   - 单元契约、集成回放、golden、安全攻击、长任务恢复、UI E2E、抽样模型评测。
   - 每个系统新增能力必须带正例、负例和回滚用例。
   - 区域：`evals/`、`ui/e2e`、CI 配置。

4. **重放与差异**
   - 安全重放默认只回放决策和工具桩，真实副作用需显式授权。
   - 版本间输出、成本、延迟和工具序列可 diff。
   - 区域：`kernel/tool-replay.ts`、`kernel/trace-diff.ts`、`ui` Trace 面板。

**验收指标**

- 关键流程都有端到端证据链。
- 评测报告可按版本比较并阻断核心指标回退。
- 失败可定位到 run → step → tool → input/output → policy。
- 10 万事件查询 P95 < 500ms，安全事件不丢失。

### 6.10 租户、数据与部署

**目标**：从“会话级逻辑分区”升级为“权限、配额、数据和运维都可解释的团队模式”。

**优化方向**

1. 明确共享与私有资源：工作区、Provider、技能、插件属于管理员共享基础设施；会话、消息、审批、Trace 属于租户私有。
2. 租户作用域下沉到数据访问层，所有查询/写入显式带 tenant scope；不存在“忘记过滤”的路由。
3. 租户配额覆盖会话、并发 run、存储、成本、插件和 MCP 调用。
4. team 模式需要角色、principal、密钥隔离、迁移 dry-run、备份恢复和审计。
5. 在隔离完成前，remote/team 模式保持 fail-closed；不以 UI 隐藏代替权限。
6. 区域：`server/db.ts`、`server/routes/*`、`server/deploy-mode.ts`、`web-agent/README.md`。

**验收指标**

- 跨租户读写拒绝率 100%。
- 配额超限有稳定错误码和 UI 提示。
- 迁移失败保留旧库可启动；备份恢复演练成功率 100%。
- 共享资源操作有管理员审计，不伪装成租户私有。

### 6.11 UI/UX 与运营台

**目标**：把分散的工具卡、Trace、技能、插件、MCP 和租户设置整合成“Agent 运营台”，而不是多个独立页面。

**优化方向**

1. **统一状态语言**：运行中、等待审批、失败、部分完成、可恢复、已回滚、权限拒绝使用同一套视觉与文案。
2. **证据优先**：工具卡优先展示结果证据、diff、引用和验收，不只展示工具名。
3. **渐进披露**：长 Trace、长工具输出、缓存原因和权限详情按需展开。
4. **生态管理**：技能、插件、MCP 采用同一套安装/版本/权限/健康/回滚视图。
5. **租户与成本**：在设置与统计中明确当前租户、共享资源、配额和成本归属。
6. 区域：`ui/src/components/chat/*`、`TracePanel`、`PluginsView`、`SkillsView`、`SettingsView`、`StatsView`。

**验收指标**

- 关键状态在 390/900/1440px 和明暗主题下可读。
- 审批、恢复、错误、权限拒绝和回滚都有 E2E。
- 用户能从最终答案一层层定位到证据和 Trace。

## 7. 分波次执行

### 7.1 依赖关系

```text
Trace/Evidence 契约 ─┬─> 工具结果验证 ─> 任务完成语义
                    ├─> 缓存运营指标
                    └─> 评测报告与版本 diff

工具 Effect 契约 ────> 长任务恢复 ─> 多 Agent 编排
缓存 Key 契约 ───────> 记忆/检索 ─> 上下文分段预算
Provider Gateway ────> tokenizer/成本 ─> 缓存真实命中核算
插件权限契约 ────────> MCP/技能运行时约束 ─> 生态市场
技能 manifest/锁文件 ─> 技能评测 ─> 技能 registry
MCP 能力契约 ────────> MCP registry/OAuth ─> 外部生态接入
租户数据作用域 ──────> 配额/审计 ─> team 模式
```

关键顺序：先统一契约和证据，再做单系统能力；先完成运行时权限和隔离，再开放安装/市场；先保证缓存和副作用正确，再追求命中率与自动化。

### 波次 A：可信与正确性地基

范围：工具 Effect Contract、缓存 Key Contract、插件运行时权限、MCP 认证/重连、技能锁文件、租户数据访问层。

出口：

- 跨租户、越权插件、重复副作用和缓存串话均有负向测试。
- 生态对象安装前可验证权限、版本和依赖。
- 所有关键路径有统一 Trace 与回滚路径。

### 波次 B：任务完成质量

范围：工具结果验证、任务完成证据、上下文分段预算、长任务定时器/人工节点、Provider Gateway。

出口：

- 长任务可暂停、恢复、转交、重试和取消。
- 任务完成由证据证明，不由模型自述。
- 上下文预算和压缩可解释，关键约束不丢失。

### 波次 C：生态与运营

范围：插件 SDK/registry、技能市场、MCP registry/OAuth、插件健康面板、技能/插件评测。

出口：

- 外部对象可安装、升级、回滚、诊断和审计。
- 插件/技能/MCP 的权限和版本在运行时可验证。
- 生态对象的失败不影响宿主核心。

### 波次 D：团队化与规模化

范围：团队角色、租户配额、共享/私有资源边界、团队部署、备份迁移、运维指标。

出口：

- team 模式跨租户拒绝、配额、审计和迁移演练全部通过。
- 未完成强隔离前不开放公网/共享部署。

## 8. 优先级清单

| 优先级 | 事项 | 原因 |
| --- | --- | --- |
| P0 | 插件运行时权限与隔离 | 当前最大信任缺口，决定能否开放第三方生态 |
| P0 | MCP OAuth/registry/重连/资源治理 | 外部能力入口，不能只靠工具名 allowlist |
| P0 | 技能锁文件/版本求解/评测门禁 | 防止供应链和运行时权限漂移 |
| P0 | 缓存作用域/版本/失效/误命中治理 | 错误缓存会直接制造错误答案 |
| P0 | 工具副作用与结果证据 | 决定长任务能否可信恢复和验收 |
| P1 | Provider Gateway 与统一 tokenizer | 成本、路由、结构化输出和缓存口径统一 |
| P1 | 上下文分段预算与证据引用 | 长任务质量的核心 |
| P1 | 插件/技能/MCP 统一运营台 | 降低生态使用和排障成本 |
| P1 | Trace/评测跨系统指标 | 没有指标就无法判断优化是否有效 |
| P2 | 插件市场、技能市场、MCP registry | 生态规模化的前提是治理完成 |
| P2 | 多 Agent supervisor graph | 在 DAG、黑板和恢复之上继续增强 |
| P3 | 分布式缓存、云运行时、多区域 | 远期为 L4 平台能力 |

## 9. 交付门禁

每个功能包关闭前必须同时满足：

1. 契约文档：输入、输出、权限、错误、版本和回滚。
2. 单元测试：正常、边界、越权、超时、取消和回滚。
3. 集成测试：至少一条跨系统链路，不能只测孤立模块。
4. 负向测试：越权、伪造、注入、重放、跨租户和坏版本。
5. 可观测性：Trace、成本、延迟、失败分类和证据引用。
6. UI 入口：涉及用户能力时有空态、错误态、权限态和回滚态。
7. 全局门禁：`npm test`、`npm run typecheck`、`npm run build`、UI E2E、`npm run eval:ci`。
8. 回滚演练：旧版本可启动，旧数据可读取，失败不半迁移。

## 10. 不建议的方向

- 不以增加工具数量替代任务完成质量。
- 不把完整 Agent 框架作为内核依赖。
- 不在同进程内用 Node `vm` 冒充插件安全隔离。
- 不在缓存/权限/租户边界完成前开放共享部署。
- 不让技能正文或插件 UI 自行决定权限。
- 不为生态完整同时引入多套同类框架。
- 不把业务状态、页面状态和产品策略写入内核。

## 11. 总体完成定义

maharness 达到 L2 产品级门槛时，应同时满足：

- 任一高风险工具、插件、MCP 调用都能被策略拒绝并留下脱敏审计。
- 任一长任务强杀后可恢复，重复副作用为 0。
- 任一工具结果都能关联到任务证据和 Trace。
- 任一缓存命中都能解释来源、版本、作用域和节省。
- 任一技能/插件/MCP 对象都能安装、升级、回滚和评测。
- 任一租户不能读写其他租户的私有数据。
- 核心质量指标可按版本比较，回退会阻断发布。

在此之前，功能可以继续增加，但不应宣称“成熟 Agent 产品”。

## 12. 实施状态

| 项 | 状态 | 当前证据 |
| --- | --- | --- |
| Cache Key Contract：租户作用域 | 已完成 | L2 `makeKey` 纳入租户；顶层/子代理/并行/MCP 透传；跨租户键隔离单测通过 |
| 缓存命中溯源 | 已完成 | L1 返回匹配方式/作用域/剩余 TTL/命中次数，L2 返回命名空间/年龄/剩余 TTL/命中次数；Trace `cache_hit` 展示来源 |
| 缓存租户隔离与清理 | 已完成 | L1 条目携带 tenantId，显式租户跨租户不可命中；L1 键包含租户避免覆盖；L2 条目记录 tenantId；`clearScope` 支持按租户/层清理；`POST /api/cache/clear` 与统计页按钮仅清理当前租户 |
| Provider Gateway 统一契约 | 已完成 | `service:provider-gateway` 统一 Provider/模型能力/任务路由/能力路由/健康/embedding；`GET /api/providers/gateway` 只读快照有契约测试 |
| MCP HTTP 认证 | 已完成 | `tokenEnv`/显式 Bearer、401 后 refresh-token 换新一次、请求头换行与头注入校验；认证头专项测试通过 |
| MCP 重连与工具刷新 | 已完成 | `mcp_reconnect`、失效工具回收、server 级状态更新；MCP 安全/JSON-RPC 专项通过 |
| MCP resources / prompts | 已完成 | server 级 URI/name allowlist；发现与读取工具默认审批；HTTP 集成回归通过 |
| MCP 熔断与健康 | 已完成 | 按 server 统计连续失败、冷却后半开单探测；`mcp_status` 返回 state/calls/failures/retryAfterMs；工具、resources、prompts 共用同一熔断 |
| MCP OAuth 2.1 | 已完成 | 授权码 + PKCE（S256）；`mcp_oauth_login` 生成 URL、`mcp_oauth_complete` 换 token、`mcp_oauth_status` 查状态、`mcp_oauth_logout` 吊销本地 token 并回收工具；token 用途加密存储、过期自动 refresh、401 强制刷新一次；OAuth server 认证失败标记 `auth-required` |
| MCP registry | 已完成 | `mcp.registry.url` + `mcp_registry_search/install`；只接受 npm stdio（安全包名 + 固定 npx）或 https remote，安装后持久化并立即连接；registry 注入字段不落地，集成测试覆盖 tools/list |
| MCP 工具 allowlist | 已完成 | `mcp.servers.<name>.tools` 限制注册的远程工具名；空/缺省保持全部；status 返回 skippedTools；纯函数与安全测试覆盖 |
| MCP 协议完整性 | 已完成 | tools/resources/prompts 列表跟随 `nextCursor` 分页；tool annotations 映射为 `sideEffect/risk/idempotent/retry/outputSchema`；`structuredContent` 作为结构化结果返回；stdio 支持 `sampling/createMessage`（Provider Gateway 生成）与 `roots/list`，未声明能力返回 -32601；`list_changed` 通知复用连接刷新工具 |
| 浏览器网络与下载 | 已完成 | 网络响应环形缓冲（≤200）；下载落会话目录并需审批；网络观测集成测试通过，下载测试需完整 Chromium 环境 |
| Skills 锁文件依赖图 | 已完成 | semver 范围、缺失依赖、版本不满足、循环依赖校验；同步前拒绝非法锁文件 |
| 技能路由评测门禁 | 已完成 | `triggers/applies-when/reject-when` 进入统一打分；`npm run skill:eval` 做固定 prompt top-K 回归，5/5 通过 |
| 真实模型 live 评测 | 已完成 | `npm run eval:live` 采样真实回答 + LLM-as-judge 按 rubric 打分；judge 解析失败标错不静默通过；无 key 明确跳过 |
| LSP 代码导航 | 已完成 | `codeIntel.lsp` 配置 stdio language server；`lsp_definition/hover/diagnostics` 懒启动、按扩展名路由、随插件卸载关闭；mock LSP 往返测试通过 |
| Tree-sitter 多语言索引 | 已完成 | `web-tree-sitter` + `tree-sitter-wasms`；Python/Go/Rust/Java/C#/C/C++ 顶层符号提取，TS/JS 仍走 TypeScript AST；失败回退正则 |
| 计划步骤状态机 | 已完成 | pending/in_progress/done/blocked 合法迁移校验；重新打开清除完成位；`complete_goal` 拒绝未完成步骤；状态机与持久化测试通过 |
| 步骤级断点 | 已完成 | 工具执行前保存 `tool_pending`（工具名/调用 id/副作用/参数摘要），轮末保存 `turn_end`；resume 对 `tool_pending` 重跑同一轮并注入“结果未知”提示；写入/外部副作用的 pending 账本仍以 409 阻止自动重放 |
| 到点续跑调度 | 已完成 | `data/schedules.json` 持久化作业；`POST /api/sessions/:id/resume-at`、`GET /api/schedules`、`DELETE /api/schedules/:id`；只恢复已有 checkpoint 的会话；409/网络错误最多重试 3 次；local/trusted 走回环，remote TLS 需 `MAHARNESS_INTERNAL_BASE_URL` |
| 审批审计持久化 | 已完成 | `approval_requests` 记录请求方、租户、会话、工具名、摘要、参数、创建/过期时间与 approved/rejected/expired/withdrawn 决策；`GET /api/approvals/history` 按租户/会话过滤；审计钩子异常不影响审批流程 |
| 记忆租户隔离 | 已完成 | facts 与核心记忆块按 tenantId 存取；注入/召回/撤回/删除/冲突关系均过滤租户；旧数据默认为 default；租户隔离测试通过 |
| 生态健康运营台 | 已完成 | `/api/stats` 新增 `ecosystem`：插件运行/错误/热重载、MCP server 状态/熔断/OAuth、当前租户会话数；统计页展示插件与 MCP 健康表 |
| 图片与扫描 PDF OCR | 已完成 | `ocr_image` 外部 OCR；`ocr_pdf` 用 `pdfCommand` 渲染页面后逐页 OCR，临时目录清理、页数/大小/超时/输出上限、未配置明确报错、OCR evidence；mock 双命令测试通过 |
| Plugin 锁文件 | 已完成 | `plugins-lock.json` 记录版本/源码聚合哈希/兼容范围/权限；`plugins.enforceLock=true` 加载前校验，`plugin:lock` 生成与 `plugin:lock:verify` 门禁均通过 |
| 锁文件签名 | 已完成 | 通用 Ed25519 detached signature 与规范化 JSON；`plugin:lock:sign/verify`、`skill:lock:sign/verify`；已签名但缺公钥或内容被篡改均 fail-closed；未签名锁保持向后兼容 |
| Tool Effect Contract | 已完成 | 工具声明 `sideEffect`；只读工具不进入恢复账本，写/外部/不可逆进入；只读/无副作用工具自动获得 `idempotent` 与有限重试；工具 evidence 随 SSE/Trace 暴露，并可通过 `tool_evidence` 验收条件证明文件/URL/命令结果 |
| 工具目录与冲突消解 | 已完成 | `PluginLoader.toolCatalog()` 返回所属插件与遮蔽状态；同名工具非 MCP 优先于 MCP、同源按插件 id 稳定保留；Agent/统计/预热统一使用去重后的 `tools()`；`GET /api/tools` 暴露风险、副作用、幂等与内容信任 |
| 策略 dry-run / 差异 / 回滚 | 已完成 | `evaluatePolicy`、`diffPolicyRules`、`dryRunPolicy` 纯函数；`check_policy` 支持候选策略对比；`POST /api/rules/policy/dry-run`、`GET /api/rules/policy/history`、`POST /api/rules/policy/rollback`；写入前保存最近 20 份快照；设置页支持预览与保存 |
| 内容安全标注 | 已完成 | `kernel/content-safety` 扫描提示注入与敏感信息，预览强制脱敏；网页/文档/浏览器/MCP 工具标记 `contentTrust=untrusted`；结果 `warnings` 进入 SSE、Trace 与工具卡，作为警告不替代审批 |
| 凭据按用途隔离 | 已完成 | `kernel/secret-box` 用 HKDF 派生 per-purpose 子密钥，v2 信封携带用途；Provider 密文按 `provider:<id>` 隔离并自动从 v1/明文迁移；MCP OAuth token 通过 `mcp-oauth:<server>` 加密存储；跨用途解密拒绝 |
| Plugin runtime isolation | 已完成（local/trusted） | 静态审查、隔离试运行、依赖白名单、`permissions.runtime` 加载期审查、按租户工具频率/全局并发与私有存储配额；`execution.mode=process` 子进程边界（V8 堆上限、硬超时、最小 env、崩溃隔离）；`network=allowlist` 子进程出口守卫；`filesystem=none/storage/sandbox` 路径守卫，非 `full` 强制 process 模式。容器级隔离作为可选 L3 provider，不作为当前 local/trusted 验收前置 |
| Tenant data scope | 已完成（local/trusted） | 会话/消息/统计/Trace/审批与 L1/L2 缓存按租户隔离；非 default 租户文件根为 `<workspace>/.tenants/<id>`；`maxSessions`、`maxActiveRuns`、`maxCostUsd`、`maxStorageBytes`、`maxToolCallsPerMinute` 与 MCP server 调用配额落地；`tenant-workspace backup|restore|list` 提供迁移前快照与失败回滚。remote/team 在强隔离/provider 缺失时 fail-closed |
| 租户 API token / principal | 已完成 | `api_tokens` 只存 sha256 哈希；token 仅创建响应展示一次；admin/member/readonly 角色、租户绑定、过期与吊销；Header 不能横穿绑定租户；readonly 拒绝变更；`/api/tokens` 管理需 admin；审计与 401/403 门保持 |
