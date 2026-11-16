# maharness —— 办公与学习 AI 工作台

直接处理文件、资料和轻量自动化任务，并通过插件持续扩展。底层保持 AI 原生 Agent 操作系统架构。

> **模型自主决策 · 持久任务运行时 · 显式授权 · 可插拔工具与循环**
> 只有内外之分：内部是唯一不变的 Agent 核心（kernel/）；其余一切能力均为可插拔组件——**现场写、现场加载、现场启停**。

## 设计理念（详见 `docs/ARCHITECTURE.md`）

| 信条 | 实现 |
| --- | --- |
| 内核极薄 | 内核聚合 6 个状态件：EventBus / Config / PluginLoader / Trace / Cache / Budget（另有 EffectScope **逐插件实例**、types/loop/service 三份契约件），**连对话都是插件** |
| 一切可插拔 | `plugins/` 目录现场写插件，保存即热加载，网页面板一键启停；能力、监听、服务、配置及已登记资源随卸载回收，外部副作用保留；**坏版本自动回滚**（事务性热重载，永不半加载） |
| 全部自研 | Agent 循环、工具协议、插件机制、SSE 流式、缓存全部手写，零 agent 框架依赖 |
| 运行即轨迹 | 每次运行产生结构化 Trace：LLM 调用/工具调用/缓存命中，前端实时面板 + JSONL 审计 + 成本透明 |
| 输入与缓存 | L1 相似答案缓存默认关闭；L2 工具结果缓存保留状态作用域，Provider 按实际输入复用原生前缀 |
| Windows-first | 路径沙箱（防穿越）、编码自动识别（UTF-8/UTF-16/GBK）、中文路径 |

运行时状态、任务 API、权限、插件契约与迁移规则见 [运行时与插件契约 v2](docs/RUNTIME-V2.md)；架构与验收见 [AI 原生运行时](docs/AI-NATIVE-V2.md)。任务内插件支持独立授权、版本绑定、同任务启用与用户显式保存，见 [可组合架构](docs/ARCHITECTURE.md)。

工具契约、插件编写、目录开销与取消语义的针对性轻量评测：`npm run eval:optimization`；可通过 `-- --report <新文件路径>` 保存源码指纹和结果。覆盖范围与验证结果见 [优化验证](docs/OPTIMIZATION-ACCEPTANCE.md)。

## 快速开始

```bash
# 1. 一键安装（后端 + 前端依赖；首次自动生成 .env，填入至少一个 API Key）
cd web-agent
npm run setup

# 2. 一键启动
maharness          # 全局命令：任意目录一键启动，就绪后自动打开浏览器（已在运行则直接打开）
# 或
npm run dev:all    # 开发模式：后端 :3000 + 前端 :5173（热更新）
# 或
npm run start:all  # 生产模式：构建前端后单端口启动 → http://localhost:3000
```

> `maharness` 全局命令由 `npm run setup` 自动注册（`npm link`）。若未注册，手动执行 `cd web-agent && npm link`。已在运行的服务会被自动复用，不会重复启动。

浏览器打开 **http://localhost:3000**（生产模式）或 **http://localhost:5173**（开发模式）即可使用。

## 使用

- **办公与学习**：添加或拖入文件，用自然语言提出要求，查看来源、预览和下载结果，并继续修改。支持 PDF 原页与 Office 内容预览、常规文件生成、普通内容定点另存及轻量论文阅读与题录核验。文件支持范围、OCR 配置和插件接口见 [办公与学习工作台](docs/WORKBENCH.md)。

  长文档支持分段草稿、回读及最终发布，中断后可检查和下载已保存文件。验证范围与真实模型结果见 [长内容交付与任务恢复验收](docs/LONG-CONTENT-ACCEPTANCE.md)。

