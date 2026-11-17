# maharness 运行时与插件契约 v3

## 运行模型

用户界面和 HTTP API 通过 RunService 发起任务。RunService 保存任务状态、执行事件、断点、工具结果、子任务关系、规则裁决、能力选择、副作用和费用记录，并调用可替换的 Agent 循环。默认循环组装当前输入、调用模型、执行原生工具调用、回填观察，直至模型回答结束或运行中断。规划、技能、记忆、委派与自动化由模型按需使用。

会话保存对话，任务保存一次目标的执行状态。同一会话同时只能运行一个主任务；子任务受父任务管理。关闭页面或断开事件订阅不会停止任务。服务重启后，未完成任务显示为可恢复，等待用户操作。

| 状态 | 含义 |
| --- | --- |
| queued | 已持久化，等待执行 |
| running | 正在运行 |
| waiting_approval | 等待用户决定具体操作 |
| stopping | 已收到取消请求，正在停止 |
| interrupted | 执行中断，可检查断点并申请恢复 |
| completed | 模型已结束回答 |
| failed | 执行失败 |
| cancelled | 用户取消 |

completed 与机器验收分别记录。没有显式验收条件或验收记录时，界面显示结果尚未验证。

## 插件契约与能力发现

运行时插件 API 为 `3.0.0`。新插件声明 `apiVersion: 3`；加载器接受 `apiVersion: 2`，通过兼容适配层提供默认元数据，且不扩大原清单声明的权限。v2 插件不能声明 v3 专属能力索引，现有工具、服务、角色、Provider、页面与事件调用继续可用。

`CapabilityDescriptor` 描述业务能力、适用任务、输入与输出格式、风险、副作用、底层工具、别名和可用状态。`capabilityIndex` 中的每个工具必须已在该插件 `permissions.capabilities.tool` 中授权。能力是发现与选择层，实际调用仍由工具 schema、权限、审批、取消、预算和副作用账本约束。

目录较大时，模型默认看到压缩能力索引。`discover_capabilities` 按意图分页查找能力，`enable_capabilities` 加载其底层工具。重复能力按键排序并以稳定优先级去重，冲突、胜出者、已选能力和加载结果写入 Run 元数据、检查点和 Trace。`discover_tools`、`enable_tools`、`release_tools` 保留为直接或兼容入口。

`CapabilityResolution` 记录 `selected`、`tools`、`reason` 和 `conflicts`。工具版本随实际调用记录；插件卸载或替换不取消已发出的调用批次。

## 开始任务

1. 在设置的开始使用入口配置模型提供商、协议、地址与凭据。
2. 用户主动检测连接和原生工具调用。工具检测会发送一次模型请求，可能计费。
3. 选择工作区，查看该工作区的权限档。
4. 开始任务，在聊天中查看活动、审批、费用与结果。

协议支持工具调用不表示某个模型已确认支持。工具检测通过后保存模型、地址、协议和凭据的指纹；地址、协议或凭据变化后，旧检测不作为当前确认依据。检测未返回有效原生调用时显示本次未确认；网络故障显示未知。

普通模式自主执行。计划模式允许观察，写入和外部变更需要用户批准。目标模式展示目标与进度，执行循环与普通模式相同。是否调用计划工具由模型决定。

活动任务收到新要求时，可补充当前目标，或停止后发起新任务。补充消息先持久化，在下一次模型调用前送达；正在执行的工具参数不因补充消息而改变。

## 权限与框架修改

权限档按租户与工作区保存，并带版本。常规权限允许工作区普通读写，敏感或高风险操作按策略审批，框架源码继续受保护。开发者权限由用户明确开启，允许授权范围内的源码修改及有写权限的子任务。恢复任务重新核对当前授权，不扩大原授权。

子任务继承父任务模型和权限上限，共享父任务费用账本。模型请求与工具执行使用独立的公平队列，委派等待释放执行槽位；审批等待不占执行槽位。默认活动执行容量为 16，默认最大委派深度为 4。父任务取消向子任务传播。固定时间窗口内的委派次数不构成运行边界。

框架修改在项目管理目录的隔离 Git worktree 中进行。审阅记录包含差异、内容摘要和验证结果。用户采纳时检查审阅版本与原工作区状态；冲突停止应用。采纳不自动更新或重启当前实例。密钥、权限配置和发布操作继续受保护。隔离 worktree 和应用守卫属于应用层控制。

## 工具结果与恢复

