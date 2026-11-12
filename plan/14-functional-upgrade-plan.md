# maharness 功能性升级方案

## 目标

在不破坏“一切皆插件”架构的前提下，把 maharness 从“能力齐全的 Agent Harness”推进到“任务完成质量高、生态接入广、可评测、可恢复”的成熟产品。

升级重点不是继续堆工具数量，而是补齐三类基础能力：

1. Agent 核心的模型抽象、结构化输出、任务状态和多 Agent 编排。
2. 内置插件的研究、代码、记忆、浏览器、文档和 MCP 深度。
3. 评测、遥测、沙箱和策略等质量底座。

## 基线

| 已有能力 | 现状 |
| --- | --- |
| 插件机制 | manifest、热加载、回滚、依赖注入、服务接管已具备 |
| 任务循环 | 决策-行动-观察、工具审批、预算、取消、checkpoint 已具备 |
| 可观测性 | 自研 Trace、JSONL 审计、步骤筛选和导出已具备 |
| 安全 | 路径沙箱、PowerShell 白名单、SSRF、MCP 环境隔离已具备 |
| 模型 | OpenAI 兼容、Anthropic、Ollama 三协议已具备 |
| 记忆 | JSON facts + core memory block + bigram 相关匹配 |
| 搜索 | Tavily / DuckDuckGo + 简单网页正文提取 |
| 代码工具 | 文件读写、grep/glob、编辑、删除 |
| 多 Agent | run_subagent / run_parallel 一次性委派 |
| 评测 | 确定性回放 case + 全量单测 + UI E2E |

## 升级原则

- 内核只新增稳定契约和 service 接口；具体能力继续由核心插件或现场插件实现。
- 开源项目只作为设计参考或可选插件依赖；不把 LangGraph、CrewAI、AutoGen 等整体框架塞进内核。
- 每个功能包必须有契约文档、自动化验证、Trace 字段、回滚路径和 UI 入口（涉及用户可见能力时）。
- 先做能放大其他能力的底座，再做单点功能。

## 实施状态

| ID | 状态 | 已落地 |
| --- | --- | --- |
| CORE-01 | 已完成 | Provider 增加 `responseFormat` 与能力矩阵；子代理、审查和并行任务复用 `routeForTask`；embedding 以 `service:embedding` 暴露；成本、缓存命中与候选路由进入 Trace |
| CORE-02 | 已完成 | 内核 schema 校验覆盖 additionalProperties、pattern、组合 schema、数组与数值边界；工具参数在审批/执行前校验；非法 JSON/schema 不进入 handler；结构化输出失败执行一次 JSON repair 并计成本 |
| CORE-03 | 已完成 | checkpoint 保存完整历史、runId、任务合同与副作用账本；进程重启/强杀后可恢复且不重放文件、HTTP、子进程副作用；goal-plan 计划落盘 `data/plans.json`，原子写、损坏回退和 LRU |
| CORE-04 | 已完成 | Context Provider 支持来源标记与单 provider token 上限；记忆/技能索引返回 provenance；Trace 记录来源；压缩保留根约束并输出来源范围 |
| CORE-05 | 已完成 | 会话级 `blackboard` 提供工具与服务两种入口；`run_parallel` 支持 `id` / `dependsOn` / `publish`，按依赖波次调度，下游只接收上游结构化结论，失败不阻塞无关分支 |
| CORE-06 | 已完成 | Trace 归档索引按 mtime/size 缓存；可选 OTLP/HTTP 导出插件把步骤映射为标准 span；确定性 eval 基线覆盖任务、审批、恢复、缓存与安全攻击 |
| PLUG-01 | 已完成 | 长期记忆支持 embedding 向量召回、查询向量缓存与余弦排序；无 embedding 时回退 bigram + 置信度/时效评分；记忆块与档案事实分层注入 |
| PLUG-02 | 已完成 | 搜索链 SearXNG → Tavily → DuckDuckGo；结果本地去重与查询重排；`web_fetch` 单页清洗；`web_crawl` 并发抓取 1-5 页并输出引用清单；SSRF、重定向与体积上限共用同一防护 |
| PLUG-03 | 已完成 | `repo_map` / `find_symbol` 对 TS/JS 使用 TypeScript AST，其他语言回退正则；`project_diagnostics` 运行 TypeScript 编译器返回项目内类型错误与行列号 |
| PLUG-04 | 已完成 | 可选 Playwright 浏览器插件：打开、快照、点击、输入、按键、截图、关闭；会话级 profile、默认拒绝私网、交互动作审批、进程回收 |
| PLUG-05 | 已完成 | MCP 客户端支持 stdio/http、最小环境透传、默认审批、SSRF 与进程树回收；服务端 `/api/plugins/mcp/rpc` 支持 initialize / ping / tools/list / tools/call，强制 allowlist |
| PLUG-06 | 已完成 | 技能 frontmatter 支持 `version` / `requires` / `allowed-tools`；embedding 语义路由；缺失依赖告警；覆盖安装保留 5 份快照，支持 `list_skill_backups` / `rollback_skill` |
| TRUST-01 | 已完成 | 路径沙箱、PowerShell 白名单、规则 allow/deny/审批、SSRF、`check_policy` 策略模拟与授权审计共同构成策略层；危险工作区根与敏感路径在入口复检 |
| TRUST-02 | 已完成 | `read_document` 支持 PDF / DOCX、PDF 页码范围、正文限额、PDF 表格检测、DOCX 表格抽取；输出统一正文、表格行和截断标记 |
| TRUST-03 | 已完成 | 静态审查覆盖进程、文件、动态代码、密钥、网络与依赖策略；`create_plugin` 写入前审查并在隔离进程试运行；外部 npm 包必须命中 `plugins.allowedDependencies`，依赖清单写入 manifest |
| OPS-01 | 已完成 | admin / readonly 双角色；readonly token 绑定租户；`tenants` 注册表支持 `maxSessions` 配额；会话、消息、统计、Trace 查询与审批按 `x-maharness-tenant` 隔离；设置页可切换租户；共享基础设施边界写入 README |

