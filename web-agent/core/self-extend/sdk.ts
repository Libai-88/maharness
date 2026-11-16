import { taskPluginExamples } from './examples';
/** On-demand reference material; never appended automatically to system instructions. */
export const taskPluginSDK = `# Task plugin SDK v2

create_plugin({id, source}) stages a TypeScript index.ts; full/multi-file plugins use {id,files:{"index.ts":source,"helper.ts":source},manifest}.
manifest={apiVersion:2,id,name,version:"1.0.0",entry:"index.ts",permissions:{capabilities:{tool:["tool_name"]}}}.
Capabilities use kind/name declarations: tool.tool.name, command.command.name, service.service.id, context.context.id, role.role.id, provider.provider.id, persona.persona.id, api.api.mount, listener.event.
enable_plugin({id}) validates and returns registered capability identifiers. Small catalogs expose tools directly on the next request; when discover_tools is present, it finds hidden tools and enable_tools exposes their schemas. disable_plugin({id}) releases the instance. Requires/permissions are not expanded automatically.

Examples: plugin_status({example:'tool'}) returns a complete tested source and manifest.
Available examples: ${taskPluginExamples.map(item => item.id).join(', ')}.

## Plugin lifecycle and context
Plugin={id:string,name:string,version:string,onLoad?(ctx),onStart?(ctx),onStop?(ctx),onUnload?(ctx)}.
Use onLoad/onStart to register capabilities/resources, not external business effects. PluginContext has:
ctx.register(capability) -> unregister(); ctx.provide(key,value,priority?) -> remove();
ctx.inject(key,onChange?) -> {value:unknown,stop()}; ctx.on(event,listener,priority?) -> off();
ctx.bus.emit({type,ts:Date.now(),data}); emitAsync; serial; bail; parallel; waterfall;
ctx.storage.read(name) -> string|null; write(name,string); list(); remove(name);
ctx.resources.interval(()=>void,milliseconds), timeout, defer(()=>void|Promise<void>), each returns cancel().
ctx.config.get(key,default); ctx.configWith(values); ctx.watchConfig(key,callback).
No raw filesystem/process/network/host implementation imports. Pure local modules may import './helper'; type imports from '../../kernel/plugin-sdk' are supported. Only user-approved installed external dependencies are available.
manifest.requires=['base-plugin'] orders scoped dependencies. ctx.inject('service:prices') resolves a registered service; ctx.provide('prices',value) instead uses the exact key 'prices'. Reserved runtime services cannot be replaced in run scope.

command handler may return string or Promise<string>; optional second argument has signal. Command execution defaults to 30s; command.timeoutMs overrides it. Role/provider calls default to 240s. Cancellation is cooperative for trusted host JavaScript. invoke_plugin({kind:'command',name:'upper',args:['ready']}) invokes it.
invoke_plugin({kind:'role',name:'review',objective:'...'}): managed child run, requires delegate grant.
invoke_plugin({kind:'provider',name:'local',model:'local',messages:[{role:'user',content:'...'}],maxTokens:2048}): explicit request through the model ledger, requires network grant, does not switch the main model.
Context is ephemeral reference material recomputed before each request. Persona is optional reference material, not auto-inserted instructions. GET /api/v2/runs/:runId/plugins/:pluginId/api/panel returns a live panel; UI sanitizes HTML. Services/events are available inside the task, not globally.

## Host tool composition
ToolDef may declare invokesTools:true. Its handler uses tctx.invoke('read_file',{path:'README.md'}), not raw tool handlers.
ToolDef.permissions must include all leaf tool permissions (workspace.read/workspace.write/network/process/delegate as authorized). Every leaf gets separate validation, approval, cancellation, execution leases and effect journal. Outer approval is not inherited. ToolContext has runId,parentRunId,sandboxRoot,authorization,signal,remainingBudget and optional delegate.
Success: {ok:true,data,evidence?}. Failure: {ok:false,error,failure:{code,retryable,outcome:'not_started'|'applied'|'unknown'}}. Unknown outcomes must not be blindly repeated.
Generated plugins are trusted JavaScript. Run scope and the tool-only process mode are not OS isolation. Use managed resources; disposal does not undo external changes.
ToolContext.invoke is available in trusted host execution; process-mode plugins cannot declare invokesTools because callbacks do not cross IPC.
`;
