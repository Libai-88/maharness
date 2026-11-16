# maharness 运行时与插件契约 v2

## 运行模型

用户界面和 HTTP API 通过 RunService 发起任务。RunService 保存任务状态、执行事件、断点、工具结果、子任务关系和费用记录，并调用可替换的 Agent 循环。默认循环组装当前输入、调用模型、执行原生工具调用、回填观察，直至模型回答结束或运行中断。规划、技能、记忆与委派由模型按需使用。

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

可信宿主工具可通过 executionTimeoutMs(args) 返回本次执行期限；process 工具使用静态 timeoutMs，拒绝跨进程传递动态期限函数。

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

## 模型输入与诊断

原始对话、运行事件和模型输入分别保存。ContextItem 记录来源、作用域、信任级别和保留策略。网页、文件、MCP 返回及父代理说明保留为任务材料或观察，不提升为核心系统指令。插件用途通过工具描述和能力发现暴露。用户明确设置的规则保留其来源。

上下文容量按模型窗口与输出预留计算。压缩保留明确约束并记录来源范围；原始材料仍可读取。必需输入超过容量时返回 CONTEXT_CAPACITY，供用户更换模型或缩减任务。

授权工具 schema 能装入目录预算且没有显式释放项时，直接提供完整工具集。更大的集合提供 discover_tools、enable_tools 和 release_tools，优先加载声明 discovery.initial 的工具；未声明时沿用常用工具集合。discover_tools 的 query 可省略以分页读取索引，检索包含工具用途、插件标识与关键词；详情包含版本与完整契约。目录预算为 4096 tokens 与可用输入容量 10% 中的较小值，并按实际管理工具 schema 估算预留。完整结果读取工具与恢复后仍获授权的已启用工具始终保留，不因目录预算而静默删除；显式释放项通过断点 releasedTools 保留，可重新启用。能力变化在模型调用边界刷新；小目录的新工具直接可用。模型窗口仍构成输入硬边界。工具顺序稳定，不按任务关键词重排。

L1 相似答案缓存默认关闭。L2 工具缓存保留状态指纹和作用域，Provider 原生前缀缓存按实际输入复用。备用提供商在设置的备用线路中显式启用并保存顺序。

任务视图和运行轨迹入口提供任务状态、子任务、产物、工具执行记录、完整结果分页和模型输入。机器验收独立显示通过、部分通过、未通过或尚未验证；工具记录显示结构化错误码、已知副作用状态和重试声明，未知结果标明禁止自动重放。每次模型调用记录实际提供商、模型、消息、工具 schema、执行尝试标识、恢复断点和输入指纹。diagnostics.messageTokens、toolTokens 与 sources 为本地估算分项，不代表提供商计费用量；历史记录缺失时显示未记录。输入详情沿用任务认证与租户边界，完整内容不写入普通日志。

## 模型调用与费用

Provider Gateway 暴露统一 call 契约。内置主循环、历史摘要、视觉分析、MCP sampling 和 embedding 经过 kernel/model-call，继承任务取消与调用容量。连接检测、预热和无任务后台索引记入独立维护账本。任务的显式截止时间会主动取消在途请求及子任务，状态与用户主动取消分开记录。MCP stdio sampling 只绑定唯一在途工具任务；缺少归属或并发歧义时拒绝，不借用其他会话。

每个实际请求持久记录调用 ID、用途、逻辑轮次、提供商、请求模型、可用时的返回模型、用量确定性和价格来源。流中断、缺失或部分 usage 保持未知；未知价格不能作为确认零价。主子任务逐请求结算到同一根账本，恢复和重复回执不重复计账。未知执行中的模型请求不会通过重放来获取账单。

advisory 任务在额度超出、价格未知或用量不完整时继续执行，并在任务详情和聊天中提醒。用户可核对后确认，或在现有模型设置中修正具体计费配置。enforce 请求需要适配器可保证的输入计费上界、输出限制及已知价格；缺失条件返回 MODEL_BUDGET_UNCERTAIN。声明真实免费且适配器保证输出限制的调用可预留零费用。供应商账单不构成本地运行时可绝对保证的边界。

数据库 schema 7 在事务迁移中保留旧显式预算的 enforce 语义，并在导入边界标注无结构化来源的旧断点。新任务不通过文本前缀判断用户目标、约束或摘要。插件临时观察不提升为核心指令，也不写入原始用户对话。

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

