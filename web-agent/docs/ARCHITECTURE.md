# maharness 架构设计文档

> 版本：v2.2（2026-08-16）
> 定位：从 0 自研的 Windows 原生网页版 Agent。**只有内外之分**：内部是唯一保持不变的 Agent 核心（kernel/），其余一切能力为可插拔组件（外部）。
> 原则：不用任何现成 agent 框架（LangChain/CrewAI/AutoGen 等）；极简高效；运行全程可观测；高缓存命中；创新自研；**万物都是插件，agent 可以自己定义自己**。
> 方法：**第一性原理**——先研究透彻 LLM 与 agent 的底层机制，再从底层机制推导每个组件的设计（见 §1.1）。
> v2.0：借鉴北大/DeepSeek《A Programming Paradigm for Spatiotemporal Composability》（Cordis）的思路，落地**时空可组合性**——可逆效应（卸载=完全恢复）、反应性共效应（依赖声明与自动通知）、事务性热重载（坏版本自动回滚）。借鉴优点而非复现：无形式化演算、无 context 树/Proxy 中介，保持薄内核。
> v2.1：对照大厂 harness 经验补齐三个底层核心——**上下文压缩**（对标 Anthropic context compaction：LLM 摘要替代纯截断）、**嵌套 Trace span 树**（对标 OpenAI Agents SDK tracing：子任务跨 traceId 下钻）、**工具输出机器校验**（对标 structured output：outputSchema 运行时校验）。
> v2.2：自研落地四个大厂机制的 maharness 版（均按本环境约束裁剪——单会话单循环、页面关即停、薄内核）——**handoff 角色移交**（角色=插件）、**checkpoint 断点续跑**（turn 级自动保存）、**工具结果存储 + recall_tool_result 重读**（观察缓存）、**会话级成本实时熔断**（分级响应）。同期补齐**前端会话状态感知**（§8）：断点/角色/熔断横幅、span 树下钻、结果存储徽标、消息操作与输入效率、渲染性能。

---

## 1.1 第一性原理：从 LLM 底层逻辑推导架构

**LLM 的本质**：一个无状态的确定性函数 `F(tokens) → tokens`。每次调用都接收完整输入序列，没有任何跨调用状态。由此推导出两个核心事实：

1. **成本与输入长度成正比**：`成本 = 输入tokens × 输入价 + 输出tokens × 输出价`。降低成本的唯一途径是减少输入/输出 token 或提高缓存命中折扣。
2. **前缀可复用（KV Cache）**：prefill 阶段每个 token 的 Key/Value 向量可被缓存。若本次输入序列的前缀与上次一致，则该前缀部分无需重新计算——**这是"LLM 缓存"的第一性原理：缓存的是输入前缀，不是答案**。主流 provider（DeepSeek/OpenAI/Anthropic）对缓存命中的输入 token 提供大幅折扣（如 DeepSeek 命中价 ≈ 1/4 正常价）。

**Agent 的本质**：在无状态函数之上的循环 `决策(LLM) → 动作(工具) → 观测(回填) → 再决策`。由此推导出缓存与成本的三条设计主线：

| 主线 | 底层事实 | 设计推导 |
| --- | --- | --- |
| 重复性问题 | 用户高频重复提问，同一输入序列产出的答案稳定 | **L1 语义问答缓存**：相同/近似问题直接返回缓存答案，跳过整个 LLM 调用（成本 0） |
| 确定性工具 | 同一参数 + 同一输入状态 → 工具结果确定 | **L2 工具结果缓存**：`hash(工具+参数+输入状态指纹)`，重复调用不重算 |
| 轮间前缀 | Agent 多轮循环中，`system + 早期历史` 在轮间保持稳定 | **L3 前缀复用**：消息"只追加不重写"，使每轮输入共享前缀，吃满 provider KV cache 折扣 |

**第一性原理约束**：

- **答案依赖完整输入**：L1 缓存键除问题文本外，还包含 `systemPrompt 指纹（promptKey）`——人设/插件规则变化后 systemPrompt 不同，缓存空间隔离，绝不串用旧人设下的答案。
- **答案有保质期**：L1 条目 TTL 24h——时效性内容（天气/新闻/用户数据）不永久缓存，过期自动失效重算。
- **缓存值依赖工具版本**：L2 缓存键带工具版本命名空间（`tools-fs v2`）——工具输出格式/行为变更时旧缓存自动失效，防止返回旧逻辑结果。
- **前缀必须字节级稳定**：KV cache 对前缀的任何字节变化都会失效（包括空格/换行/消息顺序）。审计保证：消息加载 `ORDER BY created_at, rowid`（同毫秒消息顺序固定）；历史只追加不重写；记忆注入追加到末尾；system prompt 组装顺序固定（L0 → L1 人设 → L2 插件规则按 priority 降序）。
- **可观测驱动优化**：每层命中都累计 `savedCost`（L1 命中按估算 token × provider 价格报告节省成本），命中率/节省成本在统计面板实时可见——优化与否由数据决定，而非拍脑袋。

## 1.2 LLM 视角：Agent 需要的"全世界"（七项能力）

> "不要只给我工具，给我一个可以被我理解、操作、观察、验证、记忆和修正的全世界。"
> 压缩为 LLM 视角的 7 项能力，maharness 逐项实现如下：

| # | 能力 | LLM 需要什么 | maharness 实现 | 底层逻辑 |
| --- | --- | --- | --- | --- |
| 1 | context | 告诉我世界是什么状态 | **世界状态注入**：system 末尾固定块（工作区路径/会话模式/模型），会话内字节级稳定（不破坏 L3），工作区/模式变更时更新 | LLM 无感知能力——世界状态必须显式告知，否则靠猜 |
| 2 | tools | 让我改变世界 | 20+ 工具（文件/搜索/记忆/技能/计划/自扩展），JSONSchema 契约 + 全程 Trace | 工具 = LLM 改变世界的唯一途径 |
| 3 | observation | 告诉我改变后发生了什么 | 工具结果回填 tool 消息；**截断告知**（>4000 字符明确标注"已截断"） | 观测不完整 = 决策失真的根源，截断必须显式 |
| 4 | verification | 判断我的行动是否成功 | 工具返回 `{ok, data/error}` + L0 纪律引导"写操作调用后核对结果" | 成败必须机器可判，LLM 才能迭代 |
| 5 | memory | 让我不重复犯错 | 长期记忆（remember/recall/forget + before_llm 注入）+ **失败教训自动记忆**（agent.after_tool 钩子，工具失败自动记一条【自动】教训，1 小时去重） | 错误 → 教训 → 注入未来决策，"不重复犯错"是闭环 |
| 6 | sub-agents | 帮我分担压力并互相审查 | **run_subagent 工具**：复用 AgentRunner 开独立循环（独立 traceId/上下文），默认只读白名单，maxTurns=6，子代理自检后交付 | Agent 循环是可组合单元；独立上下文防污染；新视角交叉审查 |
| 7 | state/orchestrator | 让我持续行动 | goal-plan 插件（计划状态机：create_plan → 逐项 update_plan_progress → complete_goal）+ 会话持久化 + SSE 心跳 | 单次执行 vs 持续行动：状态必须外置可查可续 |

---

## 1.3 harness 视角：LLM 的运行时操作系统（11 问）

> "不要把我理解为给 LLM 提供工具的外壳，把我当作 LLM 的运行时操作系统——LLM 是我真正的用户。"

