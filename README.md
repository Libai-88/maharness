# Web Agent —— 自研 Windows 原生网页版 Agent

> **薄内核 · 全插件化 · 全程可观测 · 高缓存命中**
> 除内核运行必备外，一切能力均为可插拔组件：**现场写、现场加载、现场启停**。

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
# 1. 安装依赖
cd web-agent
npm install
cd ui && npm install && cd ..

# 2. 配置 LLM（至少一组 OpenAI 兼容 Provider）
copy .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY（或 OPENAI_API_KEY 等）

# 3. 启动
npm run dev          # 后端 http://localhost:3000
# 前端开发模式（热更新）：另开终端 npm run ui:dev → http://localhost:5173
```

浏览器打开 **http://localhost:3000** 即可使用。

## 使用

- **对话**：输入消息，Enter 发送。Agent 会自动调用工具（读文件/写文件/列目录）并展示执行过程。
- **模型切换**：右上角下拉切换已配置的 Provider 模型（DeepSeek/OpenAI/通义…）。
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

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `DEEPSEEK_BASE_URL/API_KEY/MODEL` | DeepSeek Provider（任意命名，自动发现） |
| `OPENAI_BASE_URL/API_KEY/MODEL` | OpenAI Provider |
| `<NAME>_PRICE_IN/OUT` | 可选：覆盖价格（USD/百万 token，用于成本核算） |
| `EMBEDDING_BASE_URL/API_KEY/MODEL` | 可选：激活 L1 语义缓存 |
| `SANDBOX_ROOT` | 文件工具沙箱根目录（默认启动目录；防目录穿越） |
| `PORT` | 服务端口（默认 3000） |

## 项目结构

```
web-agent/
├─ kernel/        # 内核 5 大件（薄）：bus / config / trace / cache / plugin-loader
├─ core/          # 核心插件（同样走插件机制）
│  ├─ chat/       #   Agent 执行器 + 自研 OpenAI 兼容流式客户端
│  └─ tools-fs/   #   文件工具（沙箱 + 编码识别 + L2 缓存）
├─ plugins/       # ★ 现场插件目录（热加载）
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
- [ ] search 插件（联网搜索，Tavily / DuckDuckGo 降级）
- [ ] memory 插件（长期记忆）
- [ ] powershell 插件（Windows Shell 能力）
- [ ] 系统托盘 / 开机自启
