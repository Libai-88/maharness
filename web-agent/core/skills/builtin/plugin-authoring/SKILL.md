---
name: plugin-authoring
description: maharness 插件契约。创建工具、服务、命令、上下文、事件、角色、Provider 或任务面板时按需读取。
triggers:
  - 创建插件
  - 修改插件
applies-when:
  - 需要创建或修改插件
reject-when:
  - 现有能力已足够且无需扩展
input: 目标能力、接口、权限和生命周期
output: v3 插件源码与可核对的运行结果
---

# 插件契约

## 任务内开发

plugin_status 查看有效开发授权、任务版本和工作区可复用插件；plugin_status({sdk:true}) 按需读取 SDK 接口和最小示例，支持 offset/limit 分页。create_plugin 创建候选，enable_plugin 执行源码、manifest、类型与隔离试运行验证后激活。下一次模型请求通过 discover_capabilities 查找任务能力，再用 enable_capabilities 加载对应工具；直接工具目录继续使用 discover_tools/enable_tools。disable_plugin 释放任务实例；release_tools 仅释放后续输入中的工具 schema。

开发授权默认关闭，由用户在工作区设置中开启。工具权限和外部依赖不能超过授权；无法自行批准依赖、改变权限或替换系统运行服务。候选失败保留活动旧版。任务结束清理运行资源，用户显式保存确定哈希后才可跨任务复用。

create_plugin 可以接收 source 字符串，或多文件 files 与 manifest：

```json
{
  "id": "word-count",
  "files": { "index.ts": "默认导出的插件源码", "helper.ts": "本地纯函数" },
  "manifest": {
    "apiVersion": 3,
    "id": "word-count",
    "name": "Word count",
    "version": "1.0.0",
    "entry": "index.ts",
    "permissions": { "capabilities": { "tool": ["count_words"] } },
    "capabilityIndex": [{
      "id": "text.count-words",
      "name": "统计词数",
      "description": "统计文本中的空白分隔词数量。",
      "tools": ["count_words"],
      "aliases": ["字数", "词数"],
      "inputs": ["text"],
      "outputs": ["count"],
      "risk": "low",
      "sideEffect": "none"
    }]
  }
}
```

插件对象：

```ts
export default {
  id: 'word-count', name: 'Word count', version: '1.0.0',
  onLoad(ctx: import('../../kernel/types').PluginContext) {
    ctx.register({ kind: 'tool', tool: {
      name: 'count_words', version: '2.0.0', description: 'Count whitespace-separated words.',
      permissions: [], sideEffect: 'none',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      outputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
      async handler(args: unknown) {
        const { text } = args as { text: string };
        return { ok: true, data: { count: text.trim().split(/\s+/).filter(Boolean).length } };
      },
    } });
  },
};
```

id 使用小写字母、数字和连字符，最多 32 字符。源码文件使用插件内相对路径，不传 plugin.json。可导入本地模块与明确批准的包；SDK 类型用 ../../kernel/types 的 type import，不导入宿主实现或其他插件内部文件。纯工具可从 source 推导 manifest，其他能力使用完整清单。`capabilityIndex` 只能引用 `permissions.capabilities.tool` 已授权工具；v2 清单通过兼容适配层运行，但不能声明能力索引。

## 能力和调用入口

| kind | 定义 | 使用 |
| --- | --- | --- |
| tool | tool: ToolDef | 原生工具调用；按需 discover_capabilities/enable_capabilities，或 discover_tools/enable_tools |
| service | service: {id,instance} 或 ctx.provide(key,value) | ctx.inject(key).value；onChange 回调观察依赖变化 |
| context | context: {id,description,contentFn} | 每次模型请求重新求值，作为临时参考材料 |
| listener | {event,listener} | 任务事件总线；ctx.bus.emit/emitAsync 发射 |
| command | command: {name,description,handler(args:string[])} | invoke_plugin kind=command、name、args |
| role | role: {id,name,description,systemPrompt,tools?} | invoke_plugin kind=role、name、objective，创建统一子任务 |
| provider | provider: {id,label,defaultModel,chat} | invoke_plugin kind=provider、name、model、messages；不切换主任务模型 |
| persona | persona: {id,name,description,content} | 可发现材料，plugin_status 按文件范围读取；不会自动加入 system |
| api | api: {mount,router} | 带任务身份的 API；mount=panel 返回 {title,html} 时诊断可查看 |

permissions.capabilities 按 kind 声明实际名称。requires 是先启用的插件 id 数组；依赖使用当前任务的活动版本。ctx.inject、ctx.on、ctx.watchConfig、ctx.configWith、ctx.register 均受插件资源作用域管理。插件 Provider 的显式请求经模型账本记录；角色委派及网络请求需要相应授权。

## 调用现有工具

组合工具声明 invokesTools=true，在 handler 内使用 tctx.invoke(name,args)。permissions 包含全部叶工具所需权限；未授权工具不可调用。每个叶调用仍受自身参数、审批、取消、资源和副作用规则约束。外层工具的批准不会批准叶调用。

```ts
// 组合工具的 handler；ToolDef 另声明 invokesTools:true、permissions:['workspace.read']。
async function handler(_args: unknown, tctx: import('../../kernel/types').ToolContext) {
  if (!tctx.invoke) return { ok: false, error: '宿主工具代理不可用' };
  return tctx.invoke('read_file', { path: 'README.md' });
}
```

不直接调用从注册表获得的 handler，不直接导入宿主文件、进程或网络模块。业务动作在工具 handler 中执行，onLoad/onStart 只注册能力与受管理资源。失败使用稳定 failure.code、retryable 与 outcome；结果未知保留 unknown，不能盲目重试。

## 资源与持久性

ctx.resources.interval/timeout 注册计时器，defer 注册清理函数。任务结束、停用和版本释放会回收已登记资源。ctx.storage 保存实例私有数据；默认 keep，也可声明 cleanup=archive/purge。框架只管理登记过的资源，不保证撤销任意 JavaScript 行为。文件、数据库和外部请求的已发生影响不随卸载撤销。

完整类型插件运行在可信宿主中；execution.mode=process 只适用于 tool 插件。两者都不是 OS 级安全隔离。不要在生命周期函数中做外部业务写入或读取生产凭据。

## 实例插件

用户管理员安装的实例插件位于 plugins/<id>/，由 plugin.json 与入口源码组成。脚手架与校验：

```sh
node scripts/plugin-scaffold.mjs create my-plugin
node scripts/plugin-scaffold.mjs validate plugins/my-plugin
```

实例插件可贡献 panel、iframe 或受信任的 module 页面，入口位于设置的高级区域，不增加主导航。plugins/ 受目录监听；core/ 内置插件需显式重载或重启；vendor/ 是技能材料。实例级的循环、缓存等服务替换由管理员配置，不属于任务生成插件的授权。
