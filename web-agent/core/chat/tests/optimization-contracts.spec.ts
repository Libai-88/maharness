import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kernel } from '../../../kernel';
import { ToolExecutor } from '../tool-executor';
import { annotateToolDef } from '../agent';
import { validateToolArguments, validateAgainstSchema } from '../../../kernel/validate';
import { verificationLabel, toolStatusLabel } from '../../../ui/src/run-status';
import type { ToolContext, ToolDef } from '../../../kernel/types';

test('actual default core tool inventory has executable contracts and PowerShell results match descriptions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mh-tool-contracts-'));
  mkdirSync(join(root,'plugins'));
  const core = fileURLToPath(new URL('../../',import.meta.url));
  const kernel = new Kernel(root, {}, {corePluginsDir: core});
  try {
    await kernel.plugins.loadAll();
    const tools = kernel.plugins.tools();
    assert.ok(tools.length > 30);
    assert.equal(new Set(tools.map(tool=>tool.name)).size,tools.length);
    for (const tool of tools) {
      assert.ok(tool.description.trim(),tool.name);
      assert.match(tool.version,/^\d+\.\d+\.\d+$/);
      assert.ok(Array.isArray(tool.permissions),tool.name);
      assert.ok(['none','read','write','external','irreversible'].includes(tool.sideEffect),tool.name);
      assert.ok(tool.parameters && tool.outputSchema,tool.name);
      assert.equal(validateToolArguments(tool,null).length > 0,true,tool.name);
    }
    const powershell=tools.find(tool=>tool.name==='powershell_execute')!;
    assert.ok(powershell);
    assert.doesNotMatch(annotateToolDef(powershell).description,/\{stdout, stderr/);
    if (process.platform==='win32') {
      const ctx={turn:0,sandboxRoot:root,cache:kernel.cache,trace:kernel.trace,approved:true} as ToolContext;
      const success=await powershell.handler({command:"Write-Output 'ok'"},ctx);
      assert.equal(success.ok,true); assert.deepEqual(validateAgainstSchema(success.data,powershell.outputSchema),[]);
      const failed=await powershell.handler({command:"Write-Output 'partial'; exit 7"},ctx);
      assert.equal(failed.ok,false); assert.equal((failed.data as {exitCode:number}).exitCode,7);
      assert.equal(failed.failure?.outcome,'unknown');
      assert.equal((failed.data as {output:string}).output.includes('partial'),true);
      const readOnlyFailed=await powershell.handler({command:'Get-Content missing-workbench-eval-file.txt'},ctx);
      assert.equal(readOnlyFailed.ok,false);
      assert.equal(readOnlyFailed.failure?.outcome,'not_started');
      const start=tools.find(tool=>tool.name==='command_start')!;
      const started=await start.handler({command:"Write-Output 'background'"},ctx);
      assert.equal(started.ok,true);assert.deepEqual(validateAgainstSchema(started.data,start.outputSchema),[]);
      const id=(started.data as {id:string}).id;
      for (const name of ['command_wait','command_output','command_cancel']) {
        const tool=tools.find(item=>item.name===name)!;
        const result=await tool.handler({id,timeoutMs:10000},ctx);
        assert.equal(result.ok,true,name);assert.deepEqual(validateAgainstSchema(result.data,tool.outputSchema),[],name);
        const page=result.data as {nextOffset:number;length:number;output:string};
        assert.equal(page.nextOffset,page.length,name);assert.match(page.output,/background/);
      }
    }
  } finally {await kernel.stop();rmSync(root,{recursive:true,force:true});}
});

test('per-call cancellation reaches delegates and holds physical capacity until settlement', async () => {
  let entered!:()=>void; const started=new Promise<void>(resolve=>{entered=resolve});
  let finish!:()=>void; const released=new Promise<void>(resolve=>{finish=resolve});
  let leaseReleased=false; let childSignal:AbortSignal|undefined;
  const tool:ToolDef={name:'delegate',version:'2.0.0',permissions:[],sideEffect:'read',description:'delegate',parameters:{type:'object'},outputSchema:{type:'object'},timeoutMs:10,
    async handler(_args,ctx){return {ok:true,data:await ctx.delegate!({objective:'test'})}}};
  const executor=new ToolExecutor({tool,args:{},context:{turn:0,sandboxRoot:process.cwd(),delegate:async(_request,signal)=>{childSignal=signal;entered();await released;return {runId:'c',traceId:'c',answer:'done',toolCalls:0,cost:0,tokensIn:0,tokensOut:0,cancelled:false}}} as ToolContext,effectStarted:false,timeoutMs:1000,policyApproved:false,acquireExecution:async()=>()=>{leaseReleased=true}});
  const pending=executor.invoke(false);
  await started;const result=await pending;
  assert.equal(childSignal?.aborted,true);assert.equal(result.failure?.code,'TOOL_INTERRUPTED');
  assert.equal(leaseReleased,false);finish();await released;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(leaseReleased,true);
});

test('runtime labels distinguish completion, verification and unknown outcomes',()=>{
  assert.equal(verificationLabel(undefined),'尚未验证');
  assert.equal(verificationLabel({type:'task_verified'}),'机器验收通过');
  assert.equal(verificationLabel({type:'task_failed'}),'机器验收未通过');
  assert.equal(verificationLabel({type:'task_partial'}),'机器验收部分通过');
  assert.equal(verificationLabel({legacy:true}),'有验收记录，结论未识别');
  assert.match(toolStatusLabel('unknown'),/禁止自动重放/);
});
