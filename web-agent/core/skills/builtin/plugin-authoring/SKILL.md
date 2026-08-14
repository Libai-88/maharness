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

## 关键要点
- **工具名**：小写字母/数字/下划线，语义清晰；
- **结果**：成功 `{ ok: true, data }`；失败 `{ ok: false, error }`（error 会原样回给 LLM 供修复）；
- **审批**：破坏性操作返回 `{ ok: false, needsApproval: true, approvalSummary: '说明' }`，批准后带 `tctx.approved=true` 重试；
- **缓存**：结果稳定可缓存（如读文件）用 `tctx.cache`（makeKey/l2Get/l2Set）；易变数据（如当前时间）不要缓存；
- **persona**：`kind:'persona'` 注册行为规则（priority 越大越靠前），随插件启停自动增减；
- **listener**：`ctx.bus.on(...)` 订阅事件（`agent.*` 钩子、`plugin.*` 生命周期等），**保存返回的 off 句柄并在 `onUnload` 中调用**（防热重载监听器泄漏）；
- **钩子**：`agent.before_llm`（改写 history 注入上下文）、`agent.before_tool`（参数改写/拦截）等，见 ARCHITECTURE 4.3。

## 禁则
- 不修改 `kernel/` 与 `core/`（内部核心保持不变）；
- 不直接 import 其它插件的内部实现（通过 bus 事件与 capability 通信）；
- 路径类操作必须走 `resolveInSandbox`（沙箱校验）。
