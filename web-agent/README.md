# maharness —— 自研 Windows 原生网页版 Agent

> **薄内核 · 全插件化 · 全程可观测 · 高缓存命中 · agent 可以自己定义自己**
> 只有内外之分：内部是唯一不变的 Agent 核心（kernel/）；其余一切能力均为可插拔组件——**现场写、现场加载、现场启停**。

## 设计理念（详见 `docs/ARCHITECTURE.md`）

| 信条 | 实现 |
| --- | --- |
| 内核极薄 | 内核聚合 6 个状态件：EventBus / Config / PluginLoader / Trace / Cache / Budget（另有 EffectScope **逐插件实例**、types/loop/service 三份契约件），**连对话都是插件** |
| 一切可插拔 | `plugins/` 目录现场写插件，保存即热加载，网页面板一键启停；**卸载即完全恢复**（可逆效应：能力/监听/服务/配置自动回收）；**坏版本自动回滚**（事务性热重载，永不半加载） |
| 全部自研 | Agent 循环、工具协议、插件机制、SSE 流式、缓存全部手写，零 agent 框架依赖 |
| 运行即轨迹 | 每次运行产生结构化 Trace：LLM 调用/工具调用/缓存命中，前端实时面板 + JSONL 审计 + 成本透明 |
| 缓存一等公民 | L1 语义缓存 / L2 工具结果缓存 / L3 prompt 前缀缓存（吃满 provider KV cache） |
| Windows-first | 路径沙箱（防穿越）、编码自动识别（UTF-8/UTF-16/GBK）、中文路径 |

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

- **对话**：输入消息，Enter 发送。Agent 会自动调用工具（读文件/写文件/列目录）并展示执行过程。
- **模型切换**：右上角下拉切换已配置的 Provider 模型（DeepSeek/OpenAI/通义…）。
- **会话模式**：右上角切换 普通 / 计划 / 目标。计划模式先出计划、确认后执行；目标模式自动建计划推进。
- **斜杠命令**：输入框输入 `/` **弹出命令面板**——方向键选择、Enter 执行、Tab 补全、Esc 关闭；命令直接执行（不消耗 LLM）——`/help` 全部命令、`/new` 新会话、`/clear` 清空、`/plan` `/goal` `/normal` 切模式、`/model <名称>` 切模型。
- **上下文管理**：会话历史超出预算（默认 60000 tokens，`context.maxTokens` 可调）时自动截断较早消息并注入说明，全程在轨迹面板可见。
- **文件 Tab（工作区）**：左侧「文件」Tab —— 添加/切换工作区（Agent 文件工具的沙箱边界，切换立即生效），浏览文件树、点击文件预览内容。
- **技能系统**：设置面板下方「技能」—— 已安装技能（内置 + 技能包 + 用户）查看/卸载，市场技能一键安装（放入 `market/` 目录的 SKILL.md 技能包即进入市场）。Agent 侧通过 `list_skills` / `get_skill` / `get_skill_file` 按需读取技能指南与技能包内多文件资源（agents/references/templates/shared/scripts），实现自我设计。

## 学术智能体（ARS 融合）

