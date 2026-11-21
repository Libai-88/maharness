import type { Express, Request, Response, NextFunction } from 'express';
import { ItemError, isItemError, type PersonalItem, type ItemAttempt, type PersonalItems } from '../host/adapters/items';
import type { RouteDeps } from './shared';
import { tenantIdOf, getChatService } from './shared';
import { RunError, type RunService } from '../run-service';
import { tenantSandboxRoot } from '../tenant-workspace';
import { RUN_TERMINAL } from '../../kernel/run';
import { MaterialError } from '../materials';

export function registerItemRoutes(app: Express, deps: RouteDeps, runs: RunService) {
  const service = () => {
    const value = deps.kernel.plugins.resolveService('service:personal-items') as PersonalItems | undefined;
    if (!value) throw new ItemError(503,'ITEMS_UNAVAILABLE','待办插件未启用'); return value;
  };
  const wrap = (fn: (req: Request,res: Response) => unknown) => (req: Request,res: Response,next: NextFunction) => {
    try { Promise.resolve(fn(req,res)).catch(next); } catch(error) {
      if(isItemError(error) || error instanceof RunError || error instanceof MaterialError) res.status(error.status).json({code:error.code,error:error.message}); else next(error);
    }
  };
  const validateMaterials = (tenant: string, refs: unknown) => deps.store.materials.validate(refs, tenant, tenantSandboxRoot(deps.kernel.config.get<string>('sandboxRoot', deps.kernel.rootDir), tenant), deps.kernel.rootDir);
  const watchReview = (tenant: string, itemId: string, runId: string, itemRevision: number) => {
    const stop=runs.subscribe(runId,()=>{const current=deps.store.runs.get(runId,tenant);if(current&&RUN_TERMINAL.has(current.status)){if(current.status==='completed'&&(current.answer?.trim()||deps.store.runs.artifacts(runId).length))service().review(tenant,itemId,itemRevision);stop();}});
  };
  const enrich = (tenant: string, initial: PersonalItem, attempts: ItemAttempt[]) => {
    let item = initial;
    const history = attempts.map(attempt => {
      const run = deps.store.runs.get(attempt.runId,tenant);
      const artifacts = run ? deps.store.runs.artifacts(run.id) : [];
      if (run?.status === 'completed' && item.lifecycle === 'todo' && item.revision === attempt.itemRevision && (run.answer?.trim() || artifacts.length)) item = service().review(tenant,item.id,attempt.itemRevision);
      return {...attempt,run,artifacts};
    });
    return {...item,attempts:history};
  };
  app.get('/api/items',wrap((req,res)=>{
    const tenant=tenantIdOf(req),items=service();
    const grouped = new Map<string, ItemAttempt[]>();
    for (const attempt of items.allAttempts(tenant)) { const group = grouped.get(attempt.itemId) ?? []; group.push(attempt); grouped.set(attempt.itemId,group); }
    const rows=items.list(tenant).map(item=>enrich(tenant,item,grouped.get(item.id) ?? []));
    res.json({items:rows,projects:tenant==='default'?items.workspace(tenant).data.projects:[],now:new Date().toISOString()});
  }));
  app.get('/api/items/:id',wrap((req,res)=>{const tenant=tenantIdOf(req),id=String(req.params.id); const row=enrich(tenant,service().get(tenant,id),service().attempts(tenant,id));res.json({item:row,attempts:row.attempts});}));
  app.post('/api/items',wrap((req,res)=>{
    validateMaterials(tenantIdOf(req),req.body?.materials);
    res.status(201).json({item:service().create(tenantIdOf(req),req.body??{})});
  }));
  app.patch('/api/items/:id',wrap((req,res)=>{
    const {revision,...patch}=req.body??{};
    if (patch.executionSessionId!==undefined) throw new ItemError(400,'INVALID_ITEM','执行会话由系统关联');
    validateMaterials(tenantIdOf(req),patch.materials);
    res.json({item:service().update(tenantIdOf(req),String(req.params.id),revision,patch)});
  }));
  app.post('/api/items/import-legacy/:id',wrap((req,res)=>{
    const tenant=tenantIdOf(req),file=deps.kernel.paths.data + '/todo.json';
    const cards=JSON.parse(requireRead(file)).cards;
    const card=Array.isArray(cards)?cards.find((card:any)=>card.id===req.params.id && (card.tenantId??'default')===tenant):undefined;
    if(!card) throw new ItemError(404,'LEGACY_NOT_FOUND','历史卡片不存在');
    res.json({item:service().importLegacy(tenant,card)});
  }));
  app.post('/api/items/:id/execute',wrap((req,res)=>{
    const tenant=tenantIdOf(req),id=String(req.params.id),items=service(); let item=items.get(tenant,id);
    const key=req.get('Idempotency-Key'); if(!key || key.length>100) throw new ItemError(400,'INVALID_OPERATION','执行需要唯一操作标识');
    const priorSession=item.executionSessionId?deps.store.getSession(item.executionSessionId,tenant):undefined;
    const prior=priorSession?deps.store.runs.byRequest(tenant,priorSession.id,`item:${id}:${key}`):undefined;
    if(prior){ if(!items.attempts(tenant,id).some(row=>row.runId===prior.id))items.attach(tenant,id,prior.id,items.executionIntent(tenant,id,key) ?? 0); res.status(202).json({run:prior,sessionId:prior.sessionId}); return; }
    if(item.executionSessionId){ const active=deps.store.runs.list(tenant,item.executionSessionId).find(run=>!RUN_TERMINAL.has(run.status));if(active){res.status(202).json({run:active,sessionId:active.sessionId});return;} }
    if(item.revision!==req.body?.revision) throw new ItemError(409,'VERSION_CONFLICT','事项已变化，请刷新后执行');
    if(item.lifecycle!=='todo') throw new ItemError(409,'ITEM_NOT_OPEN','请先将事项重新打开');
    const latest=items.attempts(tenant,id)[0];const previous=latest?deps.store.runs.get(latest.runId,tenant):undefined;
    if(previous?.status==='interrupted' && !req.body?.newAttempt){
      const resumed=runs.resume(previous.id,tenant,(req as any).apiRole);
      watchReview(tenant,id,resumed.id,item.revision);
      res.status(202).json({run:resumed,sessionId:resumed.sessionId});
      return;
    }
    const chat=getChatService(deps.kernel);const provider=req.body?.provider ? chat?.providers.find(p=>p.id===req.body.provider) : chat?.providers.find(p=>p.id===priorSession?.provider)??chat?.providers[0];
    if(!provider) throw new ItemError(400,'PROVIDER_UNAVAILABLE','请先配置模型');
    validateMaterials(tenant,item.materials);
    let session=priorSession;
    if(!session){ session=deps.store.createSession(provider.defaultModel,provider.id,tenant);deps.store.updateSession(session.id,{title:item.title}); item=items.update(tenant,id,item.revision,{executionSessionId:session.id}); }
    const message=`${item.title}\n\n${item.note}\n\n事项版本：${item.revision}。按本次请求交付结果，完成后由用户检查。安排：${item.due||'未排期'} ${item.dueTime||''} ${item.timeZone}。此安排不构成运行强制截止时间。`;
    const intentRevision = items.executionIntent(tenant,id,key,item.revision)!;
    if (intentRevision !== item.revision) throw new ItemError(409,'VERSION_CONFLICT','请为更新后的事项重新发起执行');
    const run=runs.create(session,{message,materials:item.materials,provider:provider.id,model:session.model||provider.defaultModel,requestKey:`item:${id}:${key}`,principalRole:(req as any).apiRole,projectId:item.pid||undefined,origin:{kind:'item',itemId:id,revision:item.revision}});
    items.attach(tenant,id,run.id,item.revision);
    watchReview(tenant,id,run.id,item.revision);
    res.status(202).json({run,sessionId:session.id});
  }));
}
import { readFileSync } from 'node:fs';
function requireRead(file:string){try{return readFileSync(file,'utf8');}catch{return '{"cards":[]}';}}
