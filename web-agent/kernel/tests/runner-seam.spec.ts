/**
 * kernel/tests/runner-seam.spec.ts —— 执行循环可替换性的端到端验证
 *
 * 第一性原理：真正的可替换性不能用「有没有一个接口」证明，只能用
 * 「换掉实现之后，所有消费路径的行为是否真的变了」证明。
 * 本测试装载【完整的 core 插件栈】（chat / subagent / parallel / tools-fs …），
 * 再用一个测试插件以更高优先级接管 `service:runner`，然后断言：
 *   1. 默认情况下 service:runner 由 chat 插件提供（内核不含循环）；
 *   2. 接管后 resolveRunner 返回替身；
 *   3. 顶层路径（server 的取用口）拿到替身；
 *   4. 子代理（run_subagent）内部循环变成替身——证明替换不是只改了顶层；
 *   5. 并行（run_parallel）内部循环变成替身；
 *   6. 接管者停用后自动回退到默认循环；重新启用后再次接管。
 */
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kernel } from '../index';
import { makeRunner, SERVICE_KEYS } from '../loop';
import type { AgentEvent, RunOptions } from '../loop';
import type { ToolDef, ToolContext } from '../types';

const CHAT_PLUGIN_ID = 'chat';

/** 替身循环的调用记录：经事件总线采集（不借助 globalThis——多用例共享进程会串扰） */
interface StubCall { systemPrompt?: string; model?: string; objective?: string; hasSignal?: boolean }

function setup(): { kernel: Kernel; rootDir: string; calls: StubCall[]; cleanup: () => void } {
  const rootDir = mkdtempSync(join(tmpdir(), 'mh-runner-'));
  const dataDir = join(rootDir, 'data');
  const userPluginsDir = join(rootDir, 'plugins');
  mkdirSync(userPluginsDir, { recursive: true });
  writeFileSync(join(rootDir, 'config.json'), JSON.stringify({ sandboxRoot: rootDir }));

  const calls: StubCall[] = [];
  // 替身循环：不调 LLM，直接产出一段确定性事件流（可断言事件被消费方正确消费）。
  // 每次 run 发一条 bus 事件作为「替身确实被调用」的证据。
  const pdir = join(userPluginsDir, 'runner-stub');
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, 'plugin.json'), JSON.stringify({
    id: 'runner-stub', name: 'runner-stub', version: '0.1.0', entry: 'index.ts',
  }));
  writeFileSync(join(pdir, 'index.ts'), `
    let activeParallel = 0;
    const stubFactory = (kernel, bus) => ({
      async *run(opts) {
        const objective = opts.messages?.[0]?.content ?? '';
        if (objective.startsWith('capacity-delay')) {
          activeParallel++;
          bus.emit({ type: 'stub.runner.capacity', ts: Date.now(), data: { active: activeParallel } });
          try {
            yield { type: 'delta', text: 'capacity' };
            await new Promise((resolve) => setTimeout(resolve, 80));
            yield { type: 'assistant_done', content: 'capacity', reasoning: '', usage: { input: 1, output: 1 }, cost: 0 };
          } finally {
            activeParallel--;
            bus.emit({ type: 'stub.runner.capacity', ts: Date.now(), data: { active: activeParallel } });
          }
          return;
        }
        bus.emit({ type: 'stub.runner.called', ts: Date.now(), data: { systemPrompt: opts.systemPrompt, model: opts.model, objective, hasSignal: !!opts.signal } });
        if (objective.startsWith('wait-for-abort')) {
          yield { type: 'delta', text: 'partial' };
          yield { type: 'assistant_done', content: 'partial', reasoning: '', usage: { input: 10, output: 2 }, cost: 0.05 };
          await new Promise((resolve) => {
            if (opts.signal?.aborted) resolve();
            else opts.signal?.addEventListener('abort', resolve, { once: true });
          });
          yield { type: 'error', error: '已停止', kind: 'aborted' };
          return;
        }
        yield { type: 'delta', text: '替身回答' };
        yield { type: 'tool_result', id: 't1', name: 'fake', summary: 'ok', ok: true };
        yield { type: 'assistant_done', content: '替身回答', reasoning: '', usage: { input: 1, output: 2 }, cost: 0.5 };
      },
      approveApproval: () => true,
    });
    export default {
      id: 'runner-stub',
      name: 'runner-stub',
      version: '0.1.0',
      onLoad: (ctx) => { ctx.provide('service:runner', stubFactory, 10); },
    };
  `);
  // 装载【真实 core 插件栈】：core 目录不在临时 rootDir 下，需显式指向仓库的 core/
  const corePluginsDir = join(process.cwd(), 'core');
  const kernel = new Kernel(rootDir, {}, { dataDir, userPluginsDir, corePluginsDir });
  kernel.bus.on('stub.runner.called', (e) => calls.push(e.data as StubCall));
  return {
    kernel,
    rootDir,
    calls,
    cleanup: () => {
      try { kernel.trace.flush(); } catch { /* 落盘失败不影响清理 */ }
      try { rmSync(rootDir, { recursive: true, force: true }); } catch { /* 句柄迟释放时留待系统清理 */ }
    },
  };
}

