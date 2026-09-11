---
name: plugin-authoring
description: maharness 插件契约速查。需要创建新插件（新工具/新命令/新能力/新前端页面）时使用，保证一次写对。
---

# 插件编写契约（速查）

## 结构
```
plugins/<id>/
├── plugin.json   # { id, name, version, entry: "index.ts", enabled: true }
└── index.ts      # 默认导出 Plugin 对象
```

## 接管内核与替换执行循环（v3.3：一切皆插件）
内核子系统与 agent 执行循环都以**服务**形式提供，插件可用更高优先级接管——这是
「内核不垄断实现」的机制入口。接管用 `ctx.provide(key, value, priority)`：**大者胜**，
同优先级先到者胜（后到者不静默顶掉）；接管者卸载后**自动回退**到次高者/内核内置实现。

| 服务键 | 内容 | 接管用途示例 |
|---|---|---|
| `service:runner` | **Agent 执行循环工厂** `(kernel, bus) => { run(opts), approveApproval }` | 换成 ReAct / Reflexion / 规划-执行两段式；顶层对话、子代理、并行**三条路径同时生效** |
| `service:cache` | 三层缓存 | 换 L1 相似度算法 / 接外部向量库 |
| `service:trace` | 可观测性 | 换 Trace 后端 / 导出到外部系统 |
| `service:budget` | 认知资源管理 | 换配额与任务画像策略 |

```ts
// 例：用自定义循环整体替换默认循环
import type { RunnerFactory } from '../../kernel/loop';
const myLoop: RunnerFactory = (kernel, bus) => ({
  async *run(opts) { yield { type: 'delta', text: '…' }; /* … */ },
  approveApproval: () => true,
});
export default {
  id: 'my-loop', name: '我的循环', version: '0.1.0',
  onLoad: (ctx) => { ctx.provide('service:runner', myLoop, 10); }, // priority > 0 即接管
};
```
循环契约形状（`AgentEvent` / `RunOptions` / `AgentLoop`）定义在 `kernel/loop.ts`——
实现必须满足它，但形态由你决定。取循环用 `makeRunner(kernel, bus)`（无提供者时返回
undefined，调用方应降级报错而不是崩溃）。

## 前端页面贡献（声明式：插件在前端拥有自己的一页）
不必改前端一行代码：在 `plugin.json` 声明 `nav`，前端遍历 `GET /api/nav` 自动生成标签页。

```json
{
  "id": "my-plugin", "name": "我的插件", "version": "0.1.0", "entry": "index.ts",
  "nav": { "label": "我的页面", "icon": "box", "order": 50, "mode": "iframe", "page": "/page" }
}
```
- **mode:'iframe'**：插件提供完整 HTML 页面（`page`，缺省 `/page`）——脚本/交互完整保真，
  适合看板、工作台这类富交互应用；路径 = `/api/plugins/<id>/<mount><page>`；
- **mode:'panel'**：插件返回 `{ title, html }` 片段（`panel`，缺省 `/panel`）——前端净化后内联渲染；
- **前置条件**：插件必须注册 `api` 能力（页面要有数据通道）；未注册则不出现在导航里（不产出死页面）；
- **状态条（可选）**：`status` 指向一个返回 `{ text, detail?, connected? }` 的端点，
  前端通用轮询并显示在页头——**插件无需为了"在页头展示状态"而让前端为它写组件**；
- 插件停用/卸载 → 标签页自动消失（与能力可见性同一规则）；`icon` 名见前端图标表，未知名回落通用图标。

## 配置 schema（可选，v3.2）
`plugin.json` 可声明 `config` 字段（JSONSchema 子集，与工具 outputSchema 同一校验引擎）：
```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "0.1.0",
  "entry": "index.ts",
  "config": {
    "type": "object",
    "properties": { "maxRetries": { "type": "integer", "minimum": 1 } },
    "required": ["maxRetries"]
  }
}
```
- 声明后，`onLoad` 前用 `config.<id>.*` 的当前值机器校验，不合规 → 注册失败/热重载回滚（配置错误在进入插件逻辑前暴露）；
- 支持子集：`type` / `properties` / `required` / `items` / `enum` / `minimum` / `maximum` / `minLength` / `maxLength`；超出子集的声明按「不校验」处理。

## 服务能力（可选，v3.2）
需要对外暴露服务实例（供 `resolveService('service:<id>')` 与其它插件 `inject`）时，可继承内核 `Service` 基类（构造即注册、卸载自动撤销）：
```ts
import { Service } from '../../kernel';
class MyService extends Service {
  constructor(ctx) { super(ctx, 'my-service'); }  // 自动 register service capability
  hello() { return this.configGet('greeting', 'hi'); } // config.my-service.greeting
}
```

## 契约
```ts
import type { Plugin } from '../../kernel/types';

export default {
  id: 'my-plugin',
  name: '我的插件',
  version: '0.1.0',
  onLoad(ctx) {
    ctx.register({
      kind: 'tool',          // tool | persona | listener | command | service
      tool: {
        name: 'my_tool',
        description: '给 LLM 看的能力说明（说清何时用、参数含义）',
        parameters: { type: 'object', properties: { ... }, required: [...] }, // JSONSchema
        async handler(args, tctx) {
          return { ok: true, data: { ... } };   // 或 { ok: false, error: '原因' }
        },
      },
    });
  },
} satisfies Plugin;
```

