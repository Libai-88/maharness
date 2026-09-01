# maharness —— 自研 Windows 原生网页版 Agent

> **薄内核 · 全插件化 · 全程可观测 · 高缓存命中 · agent 可以自己定义自己**
> 只有内外之分：内部是唯一不变的 Agent 核心（kernel/）；其余一切能力均为可插拔组件——**现场写、现场加载、现场启停**。

## 设计理念（详见 `docs/ARCHITECTURE.md`）

| 信条 | 实现 |
| --- | --- |
| 内核极薄 | 内核仅 6 大件：EventBus / PluginLoader / Config / Trace / Cache / EffectScope，**连对话都是插件** |
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
- **上下文管理**：会话历史超出预算（默认 30000 tokens，`context.maxTokens` 可调）时自动截断较早消息并注入说明，全程在轨迹面板可见。
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

- **本机专用**：服务仅监听 `127.0.0.1`，Host/Origin 白名单校验（防局域网直连与 DNS rebinding）。
- **审批强制**：声明 `approval:true` 的工具由执行器在调用前机器强制挂起（write_file/delete_file/powershell 等）；审批拒绝不会被记为"失败教训"。
- **PowerShell 白名单模型**：默认需审批；仅整条命令每段都是只读白名单命令（Get-ChildItem/Get-Content/ls/dir/cat 等）免审批；`.env`/数据库等敏感目标即使只读命令也强制审批；进程 cwd 锚定沙箱根。
- **内核写保护**：Agent 无法写 `kernel/`、`core/chat/`（自我接管防护）；`.env` 与 `data/` 不可读（密钥不进上下文）。开发时设 `AGENT_ALLOW_CORE_EDIT=1` 放行。
- **沙箱边界**：文件工具与文件 API 共用同一校验（防穿越 + realpath）；工作区切换仅限已登记路径；同会话并发对话 409 互斥。

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

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `DEEPSEEK_BASE_URL/API_KEY/MODEL` | DeepSeek Provider（任意命名，自动发现） |
| `OPENAI_BASE_URL/API_KEY/MODEL` | OpenAI Provider |
| `<NAME>_PRICE_IN/OUT` | 可选：覆盖价格（USD/百万 token，用于成本核算） |
| `EMBEDDING_BASE_URL/API_KEY/MODEL` | 可选：激活 L1 语义缓存 |
| `TAVILY_API_KEY` | 可选：联网搜索用 Tavily（更稳定）；未配置自动降级 DuckDuckGo |
| `SEARCH_PROXY` | 可选：搜索请求走 HTTP 代理（如 `http://127.0.0.1:7897`），网络受限时使用 |
| `SANDBOX_ROOT` | 文件工具沙箱根目录（默认启动目录；防目录穿越） |
| `PORT` | 服务端口（默认 3000） |

## 项目结构

```
web-agent/
├─ kernel/        # 内核 6 大件（薄）：bus / config / trace / cache / plugin-loader / scope ← 内部，唯一不变
├─ core/          # 核心插件（同样走插件机制）
│  ├─ chat/       #   Agent 执行器 + 自研 OpenAI 兼容流式客户端
│  ├─ tools-fs/   #   文件工具（沙箱 + 编码识别 + L2 缓存）
│  ├─ search/     #   联网搜索（Tavily / DuckDuckGo 降级 + 可选代理）
│  ├─ memory/     #   长期记忆（before_llm 钩子自动注入，跨会话）
│  ├─ goal-plan/  #   多步目标计划模式
│  ├─ powershell/ #   PowerShell 执行器（危险命令审批）
│  ├─ academic/   #   ★ 学术智能体接线（ARS 路由 persona）
│  ├─ skills/     #   技能系统（内置 + 技能包 + 用户；list/get/get_skill_file）
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
