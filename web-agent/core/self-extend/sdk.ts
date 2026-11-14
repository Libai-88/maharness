/** On-demand reference material; never appended automatically to system instructions. */
export const taskPluginSDK = `# Task plugin SDK v2

create_plugin({id, source}) stages a TypeScript index.ts; full/multi-file plugins use {id,files:{"index.ts":source,"helper.ts":source},manifest}.
manifest={apiVersion:2,id,name,version:"1.0.0",entry:"index.ts",permissions:{capabilities:{tool:["tool_name"]}}}.
Capabilities use kind/name declarations: tool.tool.name, command.command.name, service.service.id, context.context.id, role.role.id, provider.provider.id, persona.persona.id, api.api.mount, listener.event.
enable_plugin({id}) validates and activates; discover_tools({query:"name"}) finds tools; enable_tools({names:["name"]}) exposes schemas in the next request. disable_plugin({id}) releases the instance. Requires/permissions are not expanded automatically.

## Minimal tool source
export default {
 id:'calculator', name:'Calculator', version:'1.0.0',
 onLoad(ctx: import('../../kernel/types').PluginContext) {
  ctx.register({kind:'tool',tool:{
   name:'sum_values',version:'2.0.0',description:'Sum numeric values.',permissions:[],sideEffect:'none',
   parameters:{type:'object',properties:{numbers:{type:'array',items:{type:'number'}}},required:['numbers']},
   outputSchema:{type:'object',properties:{sum:{type:'number'}},required:['sum']},
   async handler(args:unknown){const {numbers}=args as {numbers:number[]};return {ok:true,data:{sum:numbers.reduce((a,b)=>a+b,0)}};}
  }});
 }
};

## Plugin lifecycle and context
Plugin={id:string,name:string,version:string,onLoad?(ctx),onStart?(ctx),onStop?(ctx),onUnload?(ctx)}.
Use onLoad/onStart to register capabilities/resources, not external business effects. PluginContext has:
ctx.register(capability) -> unregister(); ctx.provide(key,value,priority?) -> remove();
ctx.inject(key,onChange?) -> {value:unknown,stop()}; ctx.on(event,listener,priority?) -> off();
ctx.bus.emit({type,ts:Date.now(),data}); emitAsync; serial; bail; parallel; waterfall;
ctx.storage.read(name) -> string|null; write(name,string); list(); remove(name);
ctx.resources.interval(()=>void,milliseconds), timeout, defer(()=>void|Promise<void>), each returns cancel().
ctx.config.get(key,default); ctx.configWith(values); ctx.watchConfig(key,callback).
No raw filesystem/process/network/host implementation imports. Pure local modules may import './helper'; type imports from '../../kernel/types' are supported. Only user-approved installed external dependencies are available.
manifest.requires=['base-plugin'] orders scoped dependencies. ctx.inject('service:prices') resolves a registered service; ctx.provide('prices',value) instead uses the exact key 'prices'. Reserved runtime services cannot be replaced in run scope.

## Capabilities registered through ctx.register
{kind:'service',service:{id:'prices',instance:{total:(n:number)=>n*21}}}
{kind:'context',context:{id:'note',description:'Reference note',contentFn:()=> 'reference content'}}
{kind:'listener',event:'sample.value',listener:event=>{ /* event.data is unknown */ }}
{kind:'command',command:{name:'upper',description:'Uppercase',handler:(args:string[])=>args[0].toUpperCase()}}
{kind:'role',role:{id:'review',name:'Review',description:'Review materials',systemPrompt:'Task-specific role instructions',tools:'readonly'}}
{kind:'provider',provider:{id:'local',label:'Local',defaultModel:'local',chat:async function*(){yield {type:'delta' as const,text:'OK'};yield {type:'usage' as const,input:1,output:1};yield {type:'done' as const};}}}
{kind:'persona',persona:{id:'guide',name:'Guide',description:'Optional reference',content:'Reference text'}}
{kind:'api',api:{mount:'panel',router:(_req:unknown,res:{json(value:unknown):void})=>res.json({title:'Result',html:'<p>OK</p>'})}}

command handler may return string or Promise<string>. invoke_plugin({kind:'command',name:'upper',args:['ready']}) invokes it.
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
