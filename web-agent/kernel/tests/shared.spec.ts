/**
 * kernel/tests/shared.spec.ts —— 跨模块副本的共享单例（缺陷 B13 回归）
 *
 * 背景：插件从内容快照目录 `core/<name>@<hash>/` 加载，而 server/scripts 可能 import
 * 活目录 `core/<name>/` —— Node ESM 视其为两个模块实例。若插件把可变状态写成裸的
 * 模块顶层 `new Map()`，就会「写一份、读另一份」：
 *   - result-store：执行器 put 在快照副本，recall/测试 get 在活副本 → 重读必然 miss；
 *   - provider-health：agent 记账在快照副本，/api/providers 读活副本 → 故障红标永不出现。
 * 本测试用**同一份源码的两个不同路径副本**模拟该情形，断言状态确实共享。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sharedSingleton, peekShared, __resetSharedForTests } from '../shared';

const webAgentRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 把插件模块源码复制成独立路径的副本，并把相对导入改写为绝对 file URL
 *  （副本落在临时目录，`../../kernel/…` 会指向不存在的位置） */
function copyModule(srcRelPath: string, copyName: string, dir: string): string {
  const src = readFileSync(join(webAgentRoot, srcRelPath), 'utf-8');
  const absOf = (spec: string): string =>
    pathToFileURL(join(webAgentRoot, dirname(srcRelPath), spec)).href;
  const patched = src.replace(/from '(\.\.?\/[^']+)'/g, (_m, spec: string) => `from '${absOf(spec)}'`);
  const file = join(dir, `${copyName}.ts`);
  writeFileSync(file, patched, 'utf-8');
  return pathToFileURL(file).href;
}

describe('sharedSingleton —— 跨副本共享', () => {
  test('同 key 返回同一实例；make 只执行一次', () => {
    __resetSharedForTests();
    let calls = 0;
    const a = sharedSingleton('test.thing', () => { calls++; return { n: 1 }; });
    const b = sharedSingleton('test.thing', () => { calls++; return { n: 2 }; });
    assert.equal(a, b);
    assert.equal(calls, 1);
    assert.deepEqual(a, { n: 1 }, '先到者的实例胜出');
    assert.equal(peekShared('test.thing'), a);
    assert.equal(peekShared('test.missing'), undefined, 'peek 不创建实例');
    __resetSharedForTests();
    assert.equal(peekShared('test.thing'), undefined);
  });

  test('result-store：两个模块副本共享同一存储（put 在 A，get 在 B）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-shared-rs-'));
    try {
      const urlA = copyModule(join('core', 'chat', 'result-store.ts'), 'rs-copy-a', dir);
      const urlB = copyModule(join('core', 'chat', 'result-store.ts'), 'rs-copy-b', dir);
      const a = await import(urlA) as { resultStore: { put(k: string, id: string, v: string): void } };
      const b = await import(urlB) as { resultStore: { get(k: string, id: string): string | undefined } };
      assert.notEqual(a, b, '确实是两个模块实例（否则本测试没有意义）');

      a.resultStore.put('sess-1', 'call-1', '完整结果');
      assert.equal(b.resultStore.get('sess-1', 'call-1'), '完整结果',
        '跨副本必须读到（缺陷 B13 的失败形态是 undefined → recall 报"结果不存在或已淘汰"）');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('provider-health：两个模块副本共享同一健康表', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-shared-ph-'));
    try {
      const urlA = copyModule(join('core', 'chat', 'provider-health.ts'), 'ph-copy-a', dir);
      const urlB = copyModule(join('core', 'chat', 'provider-health.ts'), 'ph-copy-b', dir);
      const a = await import(urlA) as { noteProviderFailure(id: string, e: unknown): void };
      const b = await import(urlB) as { getProviderHealth(id: string): { failures: number; authFailed: boolean } | undefined };

      a.noteProviderFailure('p1', Object.assign(new Error('HTTP 401 unauthorized'), { status: 401 }));
      const seen = b.getProviderHealth('p1');
      assert.ok(seen, '记账必须跨副本可见（否则设置页永远看不到红标）');
      assert.equal(seen!.failures, 1);
      assert.equal(seen!.authFailed, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