创建任务可传入 message、provider、model、budgetUsd、budgetPolicy、deadlineAt 和 acceptance。budgetPolicy 默认为 advisory：费用额度只触发提醒，不停止任务；enforce 必须由用户明确选择，无法可靠预留时不发起新调用。截止时间与验收条件仅从显式配置读取。创建和补充消息支持 Idempotency-Key，同一键用于不同内容时返回冲突。

框架修改接口位于 /api/v2/framework/changes，提供创建、列举、review、validate 和 adopt。adopt 携带用户审阅的 digest。

## 数据迁移与回滚

升级前停止旧实例，确保没有活动调用。数据库迁移前，在数据库同目录生成带 pre-v2 标记的 SQLite 快照，并备份配置与插件清单。迁移失败拒绝启动；版本化迁移在事务内推进。新建空库直接创建当前 schema。

历史会话、模型配置、用户规则和产物保留。旧断点在聊天中可查看；用户核对先前操作后，以明确目标发起新任务，不自动重放旧工具。

插件必须声明 apiVersion: 2。旧插件被停用并显示契约迁移原因。迁移配置前保留原文件，不自动重写用户自定义规则。

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

eval:ci 使用确定性回放。eval:live 为文本回答与评分冒烟，报告 kind 为 text-smoke，不能替代运行时任务成功率、工具执行、恢复或成本对照。

eval:live 必须显式提供 EVAL_BASE_URL、EVAL_API_KEY、EVAL_MODEL、正数 EVAL_BUDGET_USD，以及 EVAL_INPUT_USD_PER_MILLION 和 EVAL_OUTPUT_USD_PER_MILLION。费用单位为 USD。评测不读取 NEWAPI 凭据作为备用。每次请求前预留费用；失败、响应不确定或 usage 缺失时保留保守预留，不自动重发。

发布对照评测要求固定 30 个真实任务，每任务 3 次，至少两档模型，对比旧基线、同模型同工具同权限的最小参考循环与 v2。三组使用一致材料、模型版本和预算；优先使用文件、命令结果和任务断言评分。成功率、确认次数、重复执行与中位费用分别报告。

`npm run eval:release` 执行 30 个固定任务的三组对照，每个模型共 270 个样本。任务覆盖可执行代码断言、带来源的材料核对、文档产物、持久断点恢复和工具故障。每个样本使用独立临时工作区，原始结果即时追加到报告目录的 samples.jsonl。baseline 从明确指定的归档运行时加载；reference 和 v2 使用同一持久任务服务。

执行前显式配置以下环境变量：

| 变量 | 内容 |
| --- | --- |
| EVAL_BASE_URL / EVAL_API_KEY | 测试网关地址与凭据；凭据仅通过进程环境传入 |
| EVAL_MODELS | 逗号分隔的测试模型标识 |
| EVAL_BASELINE_ROOT | 归档版本的 web-agent 绝对目录，依赖需可解析 |
| EVAL_FREE_CONFIRMED | 当前入口仅接受明确确认为免费的测试模型，值为 true |
| EVAL_REPORT_DIR | 新的报告目录，默认 evals/reports/release-v2；已有样本时拒绝覆盖 |
| EVAL_CONCURRENCY | 并发样本数，默认 2，上限 2 |
| EVAL_TOKEN_LIMIT | 全批次输入与输出 token 计账上限，默认 20000000；usage 缺失时保留请求预留 |
| EVAL_VARIANTS | 可选的组别子集，逗号分隔 baseline、reference、v2；子集运行本身不能满足完整矩阵门禁 |

每个样本最多 32 次网关请求、每次最多 2048 输出 tokens，任务执行时限 300 秒；正常阶段采用默认的 30 轮上限，恢复场景先执行 1 轮、持久化后允许继续 30 轮。运行器不发现其他凭据，不配置备用线路，失败请求不由评测器自动重放。manifest.json 保存任务与模型标识、运行时源码指纹及执行参数。样本按固定种子交错执行，开始记录与请求预算回执即时持久化；续跑只接受源码指纹一致且尚未开始的样本，已启动但结果未知的样本须先保留为无效记录。

