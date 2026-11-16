import type { PluginContext } from '../../kernel/types';
import { PersonalItems } from './items';

export function registerItemTools(ctx: PluginContext, items: PersonalItems) {
  ctx.register({ kind: 'service', service: { id: 'personal-items', instance: items } });
  ctx.register({ kind: 'persona', persona: { id: 'personal-items-rules', name: '个人事项规则', priority: 6,
    content: '用户明确要求记下、安排、改期或完成个人事项时，用 item_* 工具操作。额外推断的后续事项先在回复中建议，获采纳再保存。todo_* 仅用于你的执行步骤，不混入个人事项。日期时间仅记录安排，不代表提醒或自动执行。先读取版本再修改；不得将 Run 正常结束当作用户验收。用户明确要求完成才用 item_complete。个人事项的“现在执行”由用户操作，采用专属会话。',
    description: '个人安排与模型执行步骤分开，用户明确要求时持久记录事项' } });
  const properties = { offset: {type:'integer',minimum:0}, limit: {type:'integer',minimum:1,maximum:50}, id: { type:'string' }, revision: { type:'integer', minimum:1 }, title: {type:'string',maxLength:200}, note:{type:'string',maxLength:2000}, prio:{type:'integer',minimum:1,maximum:4}, due:{type:'string',description:'YYYY-MM-DD；空字符串为未排期'}, dueTime:{type:'string',description:'HH:mm；空字符串清除具体时间'}, timeZone:{type:'string',description:'IANA时区，如 Asia/Shanghai'}, repeat:{type:'string',enum:['','daily','weekdays','weekly','monthly']}, projectId:{type:'string'}, materials:{type:'array',maxItems:10,items:{type:'object',properties:{id:{type:'string'},version:{type:'string'}},required:['id','version'],additionalProperties:false}}, operationId:{type:'string'}, lifecycle:{type:'string',enum:['todo','archived']} };
  function register(name: string, description: string, keys: (keyof typeof properties)[], required: string[], write: boolean, handler: (args: any, tenant: string, session?: string) => unknown) {
    ctx.register({kind:'tool',tool:{name,description,version:'1.0.0',outputSchema:{type:'object'},permissions:write?['workspace.read','workspace.write']:['workspace.read'],risk:'low',sideEffect:write?'write':'read',contentTrust:'untrusted',parameters:{type:'object',properties:Object.fromEntries(keys.map(key=>[key,properties[key]])),required,additionalProperties:false},async handler(args,tctx){try{return{ok:true,data:handler(args,tctx.tenantId??'default',tctx.sessionId)};}catch(error){return{ok:false,error:error instanceof Error?error.message:String(error)};}}}});
  }
  register('item_list','分页读取个人事项，返回当前日期、时区提示及版本；不是模型执行步骤清单。',['offset','limit'],[],false,(args,tenant)=>{ const rows=items.list(tenant),offset=Math.max(0,Math.floor(Number(args.offset)||0)),limit=Math.min(50,Math.max(1,Math.floor(Number(args.limit)||20))); return {now:new Date().toISOString(),defaultTimeZone:'Asia/Shanghai',total:rows.length,nextOffset:offset+limit<rows.length?offset+limit:null,items:rows.slice(offset,offset+limit)}; });
  register('item_get','读取指定个人事项及执行关联。',['id'],['id'],false,(args,tenant)=>({item:items.get(tenant,args.id),attempts:items.attempts(tenant,args.id)}));
  register('item_create','按用户明确要求记录个人事项。未知日期留空，不默认今天；operationId用于重试去重。',['title','note','prio','due','dueTime','timeZone','repeat','projectId','materials','operationId'],['title','timeZone','operationId'],true,(args,tenant,session)=>items.create(tenant,args,session));
  register('item_update','改期、编辑、归档或重新打开个人事项。必须先读取revision；执行中编辑不会改写当前Run。',['id','revision','title','note','prio','due','dueTime','timeZone','repeat','projectId','materials','lifecycle'],['id','revision'],true,(args,tenant)=>items.update(tenant,args.id,args.revision,{...args,...(args.projectId!==undefined?{pid:args.projectId}:{})}));
  register('item_complete','仅在用户明确要求完成事项时调用；不得用模型自称成功替代验收。',['id','revision'],['id','revision'],true,(args,tenant)=>items.update(tenant,args.id,args.revision,{lifecycle:'done'}));
}
