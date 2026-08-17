---
name: plugin-authoring
description: maharness 插件契约速查。需要创建新插件（新工具/新命令/新能力）时使用，保证一次写对。
---

# 插件编写契约（速查）

## 结构
```
plugins/<id>/
├── plugin.json   # { id, name, version, entry: "index.ts", enabled: true }
└── index.ts      # 默认导出 Plugin 对象
```

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
- **listener**：优先用 `ctx.on(event, cb)`（自动退订）；旧 API `ctx.bus.on(...)` 需保存 off 句柄并在 `onUnload` 中调用（防热重载监听器泄漏）；
- **钩子**：`agent.before_llm`（改写 history 注入上下文）、`agent.before_tool`（参数改写/拦截）等，见 ARCHITECTURE 4.3。

## 热重载契约（重要，v3.1+）
- **配置/环境变量依赖必须显式声明**：`ctx.watchConfig('agent.thinkInEnglish', cb)`、`ctx.watchEnv('TAVILY_API_KEY', cb?)`——声明后配置/.env 变更会自动触发依赖驱动重载（reloadChanged），插件重跑 onLoad 拿到新值；
- **在 onLoad/onStart 函数体内读取配置与 env，禁止做成模块顶层常量**——当前运行时（tsx）复用旧模块记录（hash busting 失效），顶层常量在 reload 后仍是旧值；onLoad 内读取则每次重载都拿到当前值；
- 文件内容维度的热重载在 tsx 下可能不生效：改动插件代码后若未生效，请重启进程（dev 用 `tsx watch` 自动重启）。

## 禁则
- 不修改 `kernel/` 与 `core/`（内部核心保持不变）；
- 不直接 import 其它插件的内部实现（通过 bus 事件与 capability 通信）；
- 路径类操作必须走 `resolveInSandbox`（沙箱校验）。