所有功能包均有对应自动化验证；`npm test`、`npm run typecheck`、`npm run build`、`npm run eval:ci` 与 UI E2E 作为合并门禁。

## 功能包清单

### P0：Agent 核心底座

| ID | 功能包 | 目标 | 借鉴方案 | 工作量 |
| --- | --- | --- | --- | --- |
| CORE-01 | Provider Gateway | 统一模型、embedding、rerank、视觉、结构化输出和成本口径 | LiteLLM、Portkey Gateway、OpenAI Agents SDK | L |
| CORE-02 | Structured Output & Tool Contract | 工具参数/结果和模型结构化输出机器可判 | Instructor、Outlines、Zod、Ajv、Pydantic | M |
| CORE-03 | Durable Task Runtime | 步骤级状态机、定时器、人工节点和崩溃恢复 | Temporal、LangGraph checkpointer、Restate | L |
| CORE-04 | Context & Retrieval Engine | 分节预算、检索式上下文包、压缩与引用 | LlamaIndex、Haystack、LLMLingua | L |
| CORE-05 | Multi-Agent Orchestration | supervisor graph、共享黑板、依赖 DAG、handoff | LangGraph supervisor、CrewAI Flows、AutoGen、OpenAI Agents SDK | L |
| CORE-06 | Evaluation & Telemetry | OTel 标准 trace、外部观测、模型评分和基准 | OpenTelemetry GenAI、Langfuse、Arize Phoenix、DeepEval、Ragas、Promptfoo | M |

### P1：内置插件质量

| ID | 功能包 | 目标 | 借鉴方案 | 工作量 |
| --- | --- | --- | --- | --- |
| PLUG-01 | Memory 2.0 | 分层记忆、向量召回、时序图谱、巩固与衰减 | Mem0、Letta/MemGPT、Zep/Graphiti、sqlite-vec、LanceDB | L |
| PLUG-02 | Research / Search 2.0 | 多源搜索、爬取、重排、文档解析和引用 | SearXNG、Crawl4AI、Firecrawl、Docling、Marker、GROBID、BGE reranker | L |
| PLUG-03 | Code Intelligence | repo map、符号索引、LSP、补丁和测试闭环 | Aider、tree-sitter、LSP、Continue、Cline、SWE-agent、OpenHands | L |
| PLUG-04 | Browser & Computer Use | 网页交互、DOM、截图、下载和网络观测 | Playwright、Browser Use、Stagehand | M |
| PLUG-05 | MCP Ecosystem | MCP server、registry、OAuth、allowlist 和重连 | MCP SDK、MCP registry、A2A | M |
| PLUG-06 | Skills Ecosystem | 版本、依赖、语义检索、权限和技能评测 | Agent Skills 规范、OpenAI Agents SDK、技能市场锁文件 | M |