## 组合设计（可组合的工具 = 1+1>2）
- **描述说清输入/输出/限制**：`output` 字段声明返回结构（如 `{path, entries[]}`）、
  `limits` 声明限制、`risk`/`costHint`/`approval` 声明风险成本——组合链里 harness 才能正确判断审批与成本；
- **输入复用现有格式**：路径就用沙箱相对路径（list_dir/read_file 可直接接力）；
- **输出结构化**：JSON 结果让下游工具与 LLM 直接消费，别用散文；
- **互相引用**：描述里提一句相关工具（如"配合 read_file 使用"），LLM 编排时更易成链；
- 完整组合范式见 `get_skill("capability-composition")`。

## 关键要点
- **工具名**：小写字母/数字/下划线，语义清晰；
- **结果**：成功 `{ ok: true, data }`；失败 `{ ok: false, error }`（error 会原样回给 LLM 供修复）；
- **审批**：破坏性操作返回 `{ ok: false, needsApproval: true, approvalSummary: '说明' }`，批准后带 `tctx.approved=true` 重试；
- **缓存**：结果稳定可缓存（如读文件）用 `tctx.cache`（makeKey/l2Get/l2Set）；易变数据（如当前时间）不要缓存；
- **persona**：`kind:'persona'` 注册行为规则（priority 越大越靠前），随插件启停自动增减；
- **listener**：用 `ctx.on(event, cb)` 订阅（卸载自动退订）；`ctx.bus` 只提供发射与派发（emit/serial/waterfall 等），**不提供订阅**——裸监听会绕过 EffectScope，卸载后残留；
- **钩子**：`agent.before_llm`（改写 history 注入上下文）、`agent.before_tool`（参数改写/拦截）等，见 ARCHITECTURE 4.3。

## 热重载契约（重要，v3.4+）
- **配置/环境变量依赖必须显式声明**：`ctx.watchConfig('agent.thinkInEnglish', cb)`、`ctx.watchEnv('TAVILY_API_KEY', cb?)`——声明后配置/.env 变更会自动触发依赖驱动重载（reloadChanged），插件重跑 onLoad 拿到新值；
- **代码改动自动生效，多文件组织不受限**：插件目录按内容取快照后加载（`kernel/plugin-snapshot.ts`），入口或其依赖文件的内容变化都会触发模块图重建——无需重启进程；
- 建议仍在 onLoad/onStart 函数体内读取配置与 env：语义上更明确地表达"每次启动重新求值"，也便于他人阅读；
- 插件目录体积上限 8 MB（只计源码文件之外的资源也计入）：超限时退化为仅入口级热重载，日志会告警。

## 禁则
- 不修改 `kernel/` 与 `core/`（内核与内置插件是稳定基座；要改行为请用上面的接管机制）；
- 不直接 import 其它插件的内部实现（通过 bus 事件与 capability 通信）；
- 路径类操作必须走 `resolveInSandbox`（沙箱校验）。

## 可逆性契约：界内可逆 / 界外补偿（重要）
「卸载即恢复」有一个**明确的边界**——搞清它才不会写出泄漏的插件：

**界内（运行时自动回滚，你什么都不用做）**：用 `ctx.*` 做的一切副作用——
能力注册、事件订阅、服务绑定、配置 override、env 订阅。作用域按 LIFO 逆元栈在
卸载/停用时完全恢复，`plugin.reverted` 事件会报告回滚了几项。
结论：**优先用 `ctx.*` 而不是手工管理**（不要自己 `bus.on` 再手动 off、不要自己写
清理清单——那是"靠作者勤勉"，运行时不该依赖它）。

**界外（运行时无法回滚，必须自备补偿）**：已发生的对外影响——写入的文件、入库的数据、
发出的网络/LLM 请求、启动的子进程、注册到外部系统的 webhook。
运行时不会撤销它们（撤销真实世界的写入本就不该自动发生）。约定：
- 插件自建的资源请在 `onUnload`/`onStop` 中显式收尾（进程/文件句柄/定时器）；
- 插件自有的持久化数据一律写 `ctx.storage`（目录 `<data>/plugins/<插件 id>`，内核创建、插件独占）：
  `ctx.storage.write('state.json', json)` / `read` / `list` / `remove`。
  在 `plugin.json` 声明 `cleanup: 'keep' | 'archive' | 'purge'`（默认 keep）即可让内核在
  彻底卸载时按策略处理这份数据；不要再往 `ctx.paths.data` 根目录或插件代码目录写数据；
- **不可逆的对外动作请登记**：`ctx.outbound.record({ kind: 'file' | 'http' | 'db' | 'proc', detail })`——
  运行时把它们追加到 `<data>/outbound/<插件 id>.jsonl` 并广播事件；卸载摘要
  （`plugin.reverted`）会带上本次生命周期的条数。登记不改变不可逆性，但让「它动过什么」可枚举；
- `ctx.effect(fn, makeInverse)` 用于「界内登记 + 界外补偿」的组合场景：
  callback 做正向效果并返回其补偿函数，运行时保证补偿在卸载时执行一次（幂等）。