工具定义必须包含名称、版本、用途、输入 schema、输出 schema、副作用类型与权限声明。调用上下文携带任务身份、工作区、有效授权、取消信号和剩余预算。

可信宿主工具可通过 `classifySideEffect(args)` 返回本次调用的副作用分类，未声明或判定异常时回退静态 `sideEffect`。权限交集、写锁、恢复账本、Trace 与运行诊断均使用本次调用分类；process 工具拒绝跨进程传递该函数。

可信宿主工具可通过 `executionTimeoutMs(args)` 返回本次执行期限；process 工具使用静态 `timeoutMs`，拒绝跨进程传递动态期限函数。

| 结果字段 | 契约 |
| --- | --- |
| ok / data | 成功标记与结构化数据 |
| evidence | 文件、命令或其他可核对依据；产物证据可登记为任务产物 |
| truncated / resultRef | 输出是否截断以及完整结果引用 |
| failure.code | 稳定错误码 |
| failure.retryable | 是否可重试 |
| failure.outcome | not_started、applied 或 unknown |

输出与 schema 不符时返回 TOOL_OUTPUT_SCHEMA。已发生的变更保留 applied 事实。副作用结果未知时不自动重放，恢复接口拒绝继续；用户核对实际结果后可发起明确的新任务。

只读且声明幂等的工具可按策略重试瞬态错误。写入和外部副作用不因普通网络错误重放。工具超时与取消会传递中止信号，委派调用将该信号传递给对应子任务；不响应信号的处理器结束前继续占用物理槽位。process 插件先收到协作中止信号，1 秒内未完成则请求终止子进程，并等待实际退出。长命令的等待超时返回当前状态；command_cancel 返回 stopping 时仅表示已请求停止。command_output 的 nextOffset 小于 length 时可继续分页，outputLimited 表示存储上限造成的截断。

长工具结果保存后支持通过 recall_tool_result 分页读取。读取工具是运行能力，自定义工具集合也包含该入口；同名冲突返回 TOOL_DEFINITION_CONFLICT。托管任务按任务与租户隔离结果，恢复后引用继续有效。文件编辑可通过预期版本或内容匹配检测冲突；并行写入经过写锁。

工具执行前的断点保存完整原生调用批次、已回填观察及当前调用的结果标识。部分执行的原生工具批次在恢复时保留调用与观察的配对，并闭合对应执行记录。已确认完成的副作用从执行账本补回结果，其余尚未开始的调用返回 TOOL_INTERRUPTED。恢复记录通过 tool_recovered 事件关联结果。旧断点缺少原生批次或可核对的执行边界时返回 CHECKPOINT_INCOMPLETE；存在未知副作用时返回 EFFECT_OUTCOME_UNKNOWN，均不自动重放。

文件读取、目录列举、文件名匹配与内容搜索共享受保护路径边界。工作区内部 data/ 和 .env 不作为模型可读材料；原生搜索与 JS 回退执行相同过滤，权限边界变化后的旧搜索缓存不复用。

## 规则、模型输入与诊断

原始对话、运行事件和模型输入分别保存。每个 AGENTS、全局规则与项目规则文件作为独立上下文传递，并提供自己的 `RuleDescriptor`；persona、技能建议和插件建议保持独立来源。`RuleResolution` 按固定优先级裁决并记录来源、作用域、内容哈希、冲突、忽略项和胜出者。

固定优先级为：运行时不变量与安全边界 > 当前明确用户指令 > 已确认的项目或持久用户规则 > 技能和插件建议 > 示例与样式。网页、文件、MCP 返回、工具输出及父代理说明保留为任务材料或观察，不能提升为核心系统指令。`GET /api/rules/effective` 返回当前生效规则、冲突和未执行原因。

ContextItem 记录来源、作用域、信任级别和保留策略。插件用途通过工具描述和能力发现暴露。用户明确设置的规则保留其来源。

上下文容量按模型窗口与输出预留计算。压缩保留明确约束并记录来源范围；原始材料仍可读取。必需输入超过容量时返回 CONTEXT_CAPACITY，供用户更换模型或缩减任务。

授权工具 schema 能装入目录预算且没有显式释放项时，直接提供完整工具集。更大的集合提供 discover_tools、enable_tools 和 release_tools，优先加载声明 discovery.initial 的工具；未声明时沿用常用工具集合。discover_tools 的 query 可省略以分页读取索引，检索包含工具用途、插件标识与关键词；详情包含版本与完整契约。目录预算为 4096 tokens 与可用输入容量 10% 中的较小值，并按实际管理工具 schema 估算预留。完整结果读取工具与恢复后仍获授权的已启用工具始终保留，不因目录预算而静默删除；显式释放项通过断点 releasedTools 保留，可重新启用。能力变化在模型调用边界刷新；小目录的新工具直接可用。模型窗口仍构成输入硬边界。工具顺序稳定，不按任务关键词重排。