### P2：信任与内容能力

| ID | 功能包 | 目标 | 借鉴方案 | 工作量 |
| --- | --- | --- | --- | --- |
| TRUST-01 | Sandbox & Policy | 可插拔沙箱、策略即代码、提示注入和 PII 防护 | E2B、Daytona、Firecracker、gVisor、OPA、Casbin、NeMo Guardrails、Guardrails AI、Presidio | L |
| TRUST-02 | Document & Vision | PDF/Office/OCR/表格/扫描件结构化抽取 | PaddleOCR、Tesseract、Docling、Marker、GROBID | M |
| TRUST-03 | Self-extension Safety | 生成代码静态检查、隔离试运行和 eval gate | Semgrep、tree-sitter、OpenHands 沙箱 | M |
| OPS-01 | Team & Tenant | 团队身份、角色、租户隔离和配额 | OpenFGA、Casbin、OpenTelemetry | L |

## 详细方案

### CORE-01 Provider Gateway

**现状缺口**

- `core/chat` 只有 OpenAI 兼容、Anthropic、Ollama 三种客户端。
- 结构化输出、embedding、rerank、统一 token 计数和 prompt caching 仍分散或缺失。
- 成本、能力、路由和健康状态没有统一的服务契约。

**改造范围**

- 内核新增 `service:provider-gateway` 契约，统一 chat / embedding / rerank / vision / structured-output 能力。
- `core/chat` 的协议客户端收敛为网关适配器；模型目录增加能力矩阵和价格版本。
- `server/routes/providers` 输出统一能力诊断；设置页展示能力勾选和不可用原因。
- 引入统一 tokenizer 适配层，支持不同 provider 的 token 计数和成本复算。

**交付物**

- Provider Gateway 契约文档和适配器接口。
- 三类协议 + 至少一个 embedding/rerank provider 的契约测试。
- 路由 Trace：候选、能力、价格、延迟、拒绝理由。

**验收**

- 每个 provider 通过同一套 chat/tool/stream/cancel 契约测试。
- 模型能力不足时在路由前拒绝，而不是运行中失败。
- 成本可按请求复算，误差小于 1%。
- failover 不产生重复工具副作用。

### CORE-02 Structured Output & Tool Contract

**现状缺口**

- 工具参数只做轻量 JSONSchema 校验，模型输出错误主要靠提示词纠偏。
- MCP 工具、插件工具和内置工具的参数 schema 来源不统一。
- 输出校验失败只标注，不触发修复或重试。

**改造范围**

- 内核新增统一 schema 层，支持 JSON Schema、Zod 和 Ajv 校验。
- 工具定义增加输入/输出契约、错误分类和 repair 策略。
- 模型结构化输出失败时执行一次 schema repair（带错误信息的重试）。
- MCP 工具 schema 自动转换为内部契约。

**交付物**

- 工具契约 schema 和校验器。
- 模型结构化输出 repair 流程。
- 非法参数、非法输出、MCP schema 不一致的回归 case。

**验收**

- 工具调用参数合法率 100%。
- 结构化输出失败可自动修复或明确终止，不静默降级。
- 同一工具在本地、子代理、并行和 MCP 路径下契约一致。

### CORE-03 Durable Task Runtime

**现状缺口**

- 当前 checkpoint 以 turn 为单位，缺少步骤级状态机、定时器和人工节点。
- `goal-plan` 的计划状态主要保存在内存 Map，进程重启后不能精确续跑。
- 长任务的暂停、继续、交接和超时清理缺少统一状态迁移。

**改造范围**

- 内核新增 durable task 契约：run、step、attempt、timer、signal、checkpoint。
- 事件日志写入 SQLite，步骤级幂等键和副作用账本复用现有 recovery 机制。
- `goal-plan`、`subagent`、`parallel` 改为读取统一任务状态。
- UI 的计划卡和 Trace 增加任务状态、等待原因和恢复入口。