- **待办与工作台**：用自然语言记录个人安排，关联资料，在专属会话执行并确认结果。工作台聚合今日事项、执行进度和最近结果；完整工作台保留项目、笔记与复盘。见 [个人事项与工作台](docs/PERSONAL-ITEMS.md)。
- **对话**：输入消息，Enter 发送。Agent 会自动调用工具（读文件/写文件/列目录）并展示执行过程。
- **模型切换**：右上角下拉切换已配置的 Provider 模型（DeepSeek/OpenAI/通义…）。
- **会话模式**：普通模式自主执行；计划模式允许观察，变更操作等待批准；目标模式展示目标与进度，执行循环与普通模式相同。计划工具按需使用。
- **计划状态机**：步骤只允许 pending → in_progress/done/blocked、blocked → in_progress、done → 重新打开等合法迁移；`complete_goal` 在仍有未完成步骤时拒绝收尾；重新打开步骤会清除计划完成位。
- **斜杠命令**：输入框输入 `/` **弹出命令面板**——方向键选择、Enter 执行、Tab 补全、Esc 关闭；命令直接执行（不消耗 LLM）——`/help` 全部命令、`/new` 新会话、`/clear` 清空、`/plan` `/goal` `/normal` 切模式、`/model <名称>` 切模型。
- **上下文管理**：按模型窗口和输出预留计算输入容量；压缩保留明确约束与来源，原始材料可检索。必需内容超过容量时明确报错，模型输入组成可在运行诊断中查看。
- **文件 Tab（工作区）**：左侧「文件」Tab —— 添加/切换工作区（Agent 文件工具的沙箱边界，切换立即生效），浏览文件树、点击文件预览内容。
- **技能系统**：设置面板下方「技能」—— 已安装技能（内置 + 技能包 + 用户）查看/卸载，市场技能一键安装（放入 `market/` 目录的 SKILL.md 技能包即进入市场）。Agent 侧通过 `list_skills` / `get_skill` / `get_skill_file` 按需读取技能指南与技能包内多文件资源（agents/references/templates/shared/scripts），实现自我设计；frontmatter 支持 `version`、`requires`、`allowed-tools`，缺失依赖会进入契约告警并按会话执行工具白名单；覆盖安装前自动保留 5 份历史快照，可用 `rollback_skill` 回滚。

## 学术智能体（ARS 融合）