| # | 问题 | 本质结论 | maharness 落地 |
| --- | --- | --- | --- |
| 1 | **能力边界**：harness 替 LLM 决定什么？ | 内核只负责让 LLM 持续"感知-决策-行动-反馈"循环；一切具体能力（文件/记忆/搜索/计划/子代理）都是插件 | 内核 5 大件（bus/loader/config/trace/cache）不持有任何业务能力；对话本身是插件 |
| 2 | **能力发现**：LLM 怎么知道自己能干什么？ | 需要动态 capabilities registry：能力/用途/成本/风险/审批/限制，LLM 直接读取而非猜测 | ToolDef 结构化元数据（risk/costHint/approval/limits/**output**）→ 描述自动打【风险/成本/需审批】标签 + **输出格式说明**注入 LLM；`GET /api/capabilities` 注册表人类可查；实测 LLM 零调用准确列出 4 个高风险工具、准确复述 read_file 返回结构（含截断语义） |
| 3 | **能力组合**：插件间能否 1+1>2？ | 组合发生在 LLM 编排层：工具按能力语义描述，任意新插件注册即进入组合空间 | 工具描述互相引用 + 输出结构化（下游直接消费）；内置技能 `capability-composition`（组合范式：list_dir→read_file→总结、子代理审查→read_file 核验等）；plugin-authoring 契约含组合设计章节；实测新旧工具混合成链（read_file→count_words） |
| 4 | **上下文工程**：插件怎么喂信息？ | 插件不应无脑塞 context；声明式 context provider + harness 按任务动态组装（预算控制） | 新能力类型 `context`：`contentFn(history)` 按需返回内容，weight 排序注入，总预算 1500 tokens 超限丢弃，每次注入记 Trace（context-inject）；memory 插件实战落地：普通记忆按任务 bigram 相关检索（无关零注入），失败教训经 before_llm 钩子固定注入（不重复犯错优先） |
| 5 | **生命周期**：插件什么时候出现？ | 动态 capability loading（类似 OS 加载驱动）：按需激活、无关隔离 | manifest `enabled=false`/`lazy=true` 声明生效（注册可见但能力不进上下文）；`enable_plugin`/`disable_plugin` 工具（LLM 按需加载驱动，审批保护）；plugin_status 输出语义化 `active` 标记；watch 热加载/卸载同样遵守声明；实测 lazy 插件激活前后能力可见性切换 |
| 6 | **信任与权限**：插件是能力还是权力？ | 能力越大破坏越大：每个工具必须标注风险，harness 据此判断审批 | risk 元数据 + 声明式 approval；高风险工具（write_file/delete_file/powershell/create_plugin）描述标注【风险:high|需审批】；**审批全程入 Trace**（approval 步骤：挂起/批准/拒绝可审计——"权力"的使用必须可追溯） |
| 7 | **可观察性**：agent 为什么这样做？ | 过程不可黑箱：每次 LLM 调用/工具调用/缓存命中都入 Trace | trace 三态输出（SSE 实时 / JSONL 落盘 / 环形缓冲）+ 前端轨迹面板（**类型过滤**：LLM/工具/缓存/系统）+ `/api/trace` 过滤查询（type/name/limit）+ 统计面板 |
| 8 | **失败恢复**：harness 拯救 LLM | LLM 不应面对 error 500 胡乱思考：瞬态失败自动重试，能力级备选路径 | LLM 调用瞬态失败自动重试 1 次（1.2s 缓冲）；**provider failover**：主 provider 重试仍失败自动切换备用 provider（failover 入 Trace，LLM 无感）；工具失败返回 `{ok:false,error}` + 失败教训自动入记忆 |
| 9 | **经济性**：harness 让 LLM 知道行动有成本 | **认知资源由 harness 管理，不是 LLM 自觉**：重工具配额强制、成本预算强制注入 | costHint 元数据注入描述；**run_subagent 配额**（10 分钟内 ≤3 次，超限 harness 直接拒绝并说明）；**会话成本预算**（`budget.maxSessionCost`，超预算自动注入成本警告——不是请 LLM 节约，是 harness 告诉它边界）；L1 缓存省 LLM 调用；统计面板总成本/节省 |
| 10 | **自适应性**：harness 能否改变 agent 工作方式？ | 基于历史表现调整策略（adaptive harness → skill graph） | **任务画像**（内核 Budget）：每次任务记录 类型/轮数/成本/成败（classifyTask 关键词分类），统计面板展示"类型→次数/平均轮数/成本/失败率"——自适应策略的数据源；连续 3 次工具失败注入自适应提示；失败教训自动记忆形成"任务类型→教训"知识 |
| 11 | **可替换性**：实现可换、语义不变 | 插件接口抽象能力语义而非具体实现——LLM 是唯一不需要重新学习世界的部分 | 工具接口=能力语义（remember/recall 不关心存储实现，web_search 不关心搜索引擎）；**核心能力接口语义自检**（selftest：8 个核心工具名称+描述语义稳定，防改名破坏 LLM 认知）；L2 缓存键带版本命名空间；provider 可替换（failover 链） |

---

## 1.4 能力边界：内核掌握什么、绝不掌握什么

> 判据：内核只负责让 LLM **持续地感知-决策-行动-获得反馈**。凡是这个循环需要的基础设施，内核必须提供；凡是某个具体能力/策略/数据，内核绝不持有。这决定了系统会不会变臃肿。

### 内核掌握（6 大件，各司循环一环）

| 内核件 | 服务循环的哪个环节 | 为什么必须在内核 |
| --- | --- | --- |
| EventBus | 全部 | 钩子/事件是循环的神经系统：感知注入（before_llm）、行动拦截（before_tool）、反馈广播（after_tool）都走它；插件间解耦的唯一通道 |
| PluginLoader | 行动（能力发现） | LLM 能做什么由已加载插件决定；加载/热重载/启停/依赖检查是"能力生命周期"的掌控者 |
| Config | 感知（世界参数） | 沙箱边界、超时、预算等循环参数的分层配置（默认 → config.json → env → 运行时） |
| Trace | 反馈（记录） | 循环不可黑箱：每次 LLM 调用/工具调用/缓存命中都入轨迹；这是"获得反馈"的审计面 |
| Cache | 反馈（效率） | 重复劳动消解的基础设施：存储/命中统计/TTL。**匹配策略是可注入的**（embedding 向量注入即升级，默认自研 bigram 兜底）——内核提供机制，不焊死策略 |
| EffectScope | 行动（副作用回收） | 可逆效应引擎：插件的一切副作用留下逆元，卸载按 LIFO 完全恢复——动态组合的时序可组合性由运行时结构性保证 |

### 内核绝不掌握

| 绝不掌握 | 为什么 | 现在在哪 |
| --- | --- | --- |
| 任何具体工具/能力 | 能力=插件，现场写现场加载 | core/*、plugins/ |
| 对话循环实现 | 循环本身也是插件——**可替换**（换一个循环实现不影响内核） | core/chat（AgentRunner） |
| 业务策略（缓存匹配阈值/上下文截断/审批规则） | 策略属于能力层，内核只提供机制 | core/chat、core/memory、server/context |
| 数据模型（会话/消息/人设） | SQLite 是 server 层的事，内核不碰持久化 | server/db.ts |
| 前端/API 形态 | HTTP/SSE/UI 都是外壳 | server/、ui/ |

### 循环完备性（感知-决策-行动-反馈 → 内核接口）

| 环节 | 能力层做什么 | 内核提供 |
| --- | --- | --- |
| 感知 | 世界状态注入、记忆注入、历史组装 | Config（世界参数）、EventBus（before_llm 钩子） |
| 决策 | provider 调用、重试、缓存命中短路 | Cache（L1 问答缓存——重复问题不必重新决策） |
| 行动 | 工具执行、审批挂起、结果回填 | PluginLoader（能力发现）、Config（超时）、EventBus（before/after_tool 钩子） |
| 反馈 | 结果观测、失败教训、计划推进 | Trace（每步入轨）、EventBus（事件广播） |

### 隔离的机器验证

`selftest [boundary]`：扫描 kernel/*.ts 的 import，断言只允许 node 内置与 kernel 自身（`./`、`../kernel/`）——**内核一旦开始 import 能力层，即视为边界破坏**。当前 10 个内核文件零违规。能力层反向依赖内核（core/* → kernel/types）是单向合法的：能力可以被替换，内核不被能力绑架。

---

## 1.5 时空可组合性：可逆效应 + 反应性共效应 + 事务性热重载

> 借鉴：北大/DeepSeek《A Programming Paradigm for Spatiotemporal Composability》（Cordis 元框架）。
> 论文将动态组合拆成两个正交维度并给出行之有效的运行时机制：
> **时序可组合性**（组件移除时其副作用能否完全恢复）与**空间可组合性**（组件间依赖能否声明并反应式管理）。
> maharness 不照搬其形式化体系（无效果代数/无 context 树/无 Proxy 中介），只落地三个对
> 「agent 自我修改的 harness」生死攸关的机制——因为 self-extend 允许 agent 自己写插件，
> 一个坏的自我修改绝不能瘫痪掉"需要用来恢复的进程本身"。

### 1.5.1 可逆效应：卸载 = 完全恢复（时序可组合性）

**旧问题（v1，同 VSCode）**：插件的清理正确性依赖每个作者的勤勉——`ctx.register` 没有
unregister，reload 时 `caps=[]` 直接丢弃；`ctx.bus.on` 的监听器无人回收（文档曾明文要求
"插件保存 off 句柄在 onUnload 中调用"）。效果创建与销毁分离，完整清理难以验证。

**v2 机制**：`kernel/scope.ts` 的 `EffectScope`——插件通过 ctx 做的一切都在自己的作用域里
留下**逆元**，卸载时运行时按 **LIFO 顺序**自动执行全部逆元，环境完全恢复。这是结构性保证，
不是作者自觉：

| 论文概念 | maharness 落地 |
| --- | --- |
| effect context (γ, φ)、track(𝑓, 𝑔) | `scope.add(inverse)`：执行正向效果并登记逆元 |
| recover、twisted composition | `scope.dispose()`：按逆序执行全部逆元（后进先出） |
| self-disposal（armed 标志） | dispose 幂等：armed=false，在途操作不再追加逆元 |
| 子效果级联 | `scope.child()`：父作用域 dispose 连带回收子作用域 |

**插件侧契约**（`PluginContext`，全部自动入作用域）：

```ts
ctx.register(cap)              // 返回 unregister；未手动撤销时卸载自动回收
ctx.on(event, listener)        // 自动退订的事件订阅（替代 ctx.bus.on，杜绝监听器泄漏）
ctx.provide(key, value)        // 服务绑定（卸载自动撤回并通知依赖方）
ctx.watchConfig(key, cb)       // 声明式配置对账（自动退订）
ctx.effect(fn, makeInverse)    // 原始可逆效应
```

- 卸载（stop）顺序：**先标记停供**（依赖方先感知停用）→ LIFO 执行逆元 → 旧式 onStop/onUnload 钩子仍保留兜底。
- 重新启用（enable）= **重新部署**（onLoad 重跑重建全部能力，进入新作用域）——与论文
  disabled 字段语义一致：置位卸载 fiber、清除重载。
- 可观测：每次卸载记录 `plugin.reverted { effects: N }` 事件（回滚了几项副作用一目了然）。
- 实测（selftest `[compose]`）：插件注册工具+服务+监听+配置对账四项副作用，disable 后四项
  全部自动恢复（能力消失/服务撤回/监听退订/配置监听退订），enable 后全部重建。

### 1.5.2 反应性共效应：依赖声明 + 自动通知（空间可组合性）

**旧问题（v1）**：`requires` 只是加载期顺序检查；插件间依赖要么靠 `capabilities()` 现场
查找（不反应对方生死），要么靠手写事件监听（如 chat 监听 plugin.loaded/unloaded/reloaded
刷新人设——命令式、易漏、易泄漏）。

**v2 机制**：加载器内置**服务共效应注册表**——提供者 `ctx.provide(key, value)`（或注册
`kind:'service'` 能力自动成为 `service:<id>` 绑定），依赖方 `ctx.inject(key, onChange)` 订阅：

- **绑定只在提供者 ACTIVE 时可见**：started 才发布、卸载先撤回（依赖方收到 `undefined` 通知）。
- **反应性分类**（论文 Definition 26 的务实版）：提供者停用 → 依赖方自动降级（收到停用通知，
  不报错、不悬空）；提供者恢复 → 依赖方自动可用（无需重启）。
- **能力集订阅**：`ctx.onCapabilities(kind, cb)`——某类能力集合变化时通知（chat 用它替代
  3 个手写插件事件监听，persona 集变化自动重装系统提示词）。
- **配置对账**：`ctx.watchConfig(key, cb)` 按「变了哪个键」分派（最小干预），替代全量
  `config.changed` 手写过滤。
- 实测（selftest `[coeffect]`）：消费者注入 `service:coeffect-svc`，提供者 disable →
  消费者工具立即返回 provided=false；enable → 自动恢复 true。全程消费者零改动、零重启。
- 附带修复 v1 启动期 bug：L2 人设层在插件 start 前刷新导致启动后缺失——start 时按能力
  种类通知订阅者，保证「启动即生效」。

### 1.5.3 事务性热重载：坏版本自动回滚（HMR with rollback）

**旧问题（v1）**：reload = stop → 清 caps → 重新 register；新版本语法错误 → 插件进入
error 态彻底消失，旧版本不可回滚。对 self-extend 是致命风险：**agent 自己写的插件坏了，
会禁用掉恢复所需的进程本身**。

**v2 机制**（对应论文 Algorithm 10 的事务性语义）：

1. 回收旧实例全部效果（可逆恢复），但**旧模块保留在内存**；
2. 加载新版本（独立作用域，暂不入注册表）；
3. **成功 → 提交**（替换注册表）；**失败 → 回滚**（丢弃半成品，用旧模块重跑 onLoad 重建，
   系统永不进入"半加载"状态；`plugin.error {rollback:true}` 事件可观测）。

- 实测（selftest `[compose]`）：写入语法错误的版本 → reload → 旧工具仍在、回滚事件入轨；
  写入好版本 v2 → 正常替换（v2 生效、v1 回收）。
- **惯性转换**（论文 §4.3.3 inertial 的务实版）：每个插件持有在途转换句柄，同一插件的
  新目标（start/stop/reload）等待在途转换完成——快速文件变更不再产生重叠竞态。

### 1.5.4 系统边界：界内可回滚，界外只能补偿

论文 §6.1 的边界概念给"哪些副作用能撤销、哪些不能"划出原则：

| | 界内（可逆效应追踪） | 界外（发射，只能补偿） |
| --- | --- | --- |
| 位置 | 进程内独占可改：能力注册/事件订阅/服务绑定/配置写入 | 文件写入、网络请求、LLM 调用、子进程 |
| 恢复方式 | LIFO 逆元（结构性保证） | Trace 审计 + 审批 + 失败教训记忆（补偿） |
| 为什么 | 系统独占修改，可恢复 | 其他方可能读写，无法独占恢复 |

插件卸载**不**撤销它写过的文件——写文件是跨出边界的发射，由审计与审批负责。这条分界让
「可逆效应」的承诺诚实：它保证的是组合层的完全恢复，不是任务层的时光倒流。

---

## 1.6 大厂机制自研落地：handoff / checkpoint / 结果存储 / 成本熔断（v2.2）

> 四个机制各有大厂原型（OpenAI Agents SDK handoff、LangGraph checkpoint、长上下文
> 工具结果管理、成本护栏），但 maharness 版均按本环境的硬约束裁剪：
> **单会话单循环、页面关即停、薄内核、全插件化、可观测优先**。每个设计都回答
> "为什么这是 maharness 环境下的最优解"。

### 1.6.1 handoff 角色移交（角色 = 插件）

**大厂原型**：OpenAI Agents SDK 的 handoff——agent 把对话控制权连同上下文移交给另一个 agent。
**maharness 裁剪**：不引入多 agent 注册表与上下文传递协议——本环境没有多 agent 并存，
只有"一个会话一个循环"。因此 handoff 落地为**角色切换**：
- **角色 = 插件**（`kind:'role'` 能力）：任意插件注册 `RoleDef { id, name, description,
  systemPrompt, tools }`——提示词 + 工具集的专业化分工（chat 内置 main 主代理；
  goal-plan 注册 planner 计划专家，跨插件协作演示）。
- `handoff_to(role, objective)` 工具：枚举角色注册表（非法角色报错并列出可用角色）；
  返回 `ToolResult.handoff` → **执行器识别后立即终止本轮循环**（不浪费后续轮次），
  yield `handoff` 事件 → server 更新 `sessions.role` → 后续对话由新角色的提示词
  （置于最前，引导力最强）与工具集（支持 readonly 只读白名单）接管，热切换无需重启。
- 角色与模式正交：plan/goal 模式提示词照常注入；`/normal` 命令清空角色回主代理。
- 为什么是最优解：复用现有"模式 = 提示词 + 工具集"架构，不新增并发执行模型；
  角色注册表走既有能力注册表（可观测、可热加载、可审计）。

### 1.6.2 checkpoint 断点续跑（turn 级自动保存）

**大厂原型**：LangGraph checkpoint——图执行的每一步状态持久化，中断后可精确恢复。
**maharness 裁剪**：单循环模型下"断点 = 完整轮次"，不需要图状态序列化：
- `AgentRunner` 每轮工具执行完（下轮 LLM 调用前）回调 `onCheckpoint(turn, history)`——
  此时 history 含全部工具回填（assistant+tool 配对完整），**字节级可恢复**（L3 前缀缓存
  恢复后依然命中）。
- server 持久化到 `agent_checkpoints` 表（每会话仅最新一条，upsert）：
  任务正常完成（assistant_done）自动清除断点；中断（页面关闭/错误/熔断）保留。
- 恢复：`POST /api/sessions/:id/chat { resume: true }`——从断点历史继续，
  末尾注入「【任务恢复】继续完成未竟的目标」提示，复用完整对话流程
  （provider 选择/上下文压缩/成本熔断/SSE），不落库新用户消息。
- 为什么是最优解：不引入图状态机——本环境的"中断"只发生在轮次边界（SSE 断开即
  abort），轮级快照就是精确恢复点；每会话一条最新断点足够（恢复点是"最近完成的轮"）。

### 1.6.3 工具结果存储 + recall_tool_result 重读（观察缓存）

**大厂原型**：长工具输出管理——结果摘要化进上下文，完整内容按需重读。
**maharness 裁剪**：v1 的 4000 字符截断告知有个缺口——**截断后 LLM 只能重算工具拿全文**
（可能重复花钱/副作用）。v2 补上"重读已观察的原文"：
- `core/chat/result-store.ts`：进程内会话隔离存储（LRU 每会话 50 条）。
  回填策略三级：≤2000 字符全文回填；>2000 存入结果存储，history 只留
  `【工具结果已存入结果存储（id=xxx）】` + 摘要；>4000 才截断告知（兜底）。
- `recall_tool_result(id)` 工具：按 tool_call_id 零副作用重读全文（不重算、不重查）。
- 与 L2 缓存的分工：L2 = "同参数同状态的重算不花钱"；结果存储 = "本会话已观察过的
  事实不占上下文、可重读"。
- 为什么是最优解：进程内存储符合"页面关即停"的会话模型（无需跨进程持久化）；
  复用 ToolContext.sessionId 天然会话隔离；LRU 防膨胀。

### 1.6.4 会话级成本实时熔断（分级响应）

**大厂原型**：成本护栏/预算熔断。
**maharness 裁剪**：预算哲学已有（§1.1 经济性：harness 管理认知资源），v2.2 从
"注入警告（软边界）"升级为"分级响应"：
- **85% 预警**：执行器内注入「成本预警」system 提示（限一次），要求收敛；
- **100% 熔断**：执行器每轮 LLM 调用前核算累计成本，`≥ costBudget` 即硬停止——
  不再发起新 LLM 调用（唯一能阻止调用的地方就是执行器），已完成结果保留，
  yield `budget_hit` 事件（SSE 推送）+ `cost-breaker` 步骤入 Trace。
- server 传**剩余预算**（`maxSessionCost - 会话历史累计`）——会话级实时核算。
- 为什么是最优解：熔断点放执行器（不是 server 层计数）——只有执行器能保证
  "不再发起新调用"；分级响应避免一刀切（简单任务在预算内自然完成）。

---

## 1. 设计信条

| # | 信条 | 含义 |
| --- | --- | --- |
| 1 | 内核极薄 | 内核只做 6 件事：事件总线、插件加载、配置、轨迹观测、缓存、可逆效应。**连"对话"都是插件** |
| 2 | 一切可插拔 | 能力层全部为插件：现场写、现场加载、现场启停，不重启内核；卸载即完全恢复（可逆效应） |
| 3 | 全部自研 | Agent 循环、工具协议、插件机制、缓存、观测全部手写，无 agent 框架依赖 |
| 4 | 运行即轨迹 | 每次运行产生结构化 Trace，前端实时可见 + JSONL 审计，无黑箱 |
| 5 | 缓存是一等公民 | 三层缓存 + 命中率/成本实时可见，重复劳动自动消解 |
| 6 | Windows-first | 路径、编码、监听、Shell 能力按 Windows 原生体验设计，不向"跨平台"妥协 |

---

## 2. 总体架构

```
┌────────────────────────────────────────────────────┐
│ 表现层（可插拔）                                     │
│   Web UI（React）  ·  CLI（预留）  ·  托盘（预留）    │
├────────────────────────────────────────────────────┤
│ 能力层（全部插件，plugins/ 目录现场开发）             │
│   chat(对话) · tools-fs(文件) · search(搜索) ·       │
│   goal-plan(目标计划) · todo(待办看板/to do list) ·  │
│   parallel(多会话并行) · powershell(Shell) ·         │
│   self-extend(自我扩展：agent 自建插件) · memory ...  │
├────────────────────────────────────────────────────┤
│ 内核 Kernel（运行必备，仅 6 大件）                   │
│   EventBus  事件总线（一切通信走总线）                │
│   PluginLoader  插件加载与热管理（事务性重载/共效应）  │
│   Config  分层配置（defaults→文件→env→运行时）       │
│   Trace  轨迹观测（事件采集/环形缓冲/审计落盘）       │
│   Cache  三层缓存（语义/工具结果/prompt前缀）         │
│   EffectScope  可逆效应引擎（副作用逆元 LIFO 回收）   │
├────────────────────────────────────────────────────┤
│ Windows 底座                                        │
│   Node 运行时 · 文件系统(编码/路径适配) · 进程 · SSE  │
└────────────────────────────────────────────────────┘
```

**通信规则**：内核组件之间、插件与内核之间、插件与插件之间，一律通过 EventBus 收发事件。禁止直接 import 对方实现（PluginContext 提供的注册句柄除外）。这是"现场写插件不破坏既有系统"的结构性保证。

---

## 3. 内核设计（Kernel，仅 5 大件）

### 3.1 EventBus（事件总线）

- 全局唯一实例，发布/订阅模型，**事件是内核与插件之间的唯一契约**。
- 事件命名：`域.对象.动作`，如 `plugin.loaded`、`agent.turn.started`、`tool.executed`、`cache.hit`、`chat.message.delta`。
- 每个事件携带 `traceId`，自动关联到当前执行轨迹。
- 支持通配符订阅（`agent.*`）与优先级（数字越大越先执行）。
- 发布分两种：
  - `emitSync`：同步派发，监听器抛错被捕获并记录（不影响发布者）；
  - `emitAsync`：等待所有监听器 Promise 完成后返回，用于生命周期等关键路径。
- 防失控：单事件同步监听深度上限 64；单监听器执行时长超阈值记入 Trace 告警。

### 3.2 PluginLoader（插件加载与热管理，v2：时空可组合性）

**插件形态**：`plugins/<name>/` 目录 = 一个插件，含：
- `plugin.json`：清单（见 3.2.1）
- 入口文件（默认 `index.ts`，经 tsx 动态加载）

**状态机**：`registered → loaded → started ⇄ stopped → error`（转换期间标记 loading/unloading）
- `loaded`：清单解析、依赖检查、动态 import 入口、调用 `onLoad` 注册能力
- `started`：调用 `onStart`，开始对外服务；**此时才发布服务绑定**（绑定只在提供者 ACTIVE 时对依赖方可见）
- 热管理命令：`enable / disable / reload`，均不重启内核；**惯性转换**：同一插件在途转换完成前不响应新目标
- 文件监听：插件目录变化（新增/修改/删除）触发 `reload`，实现"现场写、现场加载"

**可逆效应（v2）**：每个插件持有 `EffectScope`——`ctx.register` / `ctx.on` / `ctx.provide` /
`ctx.watchConfig` 全部自动入作用域。`disable`（卸载）按 LIFO 完全恢复全部副作用；
`enable`（重新部署）= onLoad 重跑重建能力。清理正确性由运行时保证，不再依赖作者在
onUnload 里手工回收。

**事务性热重载（v2）**：reload = 回收旧效果（旧模块保留在内存）→ 加载新版本 → 成功提交 /
失败用旧模块重建回滚。坏版本（语法错误/onLoad 抛错）自动回滚到上一个可用版本，
`plugin.error {rollback:true}` 事件可观测——系统永不进入半加载状态。

**反应性共效应（v2）**：加载器内置服务注册表——`ctx.provide(key, value)` 发布绑定
（或注册 `kind:'service'` 能力自动成为 `service:<id>` 绑定）；`ctx.inject(key, onChange)`
解析并订阅（提供者停用收到 undefined / 恢复收到新值）；`ctx.onCapabilities(kind, cb)`
订阅能力集变化。依赖方无需重启即可感知提供者生死。

**能力注册表 CapabilityRegistry**：插件通过 `onLoad(ctx)` 的 `ctx.register` 注册能力：
- `tool`：工具函数（给 Agent 调用）
- `listener`：事件监听
- `command`：斜杠命令（如 `/help`）
- `provider`：LLM 提供者（v1 内置 OpenAI 兼容 provider，预留）
- `ui`：前端模块（v1 预留，前端按插件 id 拉取模块）

#### 3.2.1 插件清单示例

```json
{
  "id": "tools-fs",
  "name": "文件工具",
  "version": "0.1.0",
  "entry": "index.ts",
  "enabled": true,
  "requires": ["kernel-core"]
}
```

### 3.3 Config（分层配置）

- 四层合并（上层覆盖下层）：内核 defaults → `config.json`（用户） → `.env`（密钥） → 运行时修改。
- 插件配置独立命名空间：`config.<pluginId>.*`。
- 配置变更发布 `config.changed` 事件，支持热更新。
- 密钥（API Key）只进 `.env`，不进代码与配置库。

### 3.4 Trace（轨迹观测）—— 黑箱解药

**数据模型**（append-only，只增不改；v2 支持 span 树——嵌套观测）：

```
TraceSession(traceId)
 └─ Turn(第 N 轮)
     ├─ Step: llm_call   （模型、prompt 摘要、tokens、成本、耗时）
     ├─ Step: tool_call  （工具、参数摘要、结果摘要、耗时、缓存标记）
     └─ Step: cache_hit  （缓存层、键、节省成本）
每个 Step 可带 parentId → 父步骤 → 子步骤层级（span 树）
```

**span 树（v2，对标 OpenAI Agents SDK tracing）**：每个步骤可挂 `parentId`——子任务
（子代理/并行）的全部步骤挂到调用方工具步骤下，**跨 traceId 下钻**：从 run_subagent
工具步骤 → 子代理内部 llm_call/tool_call 全链路可见。`ToolContext.stepId` 把父步骤 id
传给工具，`RunOptions.parentStepId` 让子循环挂靠；`/api/trace` 支持 parentId 过滤查询。
单层追踪回答「做了什么」，span 树回答「为什么做这个」——多级委派不再黑箱。

**每步记录字段**：类型 / 开始时间 / 耗时 / 输入摘要（截断）/ 输出摘要（截断）/ tokens(in,out) / 成本估算 / 缓存键 / 状态 / parentId。

**三态输出**：
1. 实时推送：SSE 推送到前端 Trace 面板（DevTools 风格流水，含耗时与成本条）
2. 审计落盘：`data/traces/YYYY-MM-DD.jsonl` 全量结构化日志
3. 内存环形缓冲：最近 1000 条，供调试接口查询

**成本模型**：每个 provider 声明 `inputPrice / outputPrice`（每百万 token 单价），Trace 自动算成本。缓存命中时按"若未命中将发生的成本"计入节省。

### 3.5 Cache（三层缓存）

| 层 | 名称 | 键 | 命中条件 | 失效策略 |
| --- | --- | --- | --- | --- |
| L1 | 语义问答缓存 | 规范化问题文本（默认字符 bigram Dice；配置 embedding 后升级向量余弦）+ promptKey 指纹 + scope 作用域 | 相同/近似问题 Dice ≥ 0.58（或向量 ≥ 0.95）命中直接返回缓存答案 | 手动清空；LLM 版本升级时清空；短问题（<8 字符）不参与；TTL 24h |
| L2 | 工具结果缓存 | `hash(工具名 + 规范化参数)`；文件类追加 `mtime+size` | 键相同且未失效 | 文件 mtime/size 变化；TTL（30 分钟）；显式失效；超容量 LRU 淘汰 |
| L3 | prompt 前缀缓存 | 无显式键——**靠消息组装策略** | 依赖 provider 原生 KV cache（逐 token 精确前缀匹配） | 由 provider 管理（TTL 5min~数小时不等）；真实命中按 usage 统计 |

**L3 设计要点（高命中关键）**：保持 system prompt 字节级稳定；历史消息按"只追加不重写"策略组装（同一会话内，旧消息序列不变）；多轮工具结果不回写历史；动态注入（记忆/时间/预算提示）一律追加到末尾。这样 provider 侧 KV cache 前缀复用最大化，DeepSeek/OpenAI/Anthropic 的 context caching 均吃满。

**真实命中原则（v2）**：provider 前缀缓存是逐 token 精确匹配，真实命中数只能从 usage 读取——DeepSeek `prompt_cache_hit_tokens`、OpenAI/智谱 `prompt_tokens_details.cached_tokens`、Anthropic `cache_read_input_tokens`，`core/chat/provider.ts` 统一归一化为 `cachedInput/missInput`。L3 双口径：估算（`sharedPrefixTokens` 相邻轮公共前缀，无反馈时降级）+ 真实（provider 确认命中 token，唯一权威）。真实命中率 = 真实命中/(真实命中+真实未命中)，骤降即前缀被改动的信号（TTL 过期/路由抖动/换模型）。L3 命中按 provider input 价格计入 savedCost。

**缓存统计**：命中次数、节省 token、节省成本、命中率，全部进入 Trace 并在面板展示。缓存"是什么、为什么命中"永远可查。
- L1 可观测：Agent 循环在首轮问答（最后一条真实 user 消息，≥8 字符，排除记忆注入）查询语义缓存，命中直接 yield 缓存答案（`cached: true`，前端显示 ⚡缓存命中，成本 0）；无工具调用的最终轮按最后 user 消息回填（探索型任务 maxTurns=12 保证能走到最终总结轮，回填可靠）。回填/查询带 scope：纯问答答案全局共享，依赖工具观察的答案仅本会话可命中（防跨会话串陈旧观察）。
- L3 可观测：Agent 循环在每次 LLM 调用前对比与上一轮消息的公共前缀，估算复用 token 计入 `cache.l3`（`kernel/tokens.ts` 的 `sharedPrefixTokens`）；调用后按 usage 归一化的 `cachedInput` 记录真实命中（`cache.l3Real*`），trace 步骤带 `tokensCached`。

**统计面板（`GET /api/stats`）**：聚合全局概览（会话/消息/tokens/成本/截断次数，SQLite 累计）、本次运行明细（Trace 进程级）、每会话上下文用量（`estimateTokens` 估算 + 与 `context.maxTokens` 预算对比 + 截断标记）、三层缓存命中率（L1/L2 命中率、L3 双口径：估算复用 token + 真实命中 token/rate）。前端侧边栏「统计」Tab 每 5 秒轮询刷新。

---

## 4. Agent 执行器（自研，内核之外的第一插件）

归属：`core/chat` 插件（证明"对话也是插件"）。

### 4.1 循环模型

```
用户消息 → [决策] LLM(流式, 带工具定义)
            ├─ 输出流 → 前端（SSE delta）
            ├─ 无 tool_calls → 结束，汇总
            └─ 有 tool_calls → [动作] 逐个执行工具（含沙箱校验、超时）
                              → [观测] 结果回填 tool 消息 → 进入下一轮
终止条件：无 tool_calls / 轮数≥maxTurns(默认8) / token预算耗尽 / 用户中断(stop)
```

每一轮、每一步都向 Trace 发事件；前端可随时中断。

### 4.2 工具契约

```ts
interface ToolDef {
  name: string;              // 如 read_file
  description: string;       // 给 LLM 看的能力说明
  parameters: JSONSchema;    // 参数约束
  outputSchema?: JSONSchema; // 输出结构机器校验（可选，JSONSchema 子集，见 §4.2.1）
  handler(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}
```

- 工具由任意插件通过 `ctx.register('tool', toolDef)` 注册，Agent 执行器只认注册表，不认识具体工具 —— **新工具=现场写插件**。
- 工具执行统一包裹：超时（默认 30s）、错误捕获（错误文本返回给 LLM 而非中断会话）、Trace 记录、L2 缓存查询/写入。

#### 4.2.1 输出校验（outputSchema，对标 structured output）

- 声明了 `outputSchema` 的工具，执行器对 `result.data` 做运行时结构校验（`kernel/validate.ts`，
  轻量 JSONSchema 子集：type / object.properties / required / array.items / string.enum /
  min·max——刻意零依赖，超出子集的声明不校验该规则，渐进增强）。
- **校验失败不阻断**：原始结果照常回填，但回填内容附「【输出校验】返回与声明格式不符: …」
  标注（LLM 可拿原始结果自我修正），且 `output-validate` 步骤入 Trace（结构错误可追溯）。
- 语义：`output` 字段是「告诉 LLM 长什么样」，`outputSchema` 是「harness 机器可判」——
  verification 能力从 `{ok, data/error}` 返回值延伸到输出结构。

### 4.3 钩子管线（agent.* 六钩子，零内核改动）

执行器在每个关键节点通过事件总线发布 `agent.*` 事件（`emitAsync` 按优先级有序等待监听器），**监听器通过改写事件负载影响流程**——事件总线即钩子管线：

| 钩子 | 时机 | 负载可改写 |
| --- | --- | --- |
| `agent.input.received` | 用户输入进入循环 | history / tools / `blocked`（拦截） |
| `agent.before_llm` | 每轮调用 LLM 前 | history（注入上下文/记忆）、tools |
| `agent.after_llm` | 模型输出后 | 观测（content/reasoning/toolCalls） |
| `agent.before_tool` | 工具执行前 | tool.args（改写参数）、`blocked`（拦截） |
| `agent.after_tool` | 工具执行后 | result（改写结果） |
| `agent.on_error` | 异常/超轮数 | 观测（error） |

- 负载为 `AgentHookCtx`：`{ traceId, turn, model, history, systemPrompt, tools, scratchpad, ... }`，`scratchpad` 跨轮共享（钩子自管理防重复注入等）。
- **L3 缓存友好**：memory 插件注入记忆时追加到 history 末尾（不动 system prompt 与历史前缀），provider KV cache 前缀命中不受影响。
- 首个实战消费者：`memory` 插件（before_llm 注入长期记忆，跨会话生效）。

### 4.4 上下文管理（v2：压缩优先于截断）

- 会话历史按预算（默认 30000 tokens，config `context.maxTokens`）估算（中文 ≈1 token/字，英文 4 字符/token）。
- **v2 三级降级**（对标 Anthropic context compaction——截断是物理删除，压缩是信息保鲜）：
  1. 预算内 → 不动；
  2. 超预算 → **LLM 摘要压缩**（`core/chat/compact.ts`）：最早的完整对话轮被总结成
     「【历史摘要】」system 消息（≤300 字，只保留需求/结论/约束），替换原消息——
     LLM 不丢事实；压缩调用一次 LLM（30s 超时），失败自动降级；压缩事件入 Trace
     （「上下文压缩」步骤：压缩 N 条 / 旧 token → 新 token / 节省量）；
  3. 压缩不可用 / 已存在摘要 → **截断兜底**：保留 system 与最新消息，丢弃较早消息并注入
     「【上下文管理】已截断 N 条」说明（LLM 对截断有感知）。
- **防重复压缩**：历史已带【历史摘要】标记 → 不再 LLM 总结（已压缩段不可再压），
  只对摘要之后的最近轮截断——避免「每轮重复花钱总结」与「丢最近信息」两个陷阱。
- L3 前缀缓存影响：压缩 = 一次性重写历史前缀（失效一次），之后新消息继续追加、前缀
  重新稳定——与工作区切换同级的一次性代价。
- 位置：`core/chat/compact.ts`（压缩编排）+ `server/context.ts`（截断纯函数，兼容保留），
  在会话历史组装后、进入 Agent 循环前执行；`context.compact` 配置可关（默认开）。

### 4.5 斜杠命令（不消耗 LLM）

- `POST /api/commands`：内置命令（help/new/clear/plan/goal/normal/model）+ 插件 `command` 能力分发（任何插件可注册命令）。
- 前端输入 `/` 开头消息时直接调命令接口，动作类命令（新建/清空/切模式/切模型）即时生效，消息类命令以系统消息呈现。

### 4.6 会话模式切换（normal / plan / goal）

- `sessions.mode` + `sessions.plan_pending`（DB 持久化，UI 头部选择器或 `/plan` 等命令切换）。
- 模式提示词注入 system prompt；**plan 模式状态机**（强制层，非仅提示词）：
  - `1 待出计划`：不注入工具定义（LLM 无法调用工具，只能输出计划）→ 出计划轮后置 `2`；
  - `2 已出计划待确认`：放行工具，用户下一条消息视为确认 → 执行后置 `0`（无限制）。
- goal 模式：注入目标计划纪律（多步任务自动 create_plan）。

### 4.7 沙箱与安全（Windows 重点）

- 文件类工具锚定根目录 = 当前工作区（默认 `D:\DEEPSEEK`，config 可调整），所有路径先规范化（盘符/大小写/`..`）再校验必须在根目录内，防目录穿越。
- **工作区热切换**：网页端「文件」Tab 可添加/切换工作区——`config.sandboxRoot` 运行时热更新，文件工具沙箱边界、文件 API 与 Agent 工具下一轮立即跟随，无需重启。
- 写入工具拒绝符号链接指向沙箱外；只读操作默认允许，写操作逐项审计入 Trace。
- 工具参数只接受 JSONSchema 声明字段（防注入）。

### 4.8 技能系统（skills：自我设计的知识底座）

- 技能 = 一个 `SKILL.md` 指南包（frontmatter 含 name/description + 正文），**按需读取、不自动注入提示词**（避免提示词膨胀），Agent 用 `list_skills` / `get_skill` 精准取用。
- 内置技能随产品分发（`core/skills/builtin/`，当前 4 个：`agent-self-design` / `plugin-authoring` / `skill-authoring` / `thinking-chain`）；用户技能装到 `data/skills/`（gitignore，运行时安装）。
- 市场技能包放入 `market/` 目录即进入网页端「设置 → 技能」市场，一键安装/卸载，**安装后热重载立即生效**；web 端可查看任意技能全文。
- 技能插件（`core/skills`）通过 persona 引导 Agent 何时读取技能，形成"自我设计"闭环：需要改自己 → `get_skill("agent-self-design")` → 按其指引写插件/技能。

### 4.9 系统提示词分层（L0 / L1 / L2）

| 层 | 来源 | 内容 | 变更方式 |
| --- | --- | --- | --- |
| L0 内核纪律 | `core/chat` BASE_PROMPT | 思考-行动-观察工作链、效率与成本、安全纪律 | 代码级，不可热改 |
| L1 用户人设 | DB `personas` 表 | 身份/语气/能力边界（默认人设，可编辑） | 网页端「设置 → 人设」，热生效 |
| L2 插件规则 | 任意插件 `ctx.register({kind:'persona'})` | 插件自述与使用规则 | 随插件加载/卸载自动增减，priority 降序叠加 |

组装：`L0 → L1（按序）→ L2（priority 降序）`，由 `chat` 插件 `refreshPrompt()` 维护，插件热事件（loaded/unloaded/reloaded）触发自动重装。设计原则：**宁短勿长**——超长稀释注意力、破坏前缀缓存命中；规则可执行、可检查。

---

## 5. Windows-first 适配清单

| 项 | 方案 |
| --- | --- |
| 路径 | `path.win32` 统一处理盘符/反斜杠/UNC；大小写不敏感比较；`..` 规范化 |
| 编码 | 文本读取自动识别 UTF-8 / UTF-16LE(BOM) / GBK（Windows 常见），写入默认 UTF-8 |
| 文件监听 | 适配 `fs.watch` 在 Windows 的目录监听行为差异（用重命名事件判断） |
| 进程/Signal | 优雅退出处理；后台运行预留 |
| Shell 能力 | 预留 powershell 插件（v1 不内置，现场写） |
| 中文 | 全程 UTF-8 输出，控制台 chcp 兼容说明 |

---

## 6. 数据模型（SQLite，better-sqlite3）

```sql
sessions(id TEXT PK, title TEXT, model TEXT, created_at INT, updated_at INT)
messages(id TEXT PK, session_id TEXT, role TEXT,          -- user/assistant/tool/system
         content TEXT, tool_calls TEXT, tool_call_id TEXT,
         tokens_in INT, tokens_out INT, cost REAL, trace_id TEXT, created_at INT)
plugin_state(plugin_id TEXT PK, enabled INT, version TEXT, loaded_at INT)
cache_entries(key TEXT PK, layer TEXT, value TEXT, hits INT,
              created_at INT, updated_at INT)
```

---

## 7. HTTP API（v1 最小闭环）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/models` | 可用模型列表（由 .env provider 配置生成） |
| GET/POST | `/api/sessions` | 会话列表 / 新建 |
| GET | `/api/sessions/:id/messages` | 会话消息历史 |
| POST | `/api/sessions/:id/chat` | SSE 流式对话；`body.resume=true` 时从断点历史继续（断点续跑） |
| GET | `/api/files?path=` | 沙箱内目录浏览 |
| GET | `/api/files/read?path=` | 读文件（自动编码识别） |
| POST | `/api/files/write` | 写文件（沙箱校验） |
| GET | `/api/files/tree?path=` | 文件树（单层懒加载，前端展开；忽略 node_modules/.git 等噪音） |
| GET/POST/DELETE | `/api/workspaces` | 工作区列表 / 添加 / 移除（DB 持久化） |
| POST | `/api/workspaces/switch` | 切换当前工作区（sandboxRoot 热生效） |
| GET | `/api/skills` | 技能列表（已安装 = 内置 + 用户；市场可安装） |
| POST | `/api/skills/install` | 从市场安装技能（复制到 data/skills + 热重载，失败回滚） |
| POST | `/api/skills/:name/uninstall` | 卸载用户技能（热重载） |
| GET | `/api/skills/:source/:name/read` | 读取技能全文（SKILL.md） |
| GET | `/api/plugins` | 插件列表与状态 |
| POST | `/api/plugins/:id/actions` | `enable/disable/reload` |
| GET | `/api/trace?session_id=` | 查询轨迹（环形缓冲/落盘） |
| GET | `/api/trace/stats` | 进程级 Trace/Cache 计数 |
| GET | `/api/stats` | 统计面板：全局概览 + 上下文用量 + 三层缓存命中率 |
| GET | `/api/events` | 全局事件 SSE（前端实时面板；**同时是页面存活信号**——连接断开即视为前端关闭） |
| GET | `/api/sessions/:id/checkpoint` | 断点状态查询（{exists, turn, historyMessages}——前端可据此显示「继续任务」入口） |

**页面感知自动停止**：前端与后端的唯一常驻连接是 `/api/events` SSE。`server/client-tracker.ts` 登记/注销这些连接；所有连接断开（用户彻底关闭页面）超过 `AUTO_STOP_IDLE_MS`（默认 30 秒，设 0 关闭，可经 `.env` 热更新）后，后端优雅退出（`server.close()` + `kernel.stop()` 缓存落盘 + `process.exit(0)`）。刷新页面/网络抖动由 EventSource 自动重连豁免（宽限期）；多标签页任一存活即不停止；纯 API 调用（从未打开页面）永不触发。不用 HTTP 轮询做信号——浏览器对后台标签页的 setInterval 节流会使轮询失真，而 SSE 连接不受 JS 节流影响。

**chat SSE 事件流**：`turn.started` → `message.delta`(文本增量) → `tool.started` → `tool.delta`(工具输出增量) → `tool.done` → `message.done` → `turn.done` → `done`（含汇总：tokens/成本/缓存命中）。任意时刻 `stop` 可中断。v2.2 新增事件：`handoff`（角色移交：{role, objective}——会话控制权已交给新角色）、`budget_hit`（成本熔断：{cost, budget}——harness 硬边界触发）。

---

## 8. 前端（Web UI 插件，v2.2 会话状态感知）

- Vite + React + TypeScript，ChatGPT 式布局：左侧会话列表 + 插件面板 Tab，中部对话区，右侧可折叠 Trace 流水面板。
- 组件：`ChatView`（流式渲染、工具调用卡片、中断按钮）、`SessionList`、`ModelPicker`、`PluginPanel`（插件启停/重载/状态）、`TracePanel`（实时流水+成本）、`FileExplorer`（沙箱文件浏览，v1 轻量版）。
- 插件面板即"现场管理启停"的入口：列表显示所有插件、状态、版本，一键 enable/disable/reload。

**v2.2 会话状态感知（agent harness 前端特征）**——调查结论：agent 前端的第一性原理是
「让决策-行动-观察循环**实时可见、可中断、可追溯、可恢复**」，据此定制化补齐：

| 能力 | 实现 | 对标 |
| --- | --- | --- |
| 断点续跑 UI | 「继续任务」横幅（⏸ 中断于第 N 轮）——Esc 停止/错误后自动查询 checkpoint 状态，点击即从断点恢复（复用 streamChat resume 流） | Claude --resume |
| 角色接管横幅 | 「会话由 X 角色接管」+ 一键交回主代理（handoff 后可见） | OpenAI handoff 可视化 |
| 成本熔断横幅 | budget_hit 事件 → 红色横幅（成本/预算/已熔断） | 成本护栏可视化 |
| span 树 | TracePanel 按 parentId 组织层级：子任务步骤缩进 + 「子任务」标签 + 折叠下钻 | Agent 调试器时间线 |
| 结果存储徽标 | 工具卡片 📎「已存」——大结果已入结果存储，可零副作用重读 | 操作卡片详情 |
| 消息操作 | hover 复制回复 / 重发上一条（重试） | ChatGPT/Claude |
| 输入效率 | ↑ 回放上一条输入（30 条历史）、**Esc 停止**（流式期间输入框不禁用，保留键盘能力） | 终端习惯 |
| 会话成本 | composer 实时显示本会话累计成本（认知资源可见性） | — |
| 渲染性能 | 消息行 `content-visibility: auto`——长会话屏外消息跳过渲染（浏览器原生，零 JS 开销） | 虚拟化替代 |

- SSE 解析支持全部事件（含 v2.2 新增 handoff / budget_hit / tool_result.stored）。
- E2E 实测（Playwright + 真实 LLM）：中断→继续任务→三步任务无缝完成；真实 run_subagent
  在轨迹面板呈现 3 层子任务下钻；handoff 移交 planner 后横幅出现、交回主代理即消失；
  全程零控制台错误。

---

## 9. 目录结构

```
web-agent/
├─ package.json / tsconfig.json / .env.example
├─ README.md
├─ docs/ARCHITECTURE.md          ← 本文档
├─ kernel/                        ← 内核 6 大件（薄）
│  ├─ index.ts  types.ts  bus.ts  config.ts
│  ├─ scope.ts（可逆效应引擎）  plugin-loader.ts  trace.ts  cache.ts
├─ core/                          ← 核心插件（同样走插件机制）
│  ├─ chat/                       ← Agent 执行器 + LLM provider
│  └─ tools-fs/                   ← 文件工具插件
├─ plugins/                       ← 现场插件目录（用户自写，热加载）
├─ server/                        ← Express + SSE 路由
├─ ui/                            ← 前端（Vite React）
├─ data/                          ← SQLite / traces/ 审计日志
└─ scripts/                       ← dev/build 脚本
```

---

## 10. 开发路线

| 阶段 | 内容 | 出口标准 |
| --- | --- | --- |
| 0 | 项目初始化（package/tsconfig/git/.env 模板） | `npm run dev` 空跑通 |
| 1 | 内核：bus → config → trace → cache → plugin-loader | 单测/脚本验证 5 大件 |
| 2 | core/chat（Agent 执行器 + 流式 LLM）+ core/tools-fs | 命令行脚本完成一次带工具对话 |
| 3 | server API + SSE | curl 验证全部接口 |
| 4 | 前端 UI + 插件面板 + Trace 面板 | 浏览器全流程点测 |
| 5 | 联调、README、`.env.example` 说明 | 交付启动即用 |
| 6 | search 插件（Tavily/DDG）+ self-extend（agent 自建插件） | 对话中完成「自建插件→热加载→调用新工具」闭环 |
| 后续 | memory / 托盘 插件按需现场写 | — |

## 11. 现场写插件示例（开发范式，v2 契约）

用户要加"计算当前时间"能力，现场写：

```
plugins/clock/plugin.json     plugins/clock/index.ts
```

```json
{ "id": "clock", "name": "时钟工具", "version": "0.1.0",
  "entry": "index.ts", "enabled": true }
```

```ts
import type { Plugin } from '../../kernel/types';

export default {
  id: 'clock', name: '时钟工具', version: '0.1.0',
  async onLoad(ctx) {
    // 一切副作用自动入作用域：卸载/停用时按 LIFO 完全恢复（无需手写 onUnload 清理）
    ctx.register({
      kind: 'tool',
      tool: {
        name: 'get_current_time',
        description: '获取当前日期时间（Windows 本地时区）',
        parameters: { type: 'object', properties: {} },
        async handler() {
          return { ok: true, data: new Date().toLocaleString('zh-CN') };
        },
      },
    });
    // 事件订阅自动退订（旧写法 ctx.bus.on 不再推荐：重载后旧监听器会残留）
    ctx.on('plugin.started', (e) => {
      ctx.logger.info(`插件启动: ${(e.data as { id: string }).id}`);
    });
    // 声明式配置对账：配置键变化自动回调，卸载自动退订
    ctx.watchConfig('clock.timezone', (v) => ctx.logger.info(`时区更新: ${v}`));
    // 反应性依赖：chat 服务可用/不可用自动通知（无需轮询、无需重启）
    const chat = ctx.inject('service:chat', (v) => ctx.logger.info(v ? 'chat 服务可用' : 'chat 服务不可用'));
    if (!chat.value) ctx.logger.info('chat 服务暂不可用（可用后自动通知）');
  },
} satisfies Plugin;
```

保存文件 → 内核监听插件目录 → 自动 reload → 网页面板看到新工具 → Agent 立刻能调用。
**无需重启、无需改任何既有代码。** 若保存的版本有语法错误 → 事务性热重载自动回滚到
上一可用版本（插件不消失），修复后保存再次热重载即可。