**交付物**

- 任务状态机文档和迁移表。
- 步骤级 checkpoint / resume / cancel / retry API。
- 进程强杀、工具半完成、审批等待和定时器恢复测试。

**验收**

- 任意步骤强杀后从最近有效点恢复。
- 文件、HTTP、子进程副作用不重复执行。
- 暂停/继续/取消/过期清理都有状态测试和 UI E2E。

### CORE-04 Context & Retrieval Engine

**现状缺口**

- 当前上下文是预算估算 + LLM 摘要 + 截断，缺少分节预算和检索式上下文包。
- 记忆、技能、搜索结果和工具结果没有统一的来源、置信度和引用结构。
- 压缩质量没有独立评测。

**改造范围**

- 内核新增 context assembler：system、task、memory、skills、retrieval、tool-result 分节预算。
- 检索结果统一为带来源、时间、置信度和引用锚点的 context item。
- 引入提示压缩和去重策略；压缩前后执行约束保留校验。
- 与 memory、search、skills、document 插件共享检索接口。

**交付物**

- Context item schema 和 assembler。
- 分节 token 预算与压缩 Trace。
- 长任务约束保留率评测。

**验收**

- 长上下文任务关键约束保留率 100%。
- 同等任务 token 降低 30% 以上且正确率不下降。
- 每条注入上下文可追溯到来源。

### CORE-05 Multi-Agent Orchestration

**现状缺口**

- `run_subagent` 和 `run_parallel` 偏一次性委派，缺少 supervisor graph、共享黑板和依赖 DAG。
- 子代理之间不能声明依赖、共享中间产物或按角色动态组建团队。
- handoff 目前是角色切换，不是结构化任务移交。

**改造范围**

- 内核新增 agent graph 契约：节点、边、输入输出、预算、失败策略。
- `subagent` 升级为 agent registry + handoff contract；`parallel` 支持依赖 DAG。
- 新增 shared blackboard（只存结构化中间结果，不共享完整上下文）。
- 预留 A2A 协议适配层，外部 agent 可作为图节点。

**交付物**

- Agent graph schema 和 supervisor 调度器。
- 角色注册、依赖边、共享结果、局部失败聚合。
- 多 Agent 任务的 Trace 视图。

**验收**

- 有依赖的任务可串并行混合执行。
- 子代理上下文不串扰，共享结果有来源和版本。
- 单节点失败不影响无关分支，失败可局部重试。

### CORE-06 Evaluation & Telemetry

**现状缺口**

- Trace 是自研格式，缺少 OpenTelemetry 标准导出。
- 评测以确定性 case 为主，缺少模型评分、RAG 评测和行业基准。
- 质量趋势没有跨版本仪表板。

**改造范围**

- Trace 增加 OTel GenAI span 映射和 exporter。
- 可选接入 Langfuse / Arize Phoenix，不进入内核硬依赖。
- 评测分三层：确定性回归、LLM-as-judge、任务基准。
- 增加 SWE-bench / Terminal-Bench 风格的任务集和成本/延迟指标。

**交付物**

- OTel exporter 和 Langfuse/Phoenix 适配。
- DeepEval/Ragas/Promptfoo 评测适配层。
- 版本对比报告和 CI 阈值。

**验收**

- 每次 run 可导出标准 trace。
- CI 同时运行确定性门禁和抽样模型评测。
- 正确率、成本、延迟、工具失败率可跨版本 diff。

### PLUG-01 Memory 2.0

**现状缺口**

- `core/memory` 使用 JSON 文件和字符 bigram，缺少向量召回和时序知识图谱。
- 记忆抽取、合并、衰减、冲突消解和来源追踪仍较轻。
- 200 条上限和文件存储不适合大规模长期记忆。

**改造范围**

- 记忆分层：working / episodic / semantic / procedural。
- 存储升级为 SQLite + `sqlite-vec`，可选 LanceDB/Qdrant。
- 引入记忆抽取、事实合并、冲突检测、时间衰减和召回重排。
- 保留现有 core memory block 和失败教训机制。

**交付物**

