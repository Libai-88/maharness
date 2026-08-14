# maharness 架构设计文档（v1）

> 版本：v1.1（2026-08-14）
> 定位：从 0 自研的 Windows 原生网页版 Agent。**只有内外之分**：内部是唯一保持不变的 Agent 核心（kernel/），其余一切能力为可插拔组件（外部）。
> 原则：不用任何现成 agent 框架（LangChain/CrewAI/AutoGen 等）；极简高效；运行全程可观测；高缓存命中；创新自研；**万物都是插件，agent 可以自己定义自己**。

---

## 1. 设计信条

| # | 信条 | 含义 |
| --- | --- | --- |
| 1 | 内核极薄 | 内核只做 5 件事：事件总线、插件加载、配置、轨迹观测、缓存。**连"对话"都是插件** |
| 2 | 一切可插拔 | 能力层全部为插件：现场写、现场加载、现场启停，不重启内核 |
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
│   goal-plan(目标计划) · powershell(Shell) ·          │
│   self-extend(自我扩展：agent 自建插件) · memory ...  │
├────────────────────────────────────────────────────┤
│ 内核 Kernel（运行必备，仅 5 大件）                   │
│   EventBus  事件总线（一切通信走总线）                │
│   PluginLoader  插件加载与热管理                     │
│   Config  分层配置（defaults→文件→env→运行时）       │
│   Trace  轨迹观测（事件采集/环形缓冲/审计落盘）       │
│   Cache  三层缓存（语义/工具结果/prompt前缀）         │
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

### 3.2 PluginLoader（插件加载与热管理）

**插件形态**：`plugins/<name>/` 目录 = 一个插件，含：
- `plugin.json`：清单（见 3.2.1）
- 入口文件（默认 `index.ts`，经 tsx 动态加载）

**状态机**：`registered → loaded → started → stopped → unloaded`
- `loaded`：清单解析、依赖检查、动态 import 入口、调用 `onLoad` 注册能力
- `started`：调用 `onStart`，开始对外服务
- 热管理命令：`enable / disable / reload`，均不重启内核
- 文件监听：插件目录变化（新增/修改/删除）触发 `reload`，实现"现场写、现场加载"

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

**数据模型**（append-only，只增不改）：

```
TraceSession(traceId)
 └─ Turn(第 N 轮)
     ├─ Step: llm_call   （模型、prompt 摘要、tokens、成本、耗时）
     ├─ Step: tool_call  （工具、参数摘要、结果摘要、耗时、缓存标记）
     └─ Step: cache_hit  （缓存层、键、节省成本）
```

**每步记录字段**：类型 / 开始时间 / 耗时 / 输入摘要（截断）/ 输出摘要（截断）/ tokens(in,out) / 成本估算 / 缓存键 / 状态。

**三态输出**：
1. 实时推送：SSE 推送到前端 Trace 面板（DevTools 风格流水，含耗时与成本条）
2. 审计落盘：`data/traces/YYYY-MM-DD.jsonl` 全量结构化日志
3. 内存环形缓冲：最近 1000 条，供调试接口查询

**成本模型**：每个 provider 声明 `inputPrice / outputPrice`（每百万 token 单价），Trace 自动算成本。缓存命中时按"若未命中将发生的成本"计入节省。

### 3.5 Cache（三层缓存）

| 层 | 名称 | 键 | 命中条件 | 失效策略 |
| --- | --- | --- | --- | --- |
| L1 | 语义缓存 | 规范化问题文本 → embedding 向量 | 与历史问题余弦相似度 ≥ 0.95 | 手动清空；LLM 版本升级时清空 |
| L2 | 工具结果缓存 | `hash(工具名 + 规范化参数)`；文件类追加 `mtime+size` | 键相同且未失效 | 文件 mtime/size 变化；TTL；显式失效 |
| L3 | prompt 前缀缓存 | 无显式键——**靠消息组装策略** | 依赖 provider 原生 KV cache | 由 provider 管理 |