L1 相似答案缓存默认关闭。L2 工具缓存保留状态指纹和作用域，Provider 原生前缀缓存按实际输入复用。备用提供商在设置的备用线路中显式启用并保存顺序。

任务视图和运行轨迹入口提供任务状态、子任务、产物、工具执行记录、完整结果分页和模型输入。机器验收独立显示通过、部分通过、未通过或尚未验证；工具记录显示结构化错误码、已知副作用状态和重试声明，未知结果标明禁止自动重放。每次模型调用记录实际提供商、模型、消息、工具 schema、执行尝试标识、恢复断点和输入指纹。diagnostics.messageTokens、toolTokens 与 sources 为本地估算分项，不代表提供商计费用量；历史记录缺失时显示未记录。输入详情沿用任务认证与租户边界，完整内容不写入普通日志。

## 模型调用与费用

Provider Gateway 暴露统一 call 契约。内置主循环、历史摘要、视觉分析、MCP sampling 和 embedding 经过 kernel/model-call，继承任务取消与调用容量。连接检测、预热和无任务后台索引记入独立维护账本。任务的显式截止时间会主动取消在途请求及子任务，状态与用户主动取消分开记录。MCP stdio sampling 只绑定唯一在途工具任务；缺少归属或并发歧义时拒绝，不借用其他会话。

每个实际请求持久记录调用 ID、用途、逻辑轮次、提供商、请求模型、可用时的返回模型、用量确定性和价格来源。流中断、缺失或部分 usage 保持未知；未知价格不能作为确认零价。主子任务逐请求结算到同一根账本，恢复和重复回执不重复计账。未知执行中的模型请求不会通过重放来获取账单。

advisory 任务在额度超出、价格未知或用量不完整时继续执行，并在任务详情和聊天中提醒。用户可核对后确认，或在现有模型设置中修正具体计费配置。enforce 请求需要适配器可保证的输入计费上界、输出限制及已知价格；缺失条件返回 MODEL_BUDGET_UNCERTAIN。声明真实免费且适配器保证输出限制的调用可预留零费用。供应商账单不构成本地运行时可绝对保证的边界。

新任务不通过文本前缀判断用户目标、约束或摘要。历史断点中缺失结构化来源的预算仍保留原 `enforce` 语义。插件临时观察不提升为核心指令，也不写入原始用户对话。

## HTTP API

以下接口沿用实例的认证和租户规则。写入权限档与采纳框架修改要求用户身份授权，不提供为模型授权工具。

| 方法与路径 | 用途 |
| --- | --- |
| POST /api/v2/sessions/:id/runs | 创建任务；返回 runId 和任务记录 |
| GET /api/v2/runs | 当前租户任务列表；可按 sessionId 过滤 |
| GET /api/v2/runs/:id | 任务状态、结果、费用和验证记录 |
| GET /api/v2/runs/:id/events | SSE 事件订阅；Last-Event-ID 补读 |
| POST /api/v2/runs/:id/messages | 补充活动目标 |
| POST /api/v2/runs/:id/cancel | 取消任务及子任务 |
| POST /api/v2/runs/:id/resume | 用户恢复中断任务 |
| GET /api/v2/runs/:id/children | 子任务记录 |
| GET /api/v2/runs/:id/artifacts | 登记产物 |
| GET /api/v2/runs/:id/model-calls | 按 offset、limit 分页读取任务模型调用账本 |
| POST /api/v2/runs/:id/billing/acknowledge | 用户核对已结束任务的费用提醒；不改写调用账本 |
| GET /api/v2/runs/:id/tools | 工具执行记录 |
| GET /api/v2/runs/:id/inputs | 最近 10 轮模型输入；before 指定更早输入游标 |
| GET /api/v2/runs/:id/results/:callId | 完整结果分页；offset 和 limit 指定范围 |
| GET /api/v2/workspace/permissions | 当前工作区权限档 |
| PUT /api/v2/workspace/permissions | 用户修改权限档；携带 profile 与 revision |
| POST /api/providers/:id/tool-check | 用户检测模型原生工具调用能力 |
| GET /api/rules/effective | 生效规则、冲突与未执行原因 |
| GET /api/workbench/summary | 工作台聚合事项、自动化、运行、产物、项目、笔记和本地指标 |
| GET /api/automations | 自动化定义与最近执行 |
| POST /api/automations | 创建自动化 |
| GET /api/automations/:id/runs | 自动化执行历史 |
| PATCH /api/automations/:id | 按 revision 修改自动化 |
| POST /api/automations/:id/confirm | 用户确认待审批自动化 |
| POST /api/automations/:id/pause | 暂停新运行 |
| POST /api/automations/:id/resume | 恢复已确认自动化 |
| POST /api/automations/:id/run | 立即创建一次独立 Run |
| DELETE /api/automations/:id | 取消自动化 |