- Memory schema、embedding 管线和 hybrid retrieval。
- 记忆来源、置信度、时效、冲突和撤回审计。
- 召回质量评测集。

**验收**

- recall@k 和冲突消解达到基线。
- 跨会话召回稳定，过期/撤回立即生效。
- 敏感信息写入拦截率 100%。

### PLUG-02 Research / Search 2.0

**现状缺口**

- 只有 Tavily / DuckDuckGo 和简单 HTML 正文提取。
- 缺少多源搜索、爬取、重排、PDF/Office 解析和引用管理。

**改造范围**

- 搜索 provider 可插拔：SearXNG、Tavily、Brave、Exa。
- 新增 crawl/extract 工具，支持 Crawl4AI / Firecrawl 风格抓取。
- 引入 BGE reranker 或同类开源重排模型。
- 文档解析接入 Docling / Marker / GROBID，输出页码、章节和引用块。

**交付物**

- Search provider 接口和 fallback 链。
- Crawl/extract 工具和内容清洗管线。
- 研究任务引用报告。

**验收**

- 研究任务的每条结论可定位到来源段落。
- 多源结果覆盖率、去重率和引用准确率有基准。
- PDF/表格解析有固定回归样本。

### PLUG-03 Code Intelligence

**现状缺口**

- 当前只有文件读写、grep/glob 和文本编辑。
- 缺少 repo map、符号索引、LSP 诊断、补丁语义和测试闭环。

**改造范围**

- 新增 `code-intel` 插件：tree-sitter 符号索引和 repo map。
- 接入 LSP 诊断；提供 patch/diff 工具和失败恢复。
- 增加测试运行器和 git worktree 隔离。
- 与 subagent/parallel 共享代码索引。

**交付物**

- repo map 和符号查询工具。
- LSP diagnostics 工具。
- patch/diff 工具和测试运行器。

**验收**

- 跨文件重构和符号引用查找可完成。
- 补丁失败可回滚，不留下半写文件。
- 代码任务可通过测试闭环验证。

### PLUG-04 Browser & Computer Use

**现状缺口**

- 当前只有图片分析，没有网页交互和 DOM/截图能力。

**改造范围**

- 新增浏览器插件，基于 Playwright 或 Browser Use。
- 提供 DOM snapshot、点击/输入/滚动、截图、下载和网络 trace。
- 高风险动作走审批；浏览器会话支持持久化和隔离。

**交付物**

- 浏览器工具集和会话管理。
- 截图/DOM 证据入 Trace。
- 登录、表单、下载任务样例。

**验收**

- 多页导航和表单任务稳定完成。
- 所有交互动作可审计，危险动作可拦截。

### PLUG-05 MCP Ecosystem

**现状缺口**

- 当前只有 MCP 客户端，没有 server、registry、OAuth 和工具白名单。

**改造范围**

- 把 maharness 工具/资源暴露为 MCP server。
- 增加 MCP registry 安装、升级、回滚和健康检查。
- 支持 OAuth 2.1、工具 allowlist 和断线重连。

**交付物**

- MCP server 路由和工具导出。
- Registry 安装器和锁文件。
- OAuth 与权限审计。

**验收**

- 外部 MCP 客户端可调用 maharness 工具。
- registry 安装/升级/回滚可追溯。
- 未授权工具调用被拒绝。

### PLUG-06 Skills Ecosystem

**现状缺口**

- 当前有 SKILL.md 索引和按需读取，但缺少版本、依赖、语义检索和技能评测。

**改造范围**

- 技能 manifest 增加版本、依赖、权限、适用/拒绝条件和 allowed-tools。
- 技能索引增加 embedding 语义检索。
- 安装/升级/回滚走锁文件和哈希校验。
- 技能执行接入 eval gate。

**交付物**

- 技能 manifest v2 和迁移器。
- 语义检索和版本解析。
- 技能正例/负例评测。

**验收**

- 同名冲突、缺依赖、越权工具和版本回滚都有测试。
- 技能安装后热加载生效，卸载完全恢复。

### TRUST-01 Sandbox & Policy

**现状缺口**

- 当前是本机进程沙箱，remote/team 隔离仍未完成。
- 策略是自研 allow/deny，缺少策略即代码和提示注入防护。

**改造范围**

