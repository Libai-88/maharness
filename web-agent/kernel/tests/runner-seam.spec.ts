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
interface StubCall { systemPrompt?: string; model?: string }

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
    const stubFactory = (kernel, bus) => ({
      async *run(opts) {
        bus.emit({ type: 'stub.runner.called', ts: Date.now(), data: { systemPrompt: opts.systemPrompt, model: opts.model } });
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