/** 从内核能力表取工具定义（生产代码同款取法） */
function toolOf(kernel: Kernel, name: string): ToolDef {
  const cap = kernel.plugins.capabilities('tool').find((c) => c.tool.name === name);
  assert.ok(cap, `工具 ${name} 应存在`);
  return cap.tool;
}

function toolCtx(rootDir: string, kernel: Kernel): ToolContext {
  return {
    traceId: `seam-${Math.random().toString(36).slice(2, 8)}`,
    turn: 0,
    sandboxRoot: rootDir,
    sessionId: 'seam-session',
    cache: kernel.cache,
    trace: kernel.trace,
  } as ToolContext;
}

after(() => {
  // 无全局状态需要清理：替身调用记录经事件总线采集（每夹具独立总线）
});

describe('执行循环可替换（service:runner）', () => {
  test('装载完整插件栈：默认循环由 chat 插件提供，内核自带实现不参与', async (t) => {
    const f = setup();
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();

    const cands = f.kernel.plugins.bindingCandidates(SERVICE_KEYS.runner);
    const owners = cands.map((c) => c.pluginId).sort();
    assert.deepEqual(owners, ['chat', 'runner-stub'], '两个候选：默认实现 + 接管者');
    assert.equal(cands[0].pluginId, 'runner-stub', '高优先级接管者生效');
    assert.equal(cands[0].active, true);
    assert.equal(f.kernel.plugins.bindingCandidates(SERVICE_KEYS.runner).length, 2);
    // 内核提供的是循环【原语】，不是循环本身——候选里没有 providerId='kernel' 的绑定
    assert.equal(owners.includes('kernel'), false, '内核不自带执行循环（循环由插件提供）');
  });

  test('接管者生效：makeRunner 造出替身循环，且具备完整契约（run + approveApproval）', async (t) => {
    const f = setup();
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();

    const runner = makeRunner(f.kernel, f.kernel.bus);
    assert.ok(runner, '解析到循环实例');
    assert.equal(typeof runner.run, 'function', '工厂产出的事件流入口存在');
    assert.equal(typeof runner.approveApproval, 'function');
    assert.equal(runner.approveApproval('any', true), true, '替身接管了审批入口');
  });

  test('顶层路径消费替身：事件流被完整消费（server 同款调用方式）', async (t) => {
    const f = setup();
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();

    const runner = makeRunner(f.kernel, f.kernel.bus)!;
    let answer = '';
    let cost = 0;
    const events: string[] = [];
    for await (const ev of runner.run({
      provider: { id: 'p', label: 'p', baseUrl: '', apiKey: '', model: 'm' } as unknown as RunOptions['provider'],
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      traceId: 'seam-top',
    } as RunOptions)) {
      events.push((ev as AgentEvent).type);
      if (ev.type === 'delta') answer += ev.text;
      if (ev.type === 'assistant_done') cost = ev.cost;
    }
    assert.equal(answer, '替身回答');
    assert.equal(cost, 0.5);
    assert.deepEqual(events, ['delta', 'tool_result', 'assistant_done']);
  });

  test('子代理路径消费替身：run_subagent 内部循环被替换（不是只改顶层）', async (t) => {
    const f = setup();
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();

    // 子代理需要一个可用的 provider（它从 chat 服务取第一个启用的 provider）
    const chat = f.kernel.plugins.resolveService('service:chat') as { setProviders: (p: unknown[]) => void };
    chat.setProviders([{
      id: 'stub', label: 'stub', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'stub-model',
      protocol: 'openai', models: [], inputPrice: 1, outputPrice: 2,
    }]);

    const before = f.calls.length;
    const tool = toolOf(f.kernel, 'run_subagent');
    const res = await tool.handler({ objective: '做个小事' }, toolCtx(f.rootDir, f.kernel));

    assert.equal(res.ok, true, `子代理应成功: ${JSON.stringify(res)}`);
    assert.ok(f.calls.length > before, '替身循环被调用（子代理用的是被接管的循环）');
    assert.equal((res.data as { answer: string }).answer, '替身回答', '子代理返回替身产出的答案');
    assert.equal(f.calls[f.calls.length - 1]?.model, 'stub-model', '替身收到的运行参数来自子代理路径');
  });

  test('并行路径消费替身：run_parallel 的每个子任务都用被接管的循环', async (t) => {
    const f = setup();
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();

    const chat = f.kernel.plugins.resolveService('service:chat') as { setProviders: (p: unknown[]) => void };
    chat.setProviders([{
      id: 'stub', label: 'stub', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'stub-model',
      protocol: 'openai', models: [], inputPrice: 1, outputPrice: 2,
    }]);

    const before = f.calls.length;
    const tool = toolOf(f.kernel, 'run_parallel');
    const res = await tool.handler(
      { tasks: [{ objective: 'A' }, { objective: 'B' }] },
      toolCtx(f.rootDir, f.kernel),
    );

    assert.equal(res.ok, true, `并行应成功: ${JSON.stringify(res)}`);
    assert.equal(f.calls.length - before, 2, '两个并行子任务各调用一次被接管的循环');
    const data = res.data as { completed: number; results: { answer?: string }[] };
    assert.equal(data.completed, 2);
    assert.equal(data.results[0].answer, '替身回答');
  });

  test('并行压力：四个独立子任务全部启动并聚合，不超过硬上限', async (t) => {
    const f = setup();
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();
    const chat = f.kernel.plugins.resolveService('service:chat') as { setProviders: (p: unknown[]) => void };
    chat.setProviders([{
      id: 'stub', label: 'stub', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'stub-model',
      protocol: 'openai', models: [], inputPrice: 1, outputPrice: 2,
    }]);
    const before = f.calls.length;
    const res = await toolOf(f.kernel, 'run_parallel').handler(
      { tasks: [{ objective: 'A' }, { objective: 'B' }, { objective: 'C' }, { objective: 'D' }] },
      toolCtx(f.rootDir, f.kernel),
    );
    assert.equal(res.ok, true);
    const data = res.data as { status: string; completed: number; failed: number; results: unknown[] };
    assert.equal(data.status, 'completed');
    assert.equal(data.completed, 4);
    assert.equal(data.failed, 0);
    assert.equal(data.results.length, 4);
    assert.equal(f.calls.length - before, 4);
  });

  test('并行资源上限：重叠批次的活动子任务不超过 8，超限批次不启动', async (t) => {
    const f = setup();
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();
    const chat = f.kernel.plugins.resolveService('service:chat') as { setProviders: (p: unknown[]) => void };
    chat.setProviders([{
      id: 'stub', label: 'stub', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'stub-model',
      protocol: 'openai', models: [], inputPrice: 1, outputPrice: 2,
    }]);
    let active = 0;
    let peak = 0;
    f.kernel.bus.on('stub.runner.capacity', (event) => {
      active = (event.data as { active: number }).active;
      peak = Math.max(peak, active);
    });
    const tool = toolOf(f.kernel, 'run_parallel');
    const batch = (name: string) => tool.handler({ tasks: Array.from({ length: 4 }, (_, i) => ({ objective: `capacity-delay ${name}-${i}` })) }, toolCtx(f.rootDir, f.kernel));
    const p1 = batch('one');
    const p2 = batch('two');
    const p3 = batch('three');
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(r3.ok, false);
    assert.match(String(r3.error), /资源繁忙/);
    assert.equal(peak, 8);
    assert.equal(active, 0);
  });

  test('跨工具共享资源上限：run_subagent 占用槽位后，run_parallel 按同一总量拒绝超额', async (t) => {
    const f = setup();
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();
    const chat = f.kernel.plugins.resolveService('service:chat') as { setProviders: (p: unknown[]) => void };
    chat.setProviders([{
      id: 'stub', label: 'stub', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'stub-model',
      protocol: 'openai', models: [], inputPrice: 1, outputPrice: 2,
    }]);
    let subagentStarted!: () => void;
    const started = new Promise<void>((resolve) => { subagentStarted = resolve; });
    const off = f.kernel.bus.on('stub.runner.capacity', (event) => {
      if ((event.data as { active: number }).active === 1) { off(); subagentStarted(); }
    });
    const subagent = toolOf(f.kernel, 'run_subagent').handler({ objective: 'capacity-delay standalone' }, toolCtx(f.rootDir, f.kernel));
    await started;
    const parallel = toolOf(f.kernel, 'run_parallel');
    const batch = (name: string) => parallel.handler(
      { tasks: Array.from({ length: 4 }, (_, i) => ({ objective: `capacity-delay ${name}-${i}` })) },
      toolCtx(f.rootDir, f.kernel),
    );
    const [accepted, rejected] = await Promise.all([batch('accepted'), batch('rejected')]);
    assert.equal(accepted.ok, true);
    assert.equal(rejected.ok, false);
    assert.match(String(rejected.error), /资源繁忙/);
    assert.equal(f.kernel.budget.activeSubagentCount(), 0);
    const subagentResult = await subagent;
    assert.equal(subagentResult.ok, true);
  });

  test('并行取消传播：父 signal 取消全部子任务，保留已结算成本', async (t) => {
    const f = setup();
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();
    const chat = f.kernel.plugins.resolveService('service:chat') as { setProviders: (p: unknown[]) => void };
    chat.setProviders([{
      id: 'stub', label: 'stub', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'stub-model',
      protocol: 'openai', models: [], inputPrice: 1, outputPrice: 2,
    }]);

    const controller = new AbortController();
    const started = new Promise<void>((resolve) => {
      const off = f.kernel.bus.on('stub.runner.called', () => {
        if (f.calls.length === 2) { off(); resolve(); }
      });
    });
    const handlerPromise = toolOf(f.kernel, 'run_parallel').handler(
      { tasks: [{ objective: 'wait-for-abort A' }, { objective: 'wait-for-abort B' }] },
      { ...toolCtx(f.rootDir, f.kernel), signal: controller.signal },
    );
    await started;
    assert.ok(f.calls.every((c) => c.hasSignal), '父取消信号已透传到每个子 runner');
    controller.abort();
    const res = await handlerPromise;
    assert.equal(res.ok, false, '全部子任务取消属于并行工具失败，不应伪装为成功');
    const data = res.data as { status: string; cancelled: number; completed: number; results: { cancelled?: boolean }[]; subagentCost: { cost: number; tokensIn: number } };
    assert.equal(data.status, 'failed');
    assert.equal(data.cancelled, 2);
    assert.equal(data.completed, 0);
    assert.ok(data.results.every((r) => r.cancelled));
    assert.equal(data.subagentCost.cost, 0.1);
    assert.equal(data.subagentCost.tokensIn, 20);
    assert.equal(f.kernel.budget.activeSubagentCount(), 0, '取消后所有并行活动槽位均已释放');
  });

  test('接管者停用 → 自动回退默认循环；重新启用 → 再次接管', async (t) => {
    const f = setup();
    t.after(f.cleanup);
    await f.kernel.plugins.loadAll();
    assert.equal(f.kernel.plugins.bindingCandidates(SERVICE_KEYS.runner)[0].pluginId, 'runner-stub');

    await f.kernel.plugins.disable('runner-stub');
    const afterDisable = f.kernel.plugins.bindingCandidates(SERVICE_KEYS.runner);
    assert.deepEqual(afterDisable.map((c) => c.pluginId), [CHAT_PLUGIN_ID], '回退到默认循环');
    assert.ok(makeRunner(f.kernel, f.kernel.bus), '服务不消失（回退而非清空）');

    await f.kernel.plugins.enable('runner-stub');
    assert.equal(f.kernel.plugins.bindingCandidates(SERVICE_KEYS.runner).filter((c) => c.active)[0].pluginId, 'runner-stub');
  });
});
