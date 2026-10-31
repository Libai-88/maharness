import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Kernel } from '../../kernel';
import type { ChatOptions, LLMMessage, ProviderDef, ToolDef } from '../../kernel/types';
import { registerConfigRoutes } from '../routes/config';
import { scheduleWarmup, warmupOnce } from '../routes/warmup';

describe('LR-05 warmup cancellation', () => {
  test('switching cache.warmup off aborts an in-flight provider stream', async () => {
    let providerSignal: AbortSignal | undefined;
    let finishStream: (() => void) | undefined;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    const provider = {
      id: 'fixture', label: 'Fixture', defaultModel: 'test',
      chat: (_messages: LLMMessage[], opts: ChatOptions) => {
        providerSignal = opts.signal;
        resolveStarted();
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<{ done: boolean; value?: never }>((_resolve, reject) => {
                finishStream = () => reject(new DOMException('The operation was aborted', 'AbortError'));
                opts.signal?.addEventListener('abort', () => finishStream?.(), { once: true });
              }),
            };
          },
        };
      },
    } as unknown as ProviderDef;

    let warmupMode: 'auto' | 'off' = 'auto';
    const kernel = {
      plugins: {
        resolveService: () => ({
          textualizeHistory: (messages: LLMMessage[]) => messages,
          annotateToolDef: (tool: ToolDef) => tool,
        }),
        capabilities: () => [],
      },
      config: {
        get: () => warmupMode,
        setPersistent: (_key: string, value: unknown) => { warmupMode = value as 'auto' | 'off'; },
      },
    } as unknown as Kernel;

    let patchHandler: ((req: unknown, res: unknown) => void) | undefined;
    const app = {
      get: () => app,
      patch: (_path: string, handler: typeof patchHandler) => { patchHandler = handler; return app; },
      post: () => app,
    };
    registerConfigRoutes(app as never, { kernel } as never);

    scheduleWarmup('session-warmup-cancel', 'system', [{ role: 'user', content: 'task' }], provider, 'test', kernel);
    const running = warmupOnce('session-warmup-cancel', kernel);
    await started;
    assert.ok(providerSignal);
    assert.equal(providerSignal.aborted, false);

    let responseStatus = 200;
    let responseBody: unknown;
    patchHandler?.(
      { body: { cache: { warmup: 'off' } } },
      { status: (code: number) => { responseStatus = code; return { json: (body: unknown) => { responseBody = body; } }; }, json: (body: unknown) => { responseBody = body; } },
    );

    await running;
    assert.equal(responseStatus, 200);
    assert.deepEqual(responseBody, { ok: true, revision: 'unversioned' });
    assert.equal(warmupMode, 'off');
    assert.equal(providerSignal.aborted, true);
  });
});