maharness 已融合 [Academic Research Skills (ARS)](https://github.com/Imbad0202/academic-research-skills)（当前最热门的科研技能套件，上游内容**零修改**整体落位 `vendor/academic-research-skills/`），开箱即得四个学术技能（网页端「技能」页可见，source=技能包）：

- **deep-research**：13 员研究团队——文献综述 / 系统性回顾(PRISMA) / 事实核查 / 苏格拉底式引导 / 三段式文献比较
- **academic-paper**：12 员写作管线——大纲 / 修改 / 摘要 / 引用检查 / 格式转换(APA7/IEEE/…) / AI 使用披露
- **academic-paper-reviewer**：5 席评审团——多视角同行评审 / 复审 / 方法学聚焦 / 审稿人校准
- **academic-pipeline**：10 阶段全流程编排——研究→写作→完整性核查→评审→修改→定稿（强制人机确认检查点）

模型可按任务需要，通过 `get_skill` / `get_skill_file` 读取学术技能与角色材料，通过 `run_subagent` / `run_parallel` 委派研究工作，产物写入当前工作区。技能安装本身不强制切换执行流程。技能包说明见 [docs/ARS-学术智能体融合.md](docs/ARS-学术智能体融合.md)。
- **插件面板**：左侧「插件」Tab —— 查看所有插件状态，一键启用/停用/重载。工作台已提供任务、灵感、项目、复盘与数据备份。
- **统计面板**：左侧「统计」Tab —— 全局概览（会话/消息/tokens/成本/截断次数）、本次运行明细、每会话上下文用量（估算 token 与预算对比、截断状态）、三层缓存命中率（L1 语义问答 / L2 工具结果 / L3 prompt 前缀复用）与综合命中率；「生态健康」聚合插件运行/错误、MCP server 状态/熔断/OAuth 与当前租户会话数。
- **运行轨迹**：右上角「运行轨迹」—— 实时显示每次 LLM 调用与工具执行的耗时、token、成本、缓存命中（黑箱解药）。

## 安全模型（机器强制，不依赖提示词）

下面每一条都落在**代码**里（执行器 / 内核 / server 中间件），不是写给模型看的规矩。
本节只描述"当前确实生效"的行为；挡不住的部分写在末尾**已知边界**里，不粉饰。

- **只绑回环 + Host/Origin 校验**：服务只监听 `127.0.0.1`，局域网与外网不可达；
  `Host` 必须精确匹配本机回环主机名+端口（挡 DNS rebinding），`Origin` 存在时必须在白名单
  （挡跨源页面）。校验注册在所有业务路由与插件 API 之前。
- **审批下沉执行器，工具自觉不算数**：需要审批的调用在**进入 handler 之前**就被挂起
  （`approval` 声明或 `assessApproval` 按参数动态判定，判定函数抛错按"需要审批"处理）；
  高危工具的 handler 另做二次校验（`approved` / 用户策略放行 `policyApproved` 之外一律拒绝）。
  审批全程入 Trace；用户拒绝不会被记成"失败教训"。
- **审批审计可追溯**：请求与决策持久化到 `approval_requests`（租户、会话、工具、摘要、参数、创建/过期时间、approved/rejected/expired/withdrawn），`GET /api/approvals/history` 可按租户/会话查询；审计写入失败不影响审批本身。
- **PowerShell 默认需审批**：白名单是"每段首词是只读 cmdlet"**且**"参数位不含可执行构造"——
  脚本块只允许 `$_` 属性 + 比较/逻辑运算符的安全子集，出现类型字面量 / `::` 静态成员 /
  `$()` 子表达式 / 赋值 / 调用运算符即回到审批（否则 `Get-ChildItem | Where-Object { [IO.File]::Delete('x') }`
  会借"只读 cmdlet"免审批执行任意 .NET 代码）。敏感目标（`.env`/密钥/库文件）即使只读也强制审批；
  超时用 `taskkill /T /F` 杀进程树；cwd 锚定沙箱根。
- **内核写保护 + 敏感清单（双基座）**：`kernel/`、`core/chat/` 写/删一律拒绝（自我接管防护）；
  `.env` 与 `data/` 不可读（密钥不进上下文），写入则**必须用户批准**且不受
  `tools.writeRequiresApproval` 开关影响。判定同时按**沙箱根**与**项目根**两个基座算相对路径——
  只按沙箱根算时，`SANDBOX_ROOT` 指到别处会让这整条保护形同虚设。
- **沙箱边界**：文件工具与文件 API 共用同一校验（防穿越 + `realpath`）；工作区登记/切换
  拒绝文件系统根、家目录及其祖先、系统目录（且对历史已入库的危险路径复检）；同会话并发对话 409 互斥。
- **SSRF 防护**：`web_fetch` 与 Provider 连通性检测逐跳复检（重定向不是免检通道）、
  协议白名单、DNS 解析后拒私网/环回/链路本地，并正确还原 IPv4-mapped IPv6 的十六进制形式
  （`[::ffff:7f00:1]` 等价于 127.0.0.1）；响应体流式限量。
- **MCP 边界**：stdio server 默认只透传运行必需的环境变量（`*_API_KEY` 等不再外泄，
  需要时写进该 server 自己的 `env` 配置）；MCP 工具**默认需要审批**；win32 回收 `npx` 的孙进程。
- **凭据（可选，默认关闭）**：
  - `MAHARNESS_API_TOKEN`：把"改变 agent 行为与审批语义"（批准危险命令 / 切沙箱根 / 注入
    allow 策略）变成需要显式授权。凭据**由人在设置页录入本浏览器**，不经服务端下发——
    服务端下发等于对本机所有进程公开，门会退化成装饰。
  - `MAHARNESS_APPROVAL_TOKEN`：回答审批必须回带该次挂起的一次性凭据（单次有效，重放被拒）。
  - 当前状态、主密钥是否可用、审批门是否已被通配 allow 策略整体放行，都在
    **设置 → 高级 → 安全**如实显示（`GET /api/security`，不含任何密钥材料）。
- **部署模式（`MAHARNESS_MODE`，默认 `local`）**：
  - `local`：本机单用户，只绑 127.0.0.1，变更类请求可选 token——既有用法不变。
  - `trusted`：本机受信收紧档，仍只绑回环，但**全部 API（含只读与 SSE）强制 token**，
    审批凭据自动强制；必须设置 `MAHARNESS_API_TOKEN`，否则启动自检拒绝。
  - `remote`：对外暴露的最低安全线——必须同时提供 `MAHARNESS_API_TOKEN` 与
    `MAHARNESS_TLS_CERT`/`MAHARNESS_TLS_KEY`（成对），服务以 HTTPS 监听 `MAHARNESS_BIND`；
    Host/Origin 白名单按实际域名经 `MAHARNESS_ALLOWED_HOSTS/ORIGINS` 显式扩展。
    插件仍在宿主进程执行，remote 只解决传输与凭据层，不等价于多租户隔离。
    当前验收基线为 local/trusted 的进程级隔离（静态审查、独立子进程、文件/网络守卫、配额）；
    容器级强隔离是可选 L3 provider，未具备时 remote/team 保持 fail-closed。
- **密钥存储**：Provider 的 api_key 以 AES-256-GCM 落库，API 只回掩码；主密钥文件在 Windows 上
  用 `icacls` 收 DACL；解密失败标 `keyBroken` 并显示出来，不再静默当空串用；
  已有密文时拒绝静默重建主密钥（重建须显式 `MAHARNESS_ALLOW_SECRET_KEY_RESET=1` 且先备份原文件）。
- **技能供应链**：技能包同步先落临时目录、按锁文件清单逐文件校验，再原子换入——
  不留半成品、不残留上一版；`force` 不等于放弃校验。
- **技能依赖图**：`skills-lock.json` 支持 semver `version` 与 `requires`（数组 `name@range` 或对象 `{ name: range }`）；缺失依赖、版本不满足和循环依赖在同步前拒绝。
- **技能路由评测**：技能索引打分统一使用 `triggers` / `applies-when` / `reject-when`；`npm run skill:eval` 对固定 prompt 做 top-K 路由回归，防止技能索引静默选错。

### 已知边界（诚实版）

1. **信任边界是 OS 用户，不是这套 HTTP。** 同用户身份的恶意进程本就能直接读写工作区与
   `data/`，也能读服务端进程的环境变量；浏览器相对本机其它进程**没有任何额外特权**。
   所以上面的凭据门挡的是"无意图的本机调用"（其它工具/脚本/端口扫描/被注入的插件），
   不是也不是想要成为隔离边界——真正的隔离要靠单独的 OS 用户或容器。
2. 租户是文件级逻辑分区，不是进程级隔离：default 使用全局工作区，其他租户的文件根位于 `<工作区>/.tenants/<tenantId>`；Agent 工具、子代理、文件 API 与 Git API 都按租户根解析。Provider、人设、技能与插件配置仍是全实例共享，变更仅 admin。迁移前可用 `npm run tenant:backup -- --tenant <id>` 快照，失败时用 `tenant:restore` 回滚。不要把不同信任级别的用户放进同一个实例；remote/team 在强隔离缺失时 fail-closed。
3. 审批凭据目前同时经 `GET /api/approvals` 下发，因此它只把"代批"的门槛从
   "知道 id"抬到"必须先列举且凭据单次有效"；要彻底关闭请启用 `MAHARNESS_API_TOKEN`。
4. `MAHARNESS_API_TOKEN` 一旦启用，页面需在设置→高级→安全 录入同一个值，
   否则修改类操作会全部 401（这是设计，不是故障）。
5. Provider 与网页抓取直连会把同一次 DNS 解析结果用于校验和 socket 连接，重定向逐跳重新校验并 pinning。`SEARCH_PROXY` 仅用于固定的 DuckDuckGo/Tavily 搜索服务请求；只接受无凭据的 HTTP(S) 代理 URL，配置变化会关闭旧连接池；代理端解析由用户配置的受信代理负责，不适用于不可信代理。
6. 插件是**完全信任**的：`module` 模式的前端模块与宿主同源同 realm、没有沙箱，
   只应用于自己写或自己安装的插件；不可信来源请用 `iframe` 模式。
7. `core/` 内置插件不在目录监听范围内（改动需重载或重启）；只有 `plugins/` 保存即生效。

## 缓存体系（三层，命中即可见）

| 层 | 机制 | 命中收益 |
| --- | --- | --- |
| L1 语义问答 | 自研字符 bigram Dice 相似度（免 embedding API，始终可用）；相同/近似问题命中直接返回缓存答案 | 完全跳过 LLM 调用，成本 0（回答带 ⚡缓存命中 标记） |
| L2 工具结果 | hash(工具+参数)+文件 mtime/size 校验，TTL 30 分钟 | 重复工具调用不重算（读文件/列目录/搜索） |
| L3 前缀复用 | 消息"只追加不重写"吃 provider KV cache，Agent 循环统计公共前缀 token | 多轮对话输入成本按 provider 缓存折扣计费 |

每次 L1/L2 命中都在 Trace 中记录可解释来源：匹配方式、命名空间、作用域、剩余 TTL 与命中次数；命中不再只是一个布尔值。

## 现场写插件（核心能力）

在 `plugins/` 下新建一个文件夹，写两个文件，**保存即生效**：

```
plugins/clock/plugin.json
plugins/clock/index.ts
```

```json
{ "id": "clock", "name": "时钟工具", "version": "0.1.0", "entry": "index.ts", "enabled": true }
```

```ts
import type { Plugin } from '../../kernel/types';

export default {
  id: 'clock', name: '时钟工具', version: '0.1.0',
  async onLoad(ctx) {
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
  },
} satisfies Plugin;
```

能力类型：`tool`（Agent 工具）/ `listener`（事件监听）/ `command`（斜杠命令）/ `provider`（LLM 提供者）/ `service`（对外服务）。

### Agent 自己写插件（自我扩展）

**maharness 核心理念：万物都是插件，agent 可以自己定义自己。** 内置 `self-extend` 插件让 Agent 具备自我扩展能力：

- `create_plugin` —— 由 Agent 调用：传入插件 id 与完整 `index.ts` 源码，自动生成 `plugin.json` 并写入 `plugins/`，热加载后回传状态；加载失败时回传错误信息供 Agent 修复迭代。
- `plugin_status` —— 查看 `plugins/` 现场插件的加载状态 / 能力 / 错误。

工作闭环：**Agent 想要新能力 → create_plugin（或 write_file）写插件 → 保存即热加载 → plugin_status 验证 → 失败则读错误修复 → 下一轮对话即可使用新工具**。内核与 core/ 目录保持不变，扩展永远发生在外部插件空间。

插件源码只允许相对导入与安全 Node 内置模块；需要第三方 npm 包时，由管理员把包名写入 `config.json` 的 `plugins.allowedDependencies`。静态审查与隔离试运行通过后，依赖清单会写入插件 manifest。

## 2026 迭代能力

- **Agent 回归评测**（`npm run eval`）：确定性回放 golden 场景（`evals/cases/`），断言工具序列/最终答案/L1 缓存命中——agent 循环（决策-行动-观测/钩子/缓存）的回归保护，零 API 成本。可用 `npm run eval -- --record <name> <task>` 在真实 provider 下录制新场景。
- **真实模型 live 评测**（`npm run eval:live`）：从 `EVAL_*` 或 `NEWAPI_*` 读取模型配置，按 `evals/live-cases.json` 采样回答，再用 LLM-as-judge 按 rubric 打分；无 key 时明确跳过。它测模型行为，补偿确定回放测不到的泛化与指令遵循。
- **任务复杂度模型路由**：`config.json` 配置 `agent.modelRouting`（任务类型 → provider，如 `{ "问答": "deepseek", "代码": "deepseek@deepseek-reasoner" }`）——按 `classifyTask` 让简单任务走便宜模型、复杂任务走强模型；命中 `model-route` 入 Trace 可观测。
- **Provider Gateway**：`service:provider-gateway` 统一暴露 Provider、模型能力、任务/能力路由、健康与 embedding；`GET /api/providers/gateway` 提供不含地址和密钥的只读快照。
- **对抗审查子代理**：`run_review` 工具用全新上下文的独立审查者审查产出（生成/评估分离），输出 `{verdict, issues, confidence}`；也可 `handoff_to('reviewer')` 把会话交给审查者角色。
- **分层记忆**：核心记忆块（`set/list/delete_memory_block`，每轮常驻注入）+ 档案记忆（`remember/recall/forget_fact`，按需检索）——agent 用工具自管理的两级记忆；事实与核心块都按租户隔离，事实带来源、置信度、TTL、撤回与冲突关系。
- **MCP 客户端**：`config.json` 配置 `mcp.servers`（stdio 或 http 传输），把 MCP 生态工具（filesystem/github/memory 等）拉进能力注册表（`mcp_*` 前缀）；`mcp_status` 查看连接状态、熔断健康与 OAuth 状态，`mcp_reconnect` 在 server 重启或令牌轮换后重连并刷新工具。HTTP server 支持 `headers`、`auth: { type: "bearer", tokenEnv: "MCP_TOKEN" }`、401 后的 `auth.refresh` 换新，以及 OAuth 2.1 授权码 + PKCE（`mcp_oauth_login` 生成授权链接，`mcp_oauth_complete` 用回调 code 换 token，token 存插件私有存储并自动 refresh）。`tools` / `resources` / `prompts` 都是显式 allowlist；`mcp_registry_search` / `mcp_registry_install` 可搜索并安装 registry 条目，但只接受 npm stdio（固定 `npx -y` 包）或 https remote，registry 提供的 env/命令模板不直接落地。可用 `maxCallsPerMinute` / `maxConcurrentCalls` 限制资源；`circuitBreaker.failureThreshold` / `cooldownMs` 控制连续失败后的快速失败与半开探测。
- **MCP server**：`config.json` 的 `mcp.server.enabled=true` 时，在 `/api/plugins/mcp/rpc` 暴露 JSON-RPC 端点；只有 `mcp.server.tools` allowlist 内的工具可被外部 MCP 客户端调用。
- **依赖 DAG 多代理**：`run_parallel` 支持 `id` / `dependsOn` / `publish`；无依赖任务同批并发，下游只接收上游结构化结论，成功结果可写入会话共享黑板。
- **工具副作用契约**：工具声明 `sideEffect`（none/read/write/external/irreversible）；只读工具恢复时重新观察，写类工具进入副作用账本，并可回传文件、URL、命令等结构化 evidence；任务验收可用 `tool_evidence` 检查具体证据。
- **研究链**：搜索链支持 SearXNG / Tavily / DuckDuckGo，本地去重与重排；`web_fetch` 读取单页，`web_crawl` 并发收集最多 5 页并返回引用清单。
- **代码诊断**：`repo_map` / `find_symbol` 对 TS/JS 使用 TypeScript AST，对 Python/Go/Rust/Java/C#/C/C++ 等使用 Tree-sitter WASM 提取顶层符号；`project_diagnostics` 运行编译器并返回沙箱内文件的类型错误；配置 `codeIntel.lsp` 后，`lsp_definition` / `lsp_hover` / `lsp_diagnostics` 通过 stdio language server 提供精确跳转、悬停与诊断。
- **文档结构化**：`read_document` 支持 PDF 页码、PDF 表格检测、DOCX 正文与表格，输出统一为正文加表格行；配置 `document.ocr.command` 后，`ocr_image` 对沙箱内图片执行外部 OCR；再配置 `document.ocr.pdfCommand` 后，`ocr_pdf` 先渲染扫描版 PDF 页面再逐页 OCR。未配置时明确报错而不返回空文本。
- **浏览器自动化**：可选 Playwright 插件支持打开、快照、点击、输入、按键、网络响应观测、下载与截图；`browser.persistent` 控制持久化/临时 profile，交互与下载默认审批。
- **插件供应链**：现场插件的外部导入必须命中 `plugins.allowedDependencies`；未列入白名单的 npm 包或危险 Node 内置模块在写入与隔离试运行前拒绝。
- **插件资源配额**：manifest 的 `limits` 可在工具 handler 前限制频率/并发，并在 `ctx.storage.write` 前限制私有存储字节数与文件数；超限返回可读错误并发布配额事件。
- **插件运行时声明**：manifest 的 `permissions.runtime` 声明文件/网络/进程能力；声明后加载前审查入口源码，越界直接拒绝，未声明的旧插件保持兼容。
- **插件进程边界**：manifest 的 `execution: { mode: "process" }` 把只提供 tool 能力的插件放入独立子进程：V8 堆上限、单次调用硬超时、最小环境透传，崩溃不带崩宿主；`stop/unload` 同时终止子进程。`permissions.runtime.network=allowlist` + `networkAllowlist` 在子进程内包住 fetch/http/https/net/tls/dgram，按主机与端口阻断未授权出口；`permissions.runtime.filesystem=none|storage|sandbox` 在子进程内包住 `node:fs` 与 `fs.promises`，按插件存储目录、工作区根和只读资产根做路径判定，非 `full` 声明必须使用 `execution.mode=process`。该边界解决崩溃、资源与声明式出口/路径策略，不替代 OS 账户/容器级安全隔离。
- **插件锁文件**：`npm run plugin:lock` 生成 `plugins-lock.json`，记录版本、10 位源码聚合哈希、兼容范围与权限；`plugins.enforceLock=true` 时用户插件加载前逐项校验，任一漂移即拒绝。`npm run plugin:lock:verify` 供发布门禁使用。

## 团队与租户（逻辑隔离）

设置 → 安全 可切换当前租户；API 通过 `x-maharness-tenant` 选择租户。admin token 可读写，`MAHARNESS_READONLY_TOKEN` 只能读取且绑定 `MAHARNESS_READONLY_TENANT`。`/api/tokens` 可创建绑定租户的 admin/member/readonly token：数据库只存 sha256 哈希，token 仅在创建响应展示一次，支持过期与吊销；member/readonly 的 Header 不能横穿绑定租户。

会话、消息、统计、Trace 查询与审批按租户过滤：不属于当前租户的会话统一返回 404，跨租户审批不可见。`/api/tenants` 提供租户注册表，`maxSessions` 控制单租户会话配额，`maxActiveRuns` 控制并发任务配额，`maxCostUsd` 控制累计成本配额，`maxStorageBytes` 控制工作区存储配额（`0` 为不限制）；成本/会话超限返回 429，存储超限返回 413。

长任务可通过 `POST /api/sessions/:id/resume-at`（`dueAt` 或 `delayMs`）安排到点续跑；`GET /api/schedules` 查看当前租户计划，`DELETE /api/schedules/:id` 取消。调度器只恢复已有 checkpoint 的会话，不注入新提示词；`409`/网络错误最多重试 3 次。

办公工作台（workbench）当前是单用户单桥文件模型，只允许 `default` 租户使用；其他租户的 API 与 Agent 工具访问一律 fail-closed，避免任务/日记跨租户共享。

工作区、Provider、人设、技能与插件配置属于管理员维护的共享基础设施。default 租户的文件根是全局工作区；其他租户自动落到 `<工作区>/.tenants/<tenantId>`，Agent 工具、子代理、文件 API 与 Git API 使用同一租户根。切换工作区会改变全局基座，租户根随之迁移。租户仍是**文件级逻辑分区**，不是进程或信任边界；不可信用户不应共享同一个实例。

```json
{ "agent": { "modelRouting": { "问答": "deepseek", "代码": "deepseek@deepseek-reasoner" } },
  "mcp": { "servers": { "filesystem": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } } } }
```

> 仓库已提供 `config.example.json`（含上述全部键的完整示例），复制为 `config.json`（与 package.json 同级）后按需修改；所有键都可省略——省略即用代码内默认值。网页端「设置」页的改动会自动写回 `config.json`。

## 环境变量

Provider（`<NAME>_BASE_URL/API_KEY/MODEL` 自动发现，任意命名）之外，全部可选开关：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `<NAME>_PRICE_IN` / `_PRICE_OUT` | — | 覆盖价格（USD/百万 token，用于成本核算） |
| `EMBEDDING_BASE_URL/API_KEY/MODEL` | 未设 | 三者齐备才激活 L1 语义缓存、长期记忆向量召回和技能语义路由；否则走自研 bigram + 置信度/时效评分（始终可用） |
| `TAVILY_API_KEY` | 未设 | 联网搜索用 Tavily；未配置自动降级 DuckDuckGo |
| `SEARXNG_BASE_URL` | 未设 | 自托管 SearXNG 地址（如 `http://127.0.0.1:8080`）；配置后优先于 Tavily / DuckDuckGo |
| `SEARCH_PROXY` | 未设 | DuckDuckGo/Tavily 搜索服务请求走无凭据 HTTP(S) 代理（如 `http://127.0.0.1:7897`）；拒绝其他协议、凭据、查询参数和片段；用户提供的网页抓取 URL 直连并固定到已校验 IP |
| `SANDBOX_ROOT` | 启动目录 | 文件工具与文件 API 的沙箱根（防穿越 + realpath） |
| `PORT` | `3000` | 服务端口 |
| `MAHARNESS_MODE` | `local` | 部署模式：`local`（回环 + 变更类 token 可选）/ `trusted`（回环 + 全 API 强制 token 与审批凭据）/ `remote`（必须同时提供 API token 与 TLS 证书，否则拒绝启动） |
| `MAHARNESS_BIND` | remote 时 `0.0.0.0` | remote 模式监听地址；local/trusted 不允许设置（固定回环） |
| `MAHARNESS_TLS_CERT` / `MAHARNESS_TLS_KEY` | 未设 | remote 模式 HTTPS 证书与私钥路径，必须成对提供 |
| `MAHARNESS_ALLOWED_HOSTS` / `MAHARNESS_ALLOWED_ORIGINS` | 未设 | remote 模式额外放行的 Host/Origin 白名单（逗号分隔，按实际域名配置） |
| `DEV_ORIGIN_PORT` | `5173` | 额外放行的 Origin（Vite 开发服务器） |
| `AUTO_STOP_IDLE_MS` | `30000` | 所有前端页关闭多久后自动停止后端；`0` = 关闭该行为 |
| `AGENT_DATA_DIR` / `AGENT_USER_PLUGINS_DIR` | — | 数据目录 / 用户插件目录覆盖（测试与多实例隔离） |
| `AGENT_ALLOW_PRIVATE_URLS` | 未设 | 放行内网/回环地址（连本机 Ollama 等）；**会同时关闭 SSRF 防护**，仅在明确需要时开 |
| `AGENT_ALLOW_CORE_EDIT` | 未设 | 放开 `kernel/`、`core/chat/` 写保护（开发 agent 自身时用；进程内首次判定后固化，改完需重启） |
| `MAHARNESS_API_TOKEN` | 未设（关闭） | 变更类端点需带 `x-maharness-token`；启用后页面需在 设置→高级→安全 录入同值 |
| `MAHARNESS_READONLY_TOKEN` | 未设（关闭） | trusted/remote 模式下的只读角色 token：可读 API，变更类请求仍必须使用 admin token |
| `MAHARNESS_READONLY_TENANT` | `default` | 只读 token 绑定的租户；不匹配的 `x-maharness-tenant` 一律 403 |
| `MAHARNESS_DEFAULT_TENANT` | `default` | 无 `x-maharness-tenant` 头时使用的默认租户；会话列表/消息/删除/统计已按租户隔离 |
| `MAHARNESS_INTERNAL_BASE_URL` | 空 | remote TLS 模式下调度器回环调用地址（如 `https://127.0.0.1:3000`）；local/trusted 自动使用 `http://127.0.0.1:<PORT>` |
| `MAHARNESS_APPROVAL_TOKEN` | 未设（不强制） | 强制回答审批回带一次性凭据；前端已自动回带，设 `1` 即生效 |
| `MAHARNESS_ALLOW_BLANKET_ALLOW` | 未设 | 允许经 HTTP 写入"对全部工具放行"的策略规则（默认需 `confirm:true` 显式确认） |
| `MAHARNESS_ALLOW_SECRET_KEY_RESET` | 未设 | 允许在主密钥文件异常且库中已有密文时重建密钥（默认拒绝并备份原文件） |
| `MAHARNESS_ALLOW_SKILL_HASH_MISMATCH` | 未设 | 允许技能同步时哈希不符仍落盘（默认拒绝并回报实际哈希） |
| `MAHARNESS_SECRET_KEY_ACL` | 启用 | 设 `0` 跳过主密钥文件的 `icacls` 权限收紧（测试用） |
| `TRACE_LLM_BODY` | 未设 | 设 `on` 把发给模型的请求体追加到 `llm-body.log`（调试前缀缓存用） |

## 项目结构

```
web-agent/
├─ kernel/        # 薄内核（唯一不变）：bus / config / trace / cache / budget / plugin-loader / scope
│                 #   + shared（跨模块副本的共享单例）+ 三份契约：types / loop / service
├─ core/          # 核心插件（同样走插件机制；从内容快照目录加载，非用户插件目录）
│  ├─ chat/       #   Agent 执行器（service:runner 默认实现）+ OpenAI/Anthropic/Ollama 三协议客户端
│  ├─ tools-fs/   #   文件工具（沙箱 + 编码识别 + L2 缓存 + 敏感写审批）
│  ├─ code-intel/ #   代码导航（repo map + 符号查找）
│  ├─ search/     #   联网搜索（Tavily / DuckDuckGo 降级 + 可选代理 + SSRF 防护）
│  ├─ memory/     #   按需长期记忆（核心块、档案事实与来源引用）
│  ├─ blackboard/ #   会话级共享黑板（多代理结构化中间结果）
│  ├─ goal-plan/  #   多步目标计划模式（+ planner 角色）
│  ├─ powershell/ #   PowerShell 执行器（只读白名单 + 参数位代码检测 + 危险命令审批）
│  ├─ subagent/   #   子代理与独立审查（授权继承与共享任务预算）
│  ├─ parallel/   #   并行任务（独立轨迹、共享容量与原子预算预留）
│  ├─ todo/       #   会话级待办 + 看板面板（api 能力 + nav 声明）
│  ├─ mcp/        #   MCP 客户端 + 可选 server 端点（stdio / HTTP；env 白名单透传 + 默认需审批）
│  ├─ vision/     #   图像：登记 + 借道多模态模型分析（图片不进主上下文）
│  ├─ document/   #   文档读取（PDF / DOCX 文本抽取；预留 OCR/表格）
│  ├─ browser/    #   浏览器自动化（Playwright；默认关闭）
│  ├─ otel/       #   可选 OTLP/HTTP trace 导出
│  ├─ rules/      #   用户规则（提示规则 → persona；策略规则 → allow/deny/审批）
│  ├─ skills/     #   技能系统（内置 + 技能包 + 项目 + 用户；相关性索引）
│  ├─ evolve/     #   自进化（run 结束自动提案，人工采纳后入技能库）
│  ├─ academic/   #   ★ 学术智能体接线（ARS 路由 persona）
│  └─ self-extend/#   ★ 自我扩展（agent 可自建插件，定义自己）
├─ plugins/       # ★ 现场插件目录（热加载；Agent 自我扩展的落点）
├─ vendor/        # ★ ARS 学术技能包（上游零修改：deep-research / academic-paper / reviewer / pipeline）
├─ server/        # Express + SSE API（routes/ 按资源拆分；模式/角色策略在 core/chat/policy.ts）
├─ ui/            # React + Vite + Tailwind CSS v4 + shadcn/ui 前端
├─ data/          # SQLite 会话存储 + traces/ JSONL 审计日志
└─ docs/          # 架构设计文档（含 ARS 融合设计）
```

## 开发命令

```bash
npm run dev          # 后端（tsx watch 热重启）
npm run typecheck    # 后端类型检查
npm run ui:dev       # 前端开发模式（Vite，代理 /api）
npm run ui:build     # 前端构建
```

## 路线

- [x] v1 最小闭环：内核 + 对话 + 文件工具 + 网页面板 + 轨迹观测
- [x] self-extend 自我扩展：Agent 可自建插件（万物皆插件，自己定义自己）
- [x] search 插件（联网搜索，Tavily / DuckDuckGo 降级 + 可选代理）
- [x] 钩子管线：agent.* 六钩子（input/before_llm/after_llm/before_tool/after_tool/on_error）
- [x] memory 插件（长期记忆，before_llm 钩子注入，跨会话）
- [x] powershell 插件（Windows Shell 能力）
- [ ] 系统托盘 / 开机自启