- 新增 `service:sandbox`，支持本机 Job Object / E2B / Daytona / Firecracker / gVisor。
- 策略接入 OPA 或 Casbin，支持资源、工具、路径、网络和时间约束。
- 接入 NeMo Guardrails / Guardrails AI / Presidio 做提示注入和 PII 防护。

**交付物**

- 沙箱 provider 接口和资源限制。
- 策略包和审计日志。
- 攻击回放集。

**验收**

- 沙箱逃逸、越权工具、提示注入和敏感数据回放全部拦截。
- 策略变更可审计、可回滚。

### TRUST-02 Document & Vision

**现状缺口**

- 当前 `analyze_image` 只做图片借道分析，缺少 OCR、PDF、表格和扫描件处理。

**改造范围**

- 新增 document 插件，统一 PDF / Office / 图片解析。
- 接入 PaddleOCR / Tesseract / Docling / Marker / GROBID。
- 输出页、章节、表格、OCR 置信度和引用锚点。

**交付物**

- 文档解析工具和结构化输出 schema。
- 论文、合同、报表样例。

**验收**

- 三类文档的结构化抽取达到基准。
- 解析失败可降级并明确说明。

### TRUST-03 Self-extension Safety

**现状缺口**

- `self-extend` 已能生成插件，但代码审查、依赖策略和隔离试运行还可加强。

**改造范围**

- 生成代码先过 Semgrep / tree-sitter 静态检查。
- 依赖走 allowlist 和锁文件。
- 在隔离沙箱试运行，通过插件契约测试和 eval gate 后才允许启用。

**交付物**

- 生成代码审查管线。
- 隔离试运行和回滚。

**验收**

- 越权或高风险生成插件不能自动启用。
- 失败版本自动回滚，旧版本继续可用。

### OPS-01 Team & Tenant

**现状缺口**

- 当前是单用户本机模式；API-06 的团队身份和租户隔离仍未完成。

**改造范围**

- 身份、角色、租户和配额进入统一控制面。
- 会话、文件、审批、Provider、Trace 全部按租户隔离。
- 接入 OpenFGA 或 Casbin 做关系授权。

**交付物**

- 租户 schema 和迁移。
- 角色/权限矩阵。
- 跨租户拒绝测试。

**验收**

- 跨租户读写全部拒绝。
- 隔离迁移可回滚。

## 执行波次

### 第一波：统一底座

范围：CORE-01、CORE-02、CORE-06。

出口：

- 模型调用、结构化输出和 trace 口径统一。
- 后续所有插件都能复用同一套 provider、schema 和评测基础设施。

### 第二波：任务质量

范围：CORE-03、CORE-04、PLUG-01、PLUG-02、PLUG-03。

出口：

- 长任务可恢复。
- 记忆、搜索和代码任务质量明显提升。
- 研究/代码类任务有可引用证据和测试闭环。

### 第三波：生态与自治

范围：CORE-05、PLUG-04、PLUG-05、PLUG-06、TRUST-01、TRUST-02、TRUST-03。

出口：

- 多 Agent 可编排。
- 浏览器、文档、MCP 和技能生态可用。
- 沙箱、策略和自扩展安全达到可发布门槛。

### 第四波：团队化

范围：OPS-01。

出口：

- 团队身份、租户隔离和配额可用。
- 才允许讨论局域网/公网部署。

## 全局验收门禁

每个功能包关闭前必须同时满足：

1. 契约文档和迁移说明。
2. 单元测试 + 集成测试 + 至少一个 E2E 或 golden case。
3. Trace 字段和错误分类。
4. 安全/权限负向测试（涉及执行、文件、网络、插件时）。
5. 回滚路径和配置开关。
6. 用户可见能力有 UI 入口和空/错/加载状态。
7. `npm test`、`npm run typecheck`、`npm run ui:typecheck`、`npm run build`、`npm run eval:ci`、`npm run e2e` 全绿。

## 不做的事

- 不把完整 Agent 框架作为内核依赖。
- 不为“生态完整”同时引入多套同类框架。
- 不把页面、业务状态和产品 UI 写入内核。
- 不在沙箱、策略和租户边界完成前开放远程共享部署。
- 不用新增工具数量替代任务完成质量。