创建任务可传入 message、provider、model、budgetUsd、budgetPolicy、deadlineAt 和 acceptance。budgetPolicy 默认为 advisory：费用额度只触发提醒，不停止任务；enforce 必须由用户明确选择，无法可靠预留时不发起新调用。截止时间与验收条件仅从显式配置读取。创建和补充消息支持 Idempotency-Key，同一键用于不同内容时返回冲突。

框架修改接口位于 /api/v2/framework/changes，提供创建、列举、review、validate 和 adopt。adopt 携带用户审阅的 digest。

## 自动化内核

`AutomationDefinition` 保存名称、任务提示词、租户与工作区、资料版本、Provider 与模型、预算策略、触发器、IANA 时区、启停与审批状态、创建者和关联事项。触发器支持手动、单次时间、每日、工作日、每周、每月、工作区文件变化和公开 URL 变化。

自动化定义、计划发生时间、触发基线和 Run 关联保存在 SQLite。每个发生使用幂等键创建独立 Run；重启后恢复未决计划。一次扫描会推进全部已到期计划，逾期 24 小时内的最新一次最多补跑一次，更早的发生标记为跳过并进入工作台。DST 缺口中的不存在本地时间按跳过的时差顺延（如 `02:30 → 03:30`），回拨重复时间只运行第一次。同一自动化默认最多保持一个活动 Run；暂停只阻止新 Run，取消活动实例调用现有 RunService。

模型通过 `automation_list/get/create/update/pause/resume/run/cancel` 操作自动化。用户明确要求的一次性预约可直接创建；周期、文件与 URL 监控首次必须由用户确认。模型不能设置或绕过确认状态。任务提示词、触发器、资料版本或模型变化后，自动化重新进入待确认状态。

文件触发忽略 `outputs/` 等生成目录。URL 触发只接受公开地址，并复用 SSRF、DNS 逐跳检查、超时、取消、ETag 与内容哈希边界。自动化 Run 沿用当前权限交集、审批策略、预算账本、检查点和产物机制；无人值守遇到审批时进入 `waiting_approval`，不会自动批准。

## AI 用户复盘

人类通过运行诊断或工作台主动发起复盘。服务端读取所选 1 至 10 条同一原始模型的已结束 Run，生成紧凑 `FactLedger`，记录目标、终态、验收、能力选择、规则冲突、工具错误与重复、工具版本、恢复、审批等待、产物是否可解析，以及按 Run 汇总的模型用途、输入、输出、费用和失败数。超长工具结果只登记引用、长度和截断状态，正文按证据预算分段读取。原始 Run 和 Trace 继续作为事实主存储；复盘记录只保存摘要、证据引用、内容哈希和人工校准。

事实账本以租户、工作区、选定 Run、Rubric 内容哈希及 Run 源内容哈希为键，在进程内保留最多 32 份紧凑结果；源 Trace、工具、模型调用或产物变化会产生新键。证据片段按引用和内容哈希复用，同一证据在一个复盘输入中只读取和发送一次。

快速路径适用于结果清楚且没有异常的单 Run，一次模型调用完成评分。存在失败、循环、事实冲突、上下文连续性信号或证据不足时进入聚焦路径：第一次调用只选择最多 6 个相关证据引用并声明证据缺口，第二次调用完成评分。多 Run 复盘先在本地聚类重复摩擦，再选择代表证据。总预算分别为 3,800、9,200 和 11,500 token；超出预算、输出不合格或证据无效时直接保留结构化失败状态，不自动重试。

每个正面观察、问题和建议必须引用有效证据。任务完成、验收通过、产物可解析、无虚假成功和无未知或未授权副作用是事实门槛；P0/P1 不能被 AI 评分抵消。事实门槛未通过而 AI 仍给出高平均分和高再次使用意愿时，原始 AI 评分保持不变，并记录结构化的“自评偏差”供界面和诊断展示。复盘默认由原模型执行；原模型不可用时，人类必须显式选择替代模型。独立复核需要人类再次确认费用；人工校准以追加记录保存，不改写原始 AI 评分。体验问题关闭需要已通过的回归结果，或由人类在 `statusNote` 中记录明确例外。

