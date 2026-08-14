# maharness —— 自研 Windows 原生网页版 Agent

> **薄内核 · 全插件化 · 全程可观测 · 高缓存命中 · agent 可以自己定义自己**
> 只有内外之分：内部是唯一不变的 Agent 核心（kernel/）；其余一切能力均为可插拔组件——**现场写、现场加载、现场启停**。

## 设计理念（详见 `docs/ARCHITECTURE.md`）

| 信条 | 实现 |
| --- | --- |
| 内核极薄 | 内核仅 5 大件：EventBus / PluginLoader / Config / Trace / Cache，**连对话都是插件** |
| 一切可插拔 | `plugins/` 目录现场写插件，保存即热加载，网页面板一键启停 |
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
npm run dev:all      # 开发模式：后端 :3000 + 前端 :5173（热更新）
# 或
npm run start:all    # 生产模式：构建前端后单端口启动 → http://localhost:3000
```

浏览器打开 **http://localhost:3000**（生产模式）或 **http://localhost:5173**（开发模式）即可使用。

## 使用

- **对话**：输入消息，Enter 发送。Agent 会自动调用工具（读文件/写文件/列目录）并展示执行过程。
- **模型切换**：右上角下拉切换已配置的 Provider 模型（DeepSeek/OpenAI/通义…）。
- **会话模式**：右上角切换 普通 / 计划 / 目标。计划模式先出计划、确认后执行；目标模式自动建计划推进。
- **斜杠命令**：输入 `/` 开头的消息直接执行命令（不消耗 LLM）——`/help` 全部命令、`/new` 新会话、`/clear` 清空、`/plan` `/goal` `/normal` 切模式、`/model <名称>` 切模型。
- **上下文管理**：会话历史超出预算（默认 30000 tokens，`context.maxTokens` 可调）时自动截断较早消息并注入说明，全程在轨迹面板可见。
- **插件面板**：左侧「插件」Tab —— 查看所有插件状态，一键启用/停用/重载。
- **运行轨迹**：右上角「运行轨迹」—— 实时显示每次 LLM 调用与工具执行的耗时、token、成本、缓存命中（黑箱解药）。

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
├─ kernel/        # 内核 5 大件（薄）：bus / config / trace / cache / plugin-loader ← 内部，唯一不变
├─ core/          # 核心插件（同样走插件机制）
│  ├─ chat/       #   Agent 执行器 + 自研 OpenAI 兼容流式客户端
│  ├─ tools-fs/   #   文件工具（沙箱 + 编码识别 + L2 缓存）
│  ├─ search/     #   联网搜索（Tavily / DuckDuckGo 降级 + 可选代理）
│  ├─ memory/     #   长期记忆（before_llm 钩子自动注入，跨会话）
│  ├─ goal-plan/  #   多步目标计划模式
│  ├─ powershell/ #   PowerShell 执行器（危险命令审批）
│  └─ self-extend/#   ★ 自我扩展（agent 可自建插件，定义自己）
├─ plugins/       # ★ 现场插件目录（热加载；Agent 自我扩展的落点）
├─ server/        # Express + SSE API
├─ ui/            # React + Vite 前端
├─ data/          # SQLite 会话存储 + traces/ JSONL 审计日志
└─ docs/          # 架构设计文档
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