`npm run eval:release:report -- <报告目录>` 从原始样本重新生成 report.json 和 REPORT.md。确定性检查通过证据由 validation-evidence.json 单独提供，每项包含 id、passed 和 evidence；缺少证据时该门禁不通过。报告校验样本完整性、版本身份、成功率差值、副作用重复、事件序列和费用来源。路由别名不能证明固定底层模型版本；免费账单不能据零分母计算 15% 费用增幅，调用和 token 开销单独展示。

`npx tsx scripts/release-rescore.ts <报告目录>` 对仍保有本地临时工作区的已完成批次统一复核产物断言。原始 samples.jsonl 保持不变；评分结果、产物内容与哈希、评分修订分别保存为 scored-samples.jsonl、artifact-evidence.jsonl、scoring-audit.json，报告读取 manifest 指定的评分文件。复核会执行代码产物断言，不发起模型请求或重放工具调用；已有评分审计时拒绝覆盖。

组合报告通过 sources.json 记录每个模型与组别使用的原始批次、样本数和指纹。同一模型与组别采用完整批次，不能按结果挑选样本。evaluated-sources.json 标识性能评测覆盖的源码；评测后修改运行时，需将 performanceRevisionCurrent 设为 false，先前矩阵不能批准当前版本发布。

v2 相对参考循环的成功率下降不得超过 5 个百分点，相对旧基线不得下降；中位费用增幅不得超过 15%。权限越界、副作用重复执行、事件丢失的确定性测试必须全部通过，并验证桌面、窄屏、无障碍和断线恢复。缺少真实对照报告或任一门禁未通过时，不构成 v2 发布验收通过。


## 任务插件

工作区设置中的“任务插件开发”默认关闭，与开发者权限独立。用户管理员可通过 PUT /api/v2/workspace/plugin-development 设置 enabled、permissions、dependencies 与当前权限 revision；版本冲突或存在活动任务时拒绝变更。外部依赖必须已在实例的 plugins.allowedDependencies 中批准。模型无法注册该授权接口为自己的工具。

create_plugin 接收 id 和 source，或 files 与完整 v2 manifest，产生 staged 候选；enable_plugin 验证并激活。工具权限不得超过授权；直接宿主文件、进程和网络访问声明被拒绝，业务操作通过统一工具代理调用。完整类型插件仍是可信 JavaScript，静态检查不是代码安全隔离。

plugin_status 返回版本、哈希、实际注册能力、文件索引和工作区可用插件；sdk=true 按需读取 SDK 接口，example 按九类能力或 composition 返回完整源码与 manifest，id、path、offset、limit 支持按范围读取源码。公共类型入口为 kernel/plugin-sdk。自动 manifest 推断按能力种类读取 name、id、mount 或 event；动态注册需要显式 manifest。类型错误返回阶段、错误码、文件、行列与消息。invoke_plugin 显式调用 command、role 或 provider；command 默认执行期限 30 秒，可通过 CommandDef.timeoutMs 声明，handler 第二参数接收 signal；role/provider 为 240 秒。角色通过统一子任务入口执行，取消与失败保留为失败结果；供应商经统一模型账本执行且不切换当前模型。persona 通过源码读取按需使用，context 作为临时参考材料参与后续模型输入。

GET /api/v2/runs/:id/plugins 返回插件清单和任务授权快照。POST /api/v2/runs/:id/plugins/:pluginId/save 由用户管理员提交确定 hash，将已验证版本保存到该租户、该工作区。staged 或 error 版本不能保存。GET /api/v2/runs/:id/plugins/:pluginId/api/:mount 仅能访问活动任务插件的相应 API；其他 HTTP 方法沿用相同认证与权限检查。诊断中的 panel 入口要求 api:panel 声明并净化 HTML。

run_plugins_v2 保存任务绑定与源码；workspace_plugins_v2 保存显式复用版本；plugin_development_v2 保存工作区授权。恢复要求源码及 manifest 哈希一致、依赖可解析、当前授权仍有效。子任务的 plugins 参数为明确继承的活动插件 id，运行服务一并复制它们的依赖闭包。任务结束释放运行资源，保存插件和恢复数据库都不撤销外部副作用。

npm run eval:composition 执行 12 个插件专项任务、3 次重复、2 条路由和 baseline/v2 对照，共 144 个样本。它与 eval:release 的 540 样本分开报告，并在运行时设置两批合计的 token 上限。免费路由不能验证非零成本增幅；路由别名不能证明底层模型版本固定。
