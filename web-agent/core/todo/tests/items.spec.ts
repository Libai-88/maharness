import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ItemError, PersonalItems } from '../items';
import { blank, taskDefaults } from '../../../plugins/workbench/model';
const fixture = () => { const root = mkdtempSync(join(tmpdir(),'maharness-items-')); return { root, items: new PersonalItems(root), clean: () => rmSync(root,{recursive:true,force:true}) }; };
const code = (expected:string) => (error:unknown) => error instanceof ItemError && error.code === expected;
test('personal items persist across restart, isolate tenants and deduplicate operations', () => {
  const f=fixture();try {
    const args={title:'写周报',timeZone:'Asia/Shanghai',operationId:'one'};
    const item=f.items.create('a',args,'source');
    assert.equal(f.items.create('a',args,'source').id,item.id);
    assert.throws(()=>f.items.create('a',{...args,title:'另一个'},'source'),code('IDEMPOTENCY_CONFLICT'));
    assert.equal(f.items.list('b').length,0);
    assert.throws(()=>f.items.get('b',item.id),code('ITEM_NOT_FOUND'));
    const restarted=new PersonalItems(f.root);assert.equal(restarted.get('a',item.id).sourceSessionId,'source');
    assert.equal(restarted.get('a',item.id).due,'');
  }finally{f.clean();}
});
test('version conflict and invalid edits preserve the saved item',()=>{
  const f=fixture();try {
    const item=f.items.create('default',{title:'复习'});
    const changed=f.items.update('default',item.id,item.revision,{note:'已整理'});
    assert.throws(()=>f.items.update('default',item.id,item.revision,{title:'覆盖'}),code('VERSION_CONFLICT'));
    for(const patch of [{due:'2026-99-01'},{due:'2026-02-30'},{dueTime:'12:00'},{timeZone:'bad/zone'},{materials:[{id:'file',version:'no'}]},{title:''}]) assert.throws(()=>f.items.update('default',item.id,changed.revision,patch));
    assert.equal(f.items.get('default',item.id).note,'已整理');
  }finally{f.clean();}
});
test('run evidence moves the matching item to review; edits protect newer requests',()=>{
  const f=fixture();try {
    const item=f.items.create('a',{title:'整理资料'});
    f.items.executionIntent('a',item.id,'request',item.revision);f.items.attach('a',item.id,'run',item.revision);f.items.attach('a',item.id,'run',item.revision);
    assert.equal(f.items.attempts('a',item.id).length,1);
    assert.equal(f.items.executionIntent('a',item.id,'request',99),item.revision);
    assert.equal(f.items.review('a',item.id,item.revision).lifecycle,'review');
    const reopened=f.items.update('a',item.id,f.items.get('a',item.id).revision,{lifecycle:'todo',note:'补充要求'});
    assert.equal(f.items.review('a',item.id,item.revision).revision,reopened.revision);
    assert.equal(f.items.get('a',item.id).lifecycle,'todo');
  }finally{f.clean();}
});
test('completion creates exactly one next repeat; archived items stay out of active workbench',()=>{
  const f=fixture();try {
    const item=f.items.create('a',{title:'周报',due:'2026-11-16',dueTime:'09:30',repeat:'weekly'});
    const done=f.items.update('a',item.id,item.revision,{lifecycle:'done'});
    f.items.update('a',item.id,done.revision,{lifecycle:'done'});
    assert.equal(f.items.list('a').length,2);assert.equal(f.items.list('a')[1].due,'2026-11-23');
    const archived=f.items.update('a',f.items.list('a')[1].id,1,{lifecycle:'archived'});assert.equal(archived.status,'cancel');
  }finally{f.clean();}
});
test('workbench edits and model items share versions and preserve system links',()=>{
  const f=fixture();try {
    let item=f.items.create('default',{title:'准备材料'},'source');
    item=f.items.update('default',item.id,item.revision,{executionSessionId:'execution'});
    const snapshot=f.items.workspace('default');snapshot.data.tasks[0].title='准备汇报';snapshot.data.tasks[0].executionSessionId='spoofed';
    const saved=f.items.saveWorkspace('default',snapshot.data,snapshot.revision);
    assert.equal(f.items.get('default',item.id).title,'准备汇报');assert.equal(f.items.get('default',item.id).executionSessionId,'execution');
    assert.throws(()=>f.items.saveWorkspace('default',snapshot.data,snapshot.revision),code('VERSION_CONFLICT'));
    const empty=blank();f.items.saveWorkspace('default',empty,saved.revision);
    assert.equal(f.items.get('default',item.id).lifecycle,'archived');
    assert.equal(f.items.get('default',item.id).status,'cancel');
    assert.throws(()=>f.items.saveWorkspace('a',empty,0),code('WORKBENCH_TENANT'));
  }finally{f.clean();}
});
test('server migration backs up originals, merges versions and strips sample records once',()=>{
  const root=mkdtempSync(join(tmpdir(),'maharness-migrate-'));
  try {
    const legacy={tasks:[{id:'legacy',title:'旧安排',date:'2026-11-20',time:'10:00',notes:'旧说明',projectId:'p'}],projects:[{id:'p',name:'课题',desc:'开题'}]};
    writeFileSync(join(root,'workbench.json'),JSON.stringify(legacy));mkdirSync(join(root,'workbench-bridge'));
    writeFileSync(join(root,'workbench-bridge','workbench-data.json'),JSON.stringify({...blank(),tasks:[taskDefaults({id:'sample',title:'示例',_s:true})]}));
    const items=new PersonalItems(root),list=items.list('default');assert.equal(list.length,1);assert.equal(list[0].due,'2026-11-20');assert.equal(list[0].dueTime,'10:00');assert.equal(list[0].pid,'p');
    assert.deepEqual(JSON.parse(readFileSync(join(root,'workbench.json.before-items'),'utf8')),legacy);
    assert.equal(new PersonalItems(root).list('default').length,1);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('corrupt migration reports failure without overwriting the input; quota failure rolls back',()=>{
  const f=fixture();try {
    writeFileSync(join(f.root,'workbench.json'),'{broken');assert.throws(()=>f.items.list('default'),code('MIGRATION_FAILED'));assert.equal(readFileSync(join(f.root,'workbench.json'),'utf8'),'{broken');
    const limited=new PersonalItems(f.root,undefined,{assertWritable(){throw new Error('quota');},invalidate(){}});
    assert.throws(()=>limited.create('other',{title:'blocked'}),/quota/);assert.equal(f.items.list('other').length,0);
  }finally{f.clean();}
});
test('legacy cards convert explicitly once and keep their source session',()=>{
  const f=fixture();try{const card={id:'card',title:'历史任务',status:'done',priority:'high',sessionId:'origin'};const item=f.items.importLegacy('a',card);assert.equal(item.lifecycle,'done');assert.equal(f.items.importLegacy('a',card).id,item.id);assert.equal(f.items.list('a').length,1);assert.equal(item.sourceSessionId,'origin');}finally{f.clean();}
});
