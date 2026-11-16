import type { Capability, PluginManifest } from '../../kernel/types';

const registrations: { id: string; kind: Capability['kind']; name: string; code: string }[] = [
  { id: 'tool', kind: 'tool', name: 'sum_values', code: `{kind:'tool',tool:{name:'sum_values',version:'2.0.0',description:'Sum numeric values',permissions:[],sideEffect:'none',parameters:{type:'object',properties:{numbers:{type:'array',items:{type:'number'}}},required:['numbers']},outputSchema:{type:'object',properties:{sum:{type:'number'}},required:['sum']},async handler(args:unknown){const {numbers}=args as {numbers:number[]};return {ok:true,data:{sum:numbers.reduce((a,b)=>a+b,0)}}}}}` },
  { id: 'service', kind: 'service', name: 'prices', code: `{kind:'service',service:{id:'prices',instance:{total:(n:number)=>n*21}}}` },
  { id: 'context', kind: 'context', name: 'note', code: `{kind:'context',context:{id:'note',description:'Reference note',contentFn:()=> 'reference content'}}` },
  { id: 'listener', kind: 'listener', name: 'sample.value', code: `{kind:'listener',event:'sample.value',listener:()=>{}}` },
  { id: 'command', kind: 'command', name: 'upper', code: `{kind:'command',command:{name:'upper',description:'Uppercase',handler:(args:string[])=>String(args[0]??'').toUpperCase()}}` },
  { id: 'role', kind: 'role', name: 'review', code: `{kind:'role',role:{id:'review',name:'Review',description:'Review materials',systemPrompt:'Review the requested materials.',tools:'readonly'}}` },
  { id: 'provider', kind: 'provider', name: 'local', code: `{kind:'provider',provider:{id:'local',label:'Local',defaultModel:'local',chat:async function*(){yield {type:'delta' as const,text:'OK'};yield {type:'usage' as const,input:1,output:1};yield {type:'done' as const}}}}` },
  { id: 'persona', kind: 'persona', name: 'guide', code: `{kind:'persona',persona:{id:'guide',name:'Guide',description:'Optional reference',content:'Reference text'}}` },
  { id: 'api', kind: 'api', name: 'panel', code: `{kind:'api',api:{mount:'panel',router:(_req:unknown,res:{json(value:unknown):void})=>res.json({title:'Result',html:'<p>OK</p>'})}}` },
  { id: 'composition', kind: 'tool', name: 'read_note', code: `{kind:'tool',tool:{name:'read_note',version:'2.0.0',description:'Read note.txt through the host',permissions:['workspace.read'],sideEffect:'read',invokesTools:true,parameters:{type:'object'},outputSchema:{type:'object'},async handler(_args:unknown,tctx:import('../../kernel/plugin-sdk').ToolContext){if(!tctx.invoke)return {ok:false,error:'Host tool broker unavailable',failure:{code:'HOST_UNAVAILABLE',retryable:false,outcome:'not_started'}};return tctx.invoke('read_file',{path:'note.txt'})}}}` },
];

export const taskPluginExamples = registrations.map(({ id, kind, name, code }) => {
  const pluginId = `example-${id}`;
  const manifest: PluginManifest = { apiVersion: 2, id: pluginId, name: id, version: '1.0.0', entry: 'index.ts', permissions: { capabilities: { [kind]: [name] } } };
  const source = `export default {id:'${pluginId}',name:'${id}',version:'1.0.0',onLoad(ctx:import('../../kernel/plugin-sdk').PluginContext){ctx.register(${code});}};`;
  return { id, kind, name, manifest, source };
});