| 接口 | 行为 |
| --- | --- |
| POST /api/experience/reviews/estimate | 估算路径、模型、输入输出上限与费用 |
| POST /api/experience/reviews | 主动发起单次或多 Run 复盘 |
| GET /api/experience/reviews | 按租户列出复盘，可按 Run 过滤 |
| GET /api/experience/reviews/:id | 读取事实、AI 复盘、复核、校准与相关问题 |
| POST /api/experience/reviews/:id/cancel | 取消排队或执行中的复盘 |
| POST /api/experience/reviews/:id/deepen | 对证据不足结果继续深入分析 |
| POST /api/experience/reviews/:id/audit | 发起可选独立复核 |
| POST /api/experience/reviews/:id/calibrate | 追加人工校准，不改写原始事实和 AI 评分 |
| POST /api/experience/reviews/:id/suggestions/:suggestionId/adopt | 由人类采纳建议进入问题池 |
| GET/PATCH /api/experience/findings | 查询和推进体验问题状态 |
| POST /api/experience/findings/:id/reproduce | 建立可执行回归案例 |
| POST /api/experience/findings/:id/verify | 绑定已结束验证运行并登记回归结果 |
| POST /api/experience/findings/:id/evolve | 由人类提交满足证据门槛的问题到自进化提案 |

模型调用账本用途增加 `experience_review` 和 `experience_audit`。事件 `experience.review.updated` 与 `experience.finding.updated` 按租户推送。AI 复盘不能修改 Rubric、规则、提示词、技能、测试、代码或直接触发自进化；问题和回归案例的人工采纳继续走现有机制。

## 数据迁移与回滚

升级前停止旧实例，确保没有活动调用。数据库迁移前，在数据库同目录生成带迁移前标记的 SQLite 快照，并备份配置与插件清单。迁移失败拒绝启动；版本化迁移在事务内推进。新建空库直接创建 schema 10。

schema 8 到 9 新增 `automations_v3`、`automation_occurrences_v3`、`automation_trigger_baselines_v3`、`scheduled_recovery_jobs_v3` 及 Run 来源字段。历史续跑计划从 `schedules.json` 一次性导入 SQLite，原文件归档为 `schedules.json.migrated`。历史会话、Run、文件、事项、模型配置、用户规则、插件授权与审批记录保持不变。旧断点在聊天中可查看；用户核对先前操作后，以明确目标发起新任务，不自动重放旧工具。

schema 9 到 10 新增 `experience_reviews_v1`、`experience_findings_v1`、`experience_audits_v1` 和 `experience_regressions_v1`。历史 Run、Trace、会话、文件、事项、自动化和插件数据保持不变；历史运行按尚未复盘处理。

新插件声明 `apiVersion: 3`。v2 插件通过适配层继续运行，但不获得 v3 能力索引等专属元数据。迁移配置前保留原文件，不自动重写用户自定义规则。

回滚步骤：

1. 停止实例，保留当前数据库、配置、主密钥和运行数据副本。
2. 选择同一批次的迁移前 SQLite、配置和插件清单，检查快照完整性。
3. 将 SQLite 快照恢复到原数据库路径，恢复对应配置，并处理该数据库原有的 WAL/SHM 伴生文件；只在实例停止后操作。
4. 恢复与备份匹配的主密钥和插件版本，使用与旧 schema 兼容的程序启动。
5. 检查会话、配置与插件加载状态，再恢复使用。

数据库与配置回滚不会撤销文件或外部系统已发生的操作。插件清单用于核对版本，不能替代插件源码备份。主密钥需与加密数据库匹配。

## 验证与真实模型评测

本地验证入口：

```powershell
npm run typecheck
npm run ui:typecheck
npm test
npm run test:security
npm run build
npm run e2e
```

