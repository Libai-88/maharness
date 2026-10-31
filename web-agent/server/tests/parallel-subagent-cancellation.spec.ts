/** LR-05：父任务停止（客户端断开）后，子代理与并行子任务必须全部中止并回收。 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatOptions, LLMMessage, ProviderDef } from '../../kernel/types';

const tmp = mkdtempSync(join(tmpdir(), 'mh-cancel-'));
const dataDir = join(tmp, 'data');
const pluginsDir = join(tmp, 'plugins');
mkdirSync(dataDir, { recursive: true });
mkdirSync(pluginsDir, { recursive: true });

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return port;
}

const port = await freePort();
process.env.AGENT_ROOT = join(import.meta.dirname, '..', '..');
process.env.PORT = String(port);
process.env.AGENT_DATA_DIR = dataDir;
process.env.AGENT_USER_PLUGINS_DIR = pluginsDir;
process.env.SANDBOX_ROOT = join(tmp, 'workspace');
process.env.MAHARNESS_SECRET_KEY_ACL = '0';

const { startServer } = await import('../index');
const base = `http://127.0.0.1:${port}`;
let started: Awaited<ReturnType<typeof startServer>> | undefined;

interface CancelFixture {
  provider: ProviderDef;
  childSignals: AbortSignal[];
  stats(): { calls: number; active: number; peakActive: number };
}

/** 首轮发出委派工具调用；每个子任务的 LLM 流挂起直到 abort 才抛出取消错误。 */
function makeCancellableProvider(toolName: 'run_subagent' | 'run_parallel', childCount: number): CancelFixture {
  let calls = 0;
  let active = 0;
  let peakActive = 0;
  const childSignals: AbortSignal[] = [];
  const provider: ProviderDef = {
    id: `cancel-${toolName}-provider`, label: 'Cancel Fixture', defaultModel: 'cancel-model',
    async *chat(_messages: LLMMessage[], opts: ChatOptions) {
      const call = ++calls;
      if (call === 1) {
        const childArgs = toolName === 'run_subagent'
          ? JSON.stringify({ objective: 'cancel-child-20261031' })
          : JSON.stringify({ tasks: Array.from({ length: childCount }, (_, i) => ({ objective: `cancel-child-${i}-20261031` })) });
        yield { type: 'tool_call', toolCall: { id: `cancel-call-${call}`, type: 'function', function: { name: toolName, arguments: childArgs } } };
        return;
      }
      active++;
      peakActive = Math.max(peakActive, active);
      childSignals.push(opts.signal!);
      try {
        await new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(new DOMException('The operation was aborted', 'AbortError'));
          if (opts.signal?.aborted) onAbort();
          else opts.signal?.addEventListener('abort', onAbort, { once: true });
        });
      } finally {
        active--;
      }
      yield { type: 'delta', text: 'unreachable' };
      yield { type: 'usage', input: 1, output: 1 };
      yield { type: 'done' };
    },
  };
  return { provider, childSignals, stats: () => ({ calls, active, peakActive }) };
}

async function startChat(sessionId: string, message: string): Promise<Response> {
  const response = await fetch(`${base}/api/sessions/${sessionId}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  assert.equal(response.status, 200);
  return response;
}

before(async () => {
  started = await startServer();
  started.kernel.config.set('cache.warmup', 'off');
  started.kernel.config.set('agent.modelRouting', {});
});

after(async () => {
  started?.server.close();
  started?.closeEnvWatcher();
  started?.store.close();
  try { await started?.kernel.stop(); } catch { /* 测试清理不影响断言结果 */ }
  rmSync(tmp, { recursive: true, force: true });
});

describe('LR-05 父任务停止传播到子代理与并行子任务', () => {
  test('就绪端点暴露运行时句柄计数，取消后 activeRuns 归零', async () => {
    assert.ok(started);
    const ready = await fetch(`${base}/api/ready`);
    const body = await ready.json() as { resources?: { activeRuns?: number; sseConnections?: number; pageConnections?: number; pendingApprovals?: number; activeWarmups?: number; activeSubagentSlots?: number } };
    assert.equal(body.resources?.activeRuns, 0);
    assert.equal(typeof body.resources?.sseConnections, 'number');
    assert.equal(typeof body.resources?.pageConnections, 'number');
    assert.equal(typeof body.resources?.pendingApprovals, 'number');
    assert.equal(typeof body.resources?.activeWarmups, 'number');
    assert.equal(body.resources?.activeSubagentSlots, 0);
  });

  test('停止后并行子任务全部取消，5 秒内无活动模型调用', async () => {
    assert.ok(started);
    const fixture = makeCancellableProvider('run_parallel', 4);
    (started.kernel.plugins.resolveService('service:chat') as { providers: ProviderDef[] }).providers = [fixture.provider];
    const progress: { phase?: string; detail?: { cancelled?: boolean } }[] = [];
    const bus = started.kernel.bus as unknown as { on(type: string, listener: (event: { data: unknown }) => void): () => void };
    const off = bus.on('parallel.progress', (event) => progress.push(event.data as typeof progress[number]));
    const session = started.store.createSession('cancel-model', 'cancel-run_parallel-provider');
    const ac = new AbortController();
    const response = await startChat(session.id, '执行四项并行子任务');
    const reader = response.body!.getReader();
    // 等到 4 个子任务都已发起 LLM 调用再停止
    while (fixture.childSignals.length < 4) await new Promise((r) => setTimeout(r, 10));
    const abortTs = Date.now();
    ac.abort();
    reader.cancel().catch(() => { /* 客户端断开本身即测试目标 */ });
    while (fixture.stats().active > 0 || !fixture.childSignals.every((s) => s.aborted)) {
      assert.ok(Date.now() - abortTs < 5000, '取消后 5 秒内子任务流必须全部回收');
      await new Promise((r) => setTimeout(r, 20));
    }
    off();
    assert.equal(fixture.stats().peakActive, 4);
    assert.equal(fixture.stats().calls, 5, '取消后父循环不得再发起新一轮模型调用');
    const fails = progress.filter((event) => event.phase === 'fail');
    assert.equal(fails.length, 4, '四个子任务都应以取消收尾');
    for (const event of fails) assert.equal(event.detail?.cancelled, true);
  });

  test('停止后单个子代理中止且不再消耗新一轮调用', async () => {
    assert.ok(started);
    const fixture = makeCancellableProvider('run_subagent', 1);
    (started.kernel.plugins.resolveService('service:chat') as { providers: ProviderDef[] }).providers = [fixture.provider];
    const session = started.store.createSession('cancel-model', 'cancel-run_subagent-provider');
    const ac = new AbortController();
    const response = await startChat(session.id, '委派子代理侦查');
    const reader = response.body!.getReader();
    while (fixture.childSignals.length < 1) await new Promise((r) => setTimeout(r, 10));
    const abortTs = Date.now();
    ac.abort();
    reader.cancel().catch(() => { /* 同上 */ });
    while (fixture.stats().active > 0 || !fixture.childSignals[0]?.aborted) {
      assert.ok(Date.now() - abortTs < 5000, '取消后 5 秒内子代理流必须回收');
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(fixture.stats().calls, 2, '取消后父循环不得再发起新一轮模型调用');
  });
});
