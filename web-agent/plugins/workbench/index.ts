import type { Plugin } from '../../kernel/types';
import type { PersonalItems } from '../../core/todo/items';
import { ItemError, isItemError } from '../../core/todo/items';
import { day } from './model';
import { randomUUID } from 'node:crypto';

export function workbenchTenantAllowed(tenantId?: string): boolean { return (tenantId ?? 'default') === 'default'; }
export default {
  id: 'workbench', name: '办公工作台', version: '0.3.0',
  onLoad(ctx) {
    const service = () => {
      const value = ctx.kernel.plugins.resolveService('service:personal-items') as PersonalItems | undefined;
      if (!value) throw new ItemError(503, 'ITEMS_UNAVAILABLE', '请启用待办插件'); return value;
    };
    ctx.register({ kind:'persona', persona:{id:'workbench-rules',name:'办公工作台规则',priority:4,description:'读取个人事项、项目、笔记和日记',content:'工作台和个人待办共享数据。用户明确要求管理安排时可用 item_*；workbench_* 为兼容工具。日期不代表到点执行。执行步骤用 todo_*。额外推断的个人事项先建议，获采纳再保存。'} });
    const text = {type:'string'};
    function tool(name:string,description:string,properties:Record<string,unknown>,required:string[],write:boolean,handler:(args:any,items:PersonalItems,sessionId?:string)=>unknown) {
      ctx.register({kind:'tool',tool:{name,description,version:'1.0.0',outputSchema:{type:'object'},permissions:write?['workspace.read','workspace.write']:['workspace.read'],sideEffect:write?'write':'read',risk:'low',contentTrust:'untrusted',parameters:{type:'object',properties,required,additionalProperties:false},async handler(args,tctx){try{if(!workbenchTenantAllowed(tctx.tenantId))throw new ItemError(403,'WORKBENCH_TENANT','完整工作台仅支持 default 租户');return{ok:true,data:handler(args,service(),tctx.sessionId)};}catch(error){return{ok:false,error:error instanceof Error?error.message:String(error)};}}}});
    }
    tool('workbench_today','读取今日、逾期、未来安排及项目笔记日记；含事项版本。',{},[],false,(_args,items)=>{
      const data=items.workspace('default').data,today=day(),tasks=items.list('default');
      return {today,tasks:tasks.filter(t=>!t.done&&t.lifecycle!=='archived'&&(!t.due||t.due<=today)),schedule:tasks.filter(t=>!t.done&&t.lifecycle!=='archived'&&t.due>today),projects:data.projects,notes:data.notes,diary:data.diary[today]??'',timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone};
    });
    tool('workbench_add_task','记录个人事项；仅日期，无提醒或自动执行。需要时间、资料和幂等标识时用 item_create。',{title:text,due:text,prio:{type:'number'},project:text,repeat:{type:'string',enum:['daily','weekdays','weekly','monthly']},note:text,status:{type:'string',enum:['todo','doing','wait']}},['title'],true,(args,items,sessionId)=>{
      const project=items.workspace('default').data.projects.find(p=>p.id===args.project||p.name===args.project);
      return items.create('default',{...args,projectId:project?.id??'',due:args.due??day()},sessionId);
    });
    tool('workbench_update_task','更新个人事项；必须先读 revision，原格式 id/done/due 保持兼容。',{id:text,revision:{type:'integer'},done:{type:'boolean'},due:text,prio:{type:'number'},status:{type:'string',enum:['todo','doing','wait','cancel']},note:text,project:text},['id'],true,(args,items)=>{
      const item=items.get('default',args.id),patch={...args,...(args.done!==undefined?{lifecycle:args.done?'done':'todo'}:{}),...(args.status==='cancel'?{lifecycle:'archived'}:{})};
      if (args.project !== undefined) patch.pid = items.workspace('default').data.projects.find(project=>project.id===args.project||project.name===args.project)?.id ?? '';
      return items.update('default',args.id,args.revision??item.revision,patch);
    });
    tool('workbench_add_note','按用户要求记录笔记。',{text,tags:{type:'array',items:text,maxItems:12}},['text'],true,(args,items)=>{
      if(typeof args.text!=='string'||!args.text.trim()||args.text.length>1200)throw new Error('笔记需要 1–1200 字');
      const current=items.workspace('default'),note={id:randomUUID(),text:args.text.trim(),tags:args.tags??[],createdAt:Date.now(),updatedAt:Date.now()};current.data.notes.unshift(note);items.saveWorkspace('default',current.data,current.revision);return note;
    });
    tool('workbench_diary','记录指定日期日记；同一天覆盖。',{text,date:text},['text'],true,(args,items)=>{
      if(typeof args.text!=='string'||args.text.length>200)throw new Error('日记最多 200 字');
      const date=args.date??day();if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('日期无效');
      const current=items.workspace('default');current.data.diary[date]=args.text;current.data.diaryTs[date]=Date.now();items.saveWorkspace('default',current.data,current.revision);return{date,text:args.text};
    });
    ctx.register({kind:'api',api:{mount:'wb',responses:{'GET /data':{type:'object'},'PUT /data':{type:'object'},'POST /import':{type:'object'},'GET /status':{type:'object'},'GET /panel':{type:'object'}},router:((req:any,res:any)=>{
      try{
        if(!workbenchTenantAllowed(req.tenantId))throw new ItemError(403,'WORKBENCH_TENANT','完整工作台仅支持 default 租户');
        const path=(req.path??'/').replace(/^\/wb(?=\/|$)/,'').replace(/\/+$/,'')||'/';
        if(req.method==='GET'&&path==='/app'){res.writeHead(302,{Location:'/todo.html?view=overview'});res.end();return;}
        if(req.method==='GET'&&path==='/data'){res.json(service().workspace('default'));return;}
        if((req.method==='PUT'&&path==='/data')||(req.method==='POST'&&path==='/import')){res.json(service().saveWorkspace('default',req.body?.data,req.body?.revision,path==='/import'));return;}
        if(req.method==='GET'&&(path==='/status'||path==='/bridge')){const s=service().workspace('default');res.json({connected:true,text:'已连接应用存储',revision:s.revision});return;}
        if(req.method==='GET'&&path==='/panel'){res.json({title:'工作台',html:'<p>今日事项、执行进度与最近结果</p>'});return;}
        res.status(404).json({error:'未知端点'});
      }catch(error){res.status(isItemError(error)?error.status:500).json({error:error instanceof Error?error.message:String(error),code:isItemError(error)?error.code:'WORKBENCH_ERROR'});}
    }) as never}});
    ctx.logger.info('工作台已接入个人事项服务');
  },
} satisfies Plugin;