**L3 设计要点（高命中关键）**：保持 system prompt 字节级稳定；历史消息按"只追加不重写"策略组装（同一会话内，旧消息序列不变）；多轮工具结果不回写历史。这样 provider 侧 KV cache 前缀复用最大化，DeepSeek/OpenAI 的 context caching 均吃满。

**缓存统计**：命中次数、节省 token、节省成本、命中率，全部进入 Trace 并在面板展示。缓存"是什么、为什么命中"永远可查。

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
  handler(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}
```

- 工具由任意插件通过 `ctx.register('tool', toolDef)` 注册，Agent 执行器只认注册表，不认识具体工具 —— **新工具=现场写插件**。
- 工具执行统一包裹：超时（默认 30s）、错误捕获（错误文本返回给 LLM 而非中断会话）、Trace 记录、L2 缓存查询/写入。

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

### 4.4 上下文管理（超预算优雅降级）

- 会话历史按预算（默认 30000 tokens，config `context.maxTokens`）估算（中文 ≈1 token/字，英文 4 字符/token）。
- 超预算时保留 system 提示与最新消息，丢弃较早消息并注入「【上下文管理】已截断 N 条」说明（LLM 对截断有感知）；截断作为 `system` 类型步骤记入 Trace。
- 位置：`server/context.ts`（纯函数），在会话历史组装后、进入 Agent 循环前执行。

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

- 文件类工具锚定根目录 = 当前工作区（`D:\DEEPSEEK`，用户 2026-08-14 确认开发阶段沙箱限制在当前工作区；config 可调整），所有路径先规范化（盘符/大小写/`..`）再校验必须在根目录内，防目录穿越。
- 写入工具拒绝符号链接指向沙箱外；只读操作默认允许，写操作逐项审计入 Trace。
- 工具参数只接受 JSONSchema 声明字段（防注入）。

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
| POST | `/api/sessions/:id/chat` | SSE 流式对话 |
| GET | `/api/files?path=` | 沙箱内目录浏览 |
| GET | `/api/files/read?path=` | 读文件（自动编码识别） |
| POST | `/api/files/write` | 写文件（沙箱校验） |
| GET | `/api/plugins` | 插件列表与状态 |
| POST | `/api/plugins/:id/actions` | `enable/disable/reload` |
| GET | `/api/trace?session_id=` | 查询轨迹（环形缓冲/落盘） |
| GET | `/api/events` | 全局事件 SSE（前端实时面板） |

**chat SSE 事件流**：`turn.started` → `message.delta`(文本增量) → `tool.started` → `tool.delta`(工具输出增量) → `tool.done` → `message.done` → `turn.done` → `done`（含汇总：tokens/成本/缓存命中）。任意时刻 `stop` 可中断。

---

## 8. 前端（Web UI 插件）

- Vite + React + TypeScript，ChatGPT 式布局：左侧会话列表 + 插件面板 Tab，中部对话区，右侧可折叠 Trace 流水面板。
- 组件：`ChatView`（流式渲染、工具调用卡片、中断按钮）、`SessionList`、`ModelPicker`、`PluginPanel`（插件启停/重载/状态）、`TracePanel`（实时流水+成本）、`FileExplorer`（沙箱文件浏览，v1 轻量版）。
- 插件面板即"现场管理启停"的入口：列表显示所有插件、状态、版本，一键 enable/disable/reload。

---

## 9. 目录结构

```
web-agent/
├─ package.json / tsconfig.json / .env.example
├─ README.md
├─ docs/ARCHITECTURE.md          ← 本文档
├─ kernel/                        ← 内核 5 大件（薄）
│  ├─ index.ts  types.ts  bus.ts  config.ts
│  ├─ plugin-loader.ts  trace.ts  cache.ts
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

## 11. 现场写插件示例（开发范式）

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
    ctx.register('tool', {
      name: 'get_current_time',
      description: '获取当前日期时间（Windows 本地时区）',
      parameters: { type: 'object', properties: {} },
      async handler() {
        return { ok: true, data: new Date().toLocaleString('zh-CN') };
      },
    });
  },
} satisfies Plugin;
```

保存文件 → 内核监听插件目录 → 自动 reload → 网页面板看到新工具 → Agent 立刻能调用。**无需重启、无需改任何既有代码**。