v3 定向确定性测试覆盖 schema 8 到 10 迁移、v2 插件适配、能力去重、规则冲突、自动化幂等、时区与 DST、服务重启、逾期补跑、并发抑制、分层确认、权限交集、审批等待、取消、文件变化、URL 限流、SSRF、会话导航、关闭按钮和移动端返回。AI 用户复盘另覆盖事实压缩、长结果索引、模型用量与工具版本、按内容哈希复用与失效、异常与重复摩擦、恢复、证据去重与预算、实测超预算终止、快速与聚焦路径、幂等、取消、租户隔离、模型不可用、虚假成功门槛、建议采纳和人工校准。浏览器 E2E 覆盖从设置、插件页和工作台点击会话返回聊天、功能页关闭、四项稳定导航、Provider 配置、文件导入、事项创建、周期自动化确认，以及运行选择、估算、复盘结果三轨展示、独立复核、建议采纳、回归验证和旧复盘返回来源会话。

真实模型验收使用当前已配置的单一模型与既有预算，最多执行 9 个样本，覆盖一次性预约、周期任务确认、修改或暂停自动化、文件触发、工作台事项更新、大工具目录能力选择、规则冲突、重启恢复和文件任务闭环。通过条件为至少 8/9 完成预期任务、未经确认创建周期或触发任务为 0、虚假成功状态为 0；Trace 记录耗时、模型调用数、token 与费用。没有可用模型或预算时记录“未执行”。

AI 用户复盘真实模型抽样于 2026-11-17 使用当前唯一配置路由 `group/never-stuck` 尝试 9 个样本，1/9 通过；8 个常规样本未形成有效复盘，模型不可用样本通过。该路由只公布 `high` 推理档，并在诊断调用中产生 23,783 个推理字符；一次获得有效输出的调用记录为输入 1,487、输出 9,653 token，总计 11,140 token，因此按事实统计被 3,800 token 快速路径上限拦截。报告位于 `evals/reports/experience-live/real-20261117/` 与 `evals/reports/experience-live/real-20261117-case1-headroom/`；9 样本报告的 `calls/tokens = 0` 表示该批未取得完整用量回执，不能据此认定未发送请求。本批真实模型验收未通过；不得把推理 token 排除在预算外，也不得用确定性回放替代该结论。本批及诊断已用尽本轮真实模型调用预算，未继续追加调用。

## 任务插件

工作区设置中的“任务插件开发”默认关闭，与开发者权限独立。用户管理员可通过 PUT /api/v2/workspace/plugin-development 设置 enabled、permissions、dependencies 与当前权限 revision；版本冲突或存在活动任务时拒绝变更。外部依赖必须已在实例的 plugins.allowedDependencies 中批准。模型无法注册该授权接口为自己的工具。

create_plugin 接收 id 和 source，或 files 与完整 v3 manifest，产生 staged 候选；enable_plugin 验证并激活。v3 manifest 可声明 `capabilityIndex`，索引只能引用已授权工具。工具权限不得超过授权；直接宿主文件、进程和网络访问声明被拒绝，业务操作通过统一工具代理调用。完整类型插件仍是可信 JavaScript，静态检查不是代码安全隔离。

plugin_status 返回版本、哈希、实际注册能力、文件索引和工作区可用插件；sdk=true 按需读取 SDK 接口，example 按九类能力或 composition 返回完整源码与 manifest，id、path、offset、limit 支持按范围读取源码。公共类型入口为 kernel/plugin-sdk。自动 manifest 推断按能力种类读取 name、id、mount 或 event；动态注册需要显式 manifest。类型错误返回阶段、错误码、文件、行列与消息。invoke_plugin 显式调用 command、role 或 provider；command 默认执行期限 30 秒，可通过 CommandDef.timeoutMs 声明，handler 第二参数接收 signal；role/provider 为 240 秒。角色通过统一子任务入口执行，取消与失败保留为失败结果；供应商经统一模型账本执行且不切换当前模型。persona 通过源码读取按需使用，context 作为临时参考材料参与后续模型输入。

GET /api/v2/runs/:id/plugins 返回插件清单和任务授权快照。POST /api/v2/runs/:id/plugins/:pluginId/save 由用户管理员提交确定 hash，将已验证版本保存到该租户、该工作区。staged 或 error 版本不能保存。GET /api/v2/runs/:id/plugins/:pluginId/api/:mount 仅能访问活动任务插件的相应 API；其他 HTTP 方法沿用相同认证与权限检查。诊断中的 panel 入口要求 api:panel 声明并净化 HTML。

run_plugins_v2 保存任务绑定与源码；workspace_plugins_v2 保存显式复用版本；plugin_development_v2 保存工作区授权。恢复要求源码及 manifest 哈希一致、依赖可解析、当前授权仍有效。子任务的 plugins 参数为明确继承的活动插件 id，运行服务一并复制它们的依赖闭包。任务结束释放运行资源，保存插件和恢复数据库都不撤销外部副作用。