maharness 已融合 [Academic Research Skills (ARS)](https://github.com/Imbad0202/academic-research-skills)（当前最热门的科研技能套件，上游内容**零修改**整体落位 `vendor/academic-research-skills/`），开箱即得四个学术技能（网页端「技能」页可见，source=技能包）：

- **deep-research**：13 员研究团队——文献综述 / 系统性回顾(PRISMA) / 事实核查 / 苏格拉底式引导 / 三段式文献比较
- **academic-paper**：12 员写作管线——大纲 / 修改 / 摘要 / 引用检查 / 格式转换(APA7/IEEE/…) / AI 使用披露
- **academic-paper-reviewer**：5 席评审团——多视角同行评审 / 复审 / 方法学聚焦 / 审稿人校准
- **academic-pipeline**：10 阶段全流程编排——研究→写作→完整性核查→评审→修改→定稿（强制人机确认检查点）

直接用自然语言触发（如"帮我做 XX 的文献综述""写一篇关于 XX 的论文""审这篇稿子"），学术 persona（`core/academic`）自动路由到对应技能并按其工作流执行：技能正文与子代理角色定义经 `get_skill`/`get_skill_file` 读取，研究席位经 `run_subagent`/`run_parallel` 派发，产物写入当前工作区。完整设计与适配清单见 [docs/ARS-学术智能体融合.md](docs/ARS-学术智能体融合.md)。
- **插件面板**：左侧「插件」Tab —— 查看所有插件状态，一键启用/停用/重载。
- **统计面板**：左侧「统计」Tab —— 全局概览（会话/消息/tokens/成本/截断次数）、本次运行明细、每会话上下文用量（估算 token 与预算对比、截断状态）、三层缓存命中率（L1 语义问答 / L2 工具结果 / L3 prompt 前缀复用）与综合命中率。
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
- **密钥存储**：Provider 的 api_key 以 AES-256-GCM 落库，API 只回掩码；主密钥文件在 Windows 上
  用 `icacls` 收 DACL；解密失败标 `keyBroken` 并显示出来，不再静默当空串用；
  已有密文时拒绝静默重建主密钥（重建须显式 `MAHARNESS_ALLOW_SECRET_KEY_RESET=1` 且先备份原文件）。
- **技能供应链**：技能包同步先落临时目录、按锁文件清单逐文件校验，再原子换入——
  不留半成品、不残留上一版；`force` 不等于放弃校验。

### 已知边界（诚实版）

1. **信任边界是 OS 用户，不是这套 HTTP。** 同用户身份的恶意进程本就能直接读写工作区与
   `data/`，也能读服务端进程的环境变量；浏览器相对本机其它进程**没有任何额外特权**。
   所以上面的凭据门挡的是"无意图的本机调用"（其它工具/脚本/端口扫描/被注入的插件），
   不是也不是想要成为隔离边界——真正的隔离要靠单独的 OS 用户或容器。
2. 无多用户/多租户模型，没有会话鉴权，不适合暴露到公网或局域网共享。
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

## 2026 迭代能力

- **Agent 回归评测**（`npm run eval`）：确定性回放 golden 场景（`evals/cases/`），断言工具序列/最终答案/L1 缓存命中——agent 循环（决策-行动-观测/钩子/缓存）的回归保护，零 API 成本。可用 `npm run eval -- --record <name> <task>` 在真实 provider 下录制新场景。
- **任务复杂度模型路由**：`config.json` 配置 `agent.modelRouting`（任务类型 → provider，如 `{ "问答": "deepseek", "代码": "deepseek@deepseek-reasoner" }`）——按 `classifyTask` 让简单任务走便宜模型、复杂任务走强模型；命中 `model-route` 入 Trace 可观测。
- **对抗审查子代理**：`run_review` 工具用全新上下文的独立审查者审查产出（生成/评估分离），输出 `{verdict, issues, confidence}`；也可 `handoff_to('reviewer')` 把会话交给审查者角色。
- **分层记忆**：核心记忆块（`set/list/delete_memory_block`，每轮常驻注入）+ 档案记忆（`remember/recall/forget_fact`，按需检索）——agent 用工具自管理的两级记忆。
- **MCP 客户端**：`config.json` 配置 `mcp.servers`（stdio 或 http 传输），把 MCP 生态工具（filesystem/github/memory 等）拉进能力注册表（`mcp_*` 前缀）；`mcp_status` 查看连接状态。

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
| `EMBEDDING_BASE_URL/API_KEY/MODEL` | 未设 | 三者齐备才激活 L1 向量召回；否则走自研 bigram Dice（始终可用） |
| `TAVILY_API_KEY` | 未设 | 联网搜索用 Tavily；未配置自动降级 DuckDuckGo |
| `SEARCH_PROXY` | 未设 | DuckDuckGo/Tavily 搜索服务请求走无凭据 HTTP(S) 代理（如 `http://127.0.0.1:7897`）；拒绝其他协议、凭据、查询参数和片段；用户提供的网页抓取 URL 直连并固定到已校验 IP |
| `SANDBOX_ROOT` | 启动目录 | 文件工具与文件 API 的沙箱根（防穿越 + realpath） |
| `PORT` | `3000` | 服务端口（始终只绑 127.0.0.1） |
| `DEV_ORIGIN_PORT` | `5173` | 额外放行的 Origin（Vite 开发服务器） |
| `AUTO_STOP_IDLE_MS` | `30000` | 所有前端页关闭多久后自动停止后端；`0` = 关闭该行为 |
| `AGENT_DATA_DIR` / `AGENT_USER_PLUGINS_DIR` | — | 数据目录 / 用户插件目录覆盖（测试与多实例隔离） |
| `AGENT_ALLOW_PRIVATE_URLS` | 未设 | 放行内网/回环地址（连本机 Ollama 等）；**会同时关闭 SSRF 防护**，仅在明确需要时开 |
| `AGENT_ALLOW_CORE_EDIT` | 未设 | 放开 `kernel/`、`core/chat/` 写保护（开发 agent 自身时用；进程内首次判定后固化，改完需重启） |
| `MAHARNESS_API_TOKEN` | 未设（关闭） | 变更类端点需带 `x-maharness-token`；启用后页面需在 设置→高级→安全 录入同值 |
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
│  ├─ search/     #   联网搜索（Tavily / DuckDuckGo 降级 + 可选代理 + SSRF 防护）
│  ├─ memory/     #   长期记忆（分层：核心块 + 档案事实；失败教训自动记忆）
│  ├─ goal-plan/  #   多步目标计划模式（+ planner 角色）
│  ├─ powershell/ #   PowerShell 执行器（只读白名单 + 参数位代码检测 + 危险命令审批）
│  ├─ subagent/   #   子代理与对抗审查（run_subagent / run_review，只读白名单）
│  ├─ parallel/   #   并行小队（run_parallel：独立轨迹 + 预算均分）
│  ├─ todo/       #   会话级待办 + 看板面板（api 能力 + nav 声明）
│  ├─ mcp/        #   MCP 客户端（stdio / HTTP；env 白名单透传 + 默认需审批）
│  ├─ vision/     #   图像：登记 + 借道多模态模型分析（图片不进主上下文）
│  ├─ rules/      #   用户规则（提示规则 → persona；策略规则 → allow/deny/审批）
│  ├─ skills/     #   技能系统（内置 + 技能包 + 项目 + 用户；相关性索引）
│  ├─ evolve/     #   自进化（run 结束自动提案，人工采纳后入技能库）
│  ├─ academic/   #   ★ 学术智能体接线（ARS 路由 persona）
│  └─ self-extend/#   ★ 自我扩展（agent 可自建插件，定义自己）
├─ plugins/       # ★ 现场插件目录（热加载；Agent 自我扩展的落点）
├─ vendor/        # ★ ARS 学术技能包（上游零修改：deep-research / academic-paper / reviewer / pipeline）
├─ server/        # Express + SSE API（routes/ 按资源拆分；模式/角色策略在 core/chat/policy.ts）
├─ ui/            # React + Vite 前端
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
