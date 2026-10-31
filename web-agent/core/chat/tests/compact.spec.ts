import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compactHistory, contextBoundaryPreservesTools, contextIntegrityPreservesConstraints, truncateHistory, SUMMARY_MARK } from '../compact';
import type { LLMMessage, ProviderDef } from '../../../kernel/types';

/** 摘要器替身：返回固定文本（默认以摘要标记开头，模拟"模型配合"） */
const stubProvider = (reply: string): ProviderDef => ({
  id: 'stub', label: 'STUB', defaultModel: 'stub-model', protocol: 'openai',
  chat: async function* () {
    yield { type: 'delta', text: reply };
    yield { type: 'done' };
  },
});

const L0 = '【L0 哨兵】你是小马：以工具为感官，以行动完成使命，以诚实回报信任。';

/** 造一段必然超预算的对话（CJK ≈ 1 token/字） */
const longDialog = (n: number): LLMMessage[] => Array.from({ length: n }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `第 ${i} 条历史消息：这是一段用于把上下文推过预算的长文本，内容本身无意义。`,
}));

describe('compactHistory：头部 system（L0 系统提示词）必须原样保留', () => {
  it('循环内压缩（history[0] 为 L0）后，L0 逐字节保留且压缩确实发生', async () => {
    const history: LLMMessage[] = [{ role: 'system', content: L0 }, ...longDialog(10)];
    const r = await compactHistory(history, 100, { provider: stubProvider(`${SUMMARY_MARK}用户在做一件事。`), model: 'stub-model' });

    assert.equal(r.mode, 'compact', '应走 LLM 摘要压缩路径');
    assert.equal(r.messages[0].role, 'system');
    assert.equal(r.messages[0].content, L0, 'L0 必须逐字节保留（修复前会被摘要顶掉）');
    // 摘要与保留段都在
    assert.ok(r.messages.some((m) => String(m.content ?? '').startsWith(SUMMARY_MARK)), '应有摘要消息');
    assert.ok(r.messages.length < history.length, '压缩应减少消息条数');
    // 头部只有一个 system：原 L0 + 新摘要（不能把 L0 变成摘要）
    const systems = r.messages.filter((m) => m.role === 'system');
    assert.equal(systems.length, 2);
    assert.equal(systems[0].content, L0);
    assert.ok(String(systems[1].content).startsWith(SUMMARY_MARK));
  });

  it('摘要失败降级为截断时，L0 同样保留', async () => {
    const history: LLMMessage[] = [{ role: 'system', content: L0 }, ...longDialog(10)];
    // 模型不配合（输出不以标记开头）→ summarizeSegment 返回 null → 降级 truncate
    const r = await compactHistory(history, 100, { provider: stubProvider('我直接总结一下：巴拉巴拉'), model: 'stub-model' });

    assert.equal(r.mode, 'truncate');
    assert.equal(r.messages[0].content, L0);
  });

  it('已有摘要锚点且锚点在头部：锚点参与合并，不产生重复 L0', async () => {
    const anchor: LLMMessage = { role: 'system', content: `${SUMMARY_MARK}旧摘要事实。` };
    const history: LLMMessage[] = [anchor, ...longDialog(10)];
    const r = await compactHistory(history, 100, { provider: stubProvider(`${SUMMARY_MARK}合并后的新摘要。`), model: 'stub-model' });

    assert.equal(r.mode, 'compact');
    assert.equal(r.messages[0].role, 'system');
    assert.ok(String(r.messages[0].content).startsWith(SUMMARY_MARK));
    assert.match(String(r.messages[0].content), /合并后的新摘要/);
    assert.equal(r.messages.filter((m) => m.role === 'system').length, 1, '旧锚点被合并，不应出现第二条 system');
  });

  it('锚点之前还有头部 system（非常规）时，头部 system 仍保留', async () => {
    const history: LLMMessage[] = [
      { role: 'system', content: L0 },
      { role: 'system', content: `${SUMMARY_MARK}旧摘要。` },
      ...longDialog(10),
    ];
    const r = await compactHistory(history, 100, { provider: stubProvider(`${SUMMARY_MARK}合并后的新摘要。`), model: 'stub-model' });

    assert.equal(r.mode, 'compact');
    assert.equal(r.messages[0].content, L0, '锚点之前的头部 system 属于 prefix，必须保留');
    assert.match(String(r.messages[1].content), /合并后的新摘要/);
  });

  it('无头部 system 时保持原有行为（最早段被压缩，摘要在首位）', async () => {
    const history = longDialog(10);
    const r = await compactHistory(history, 100, { provider: stubProvider(`${SUMMARY_MARK}摘要。`), model: 'stub-model' });

    assert.equal(r.mode, 'compact');
    assert.equal(r.messages[0].role, 'system');
    assert.ok(String(r.messages[0].content).startsWith(SUMMARY_MARK));
  });

  it('未超预算时原样返回（mode=none，保持同一引用）', async () => {
    const history: LLMMessage[] = [{ role: 'system', content: L0 }, { role: 'user', content: '你好' }];
    const r = await compactHistory(history, 100_000, { provider: stubProvider('x'), model: 'stub-model' });
    assert.equal(r.mode, 'none');
    assert.equal(r.messages, history);
  });
});

describe('truncateHistory：兼容导出仍保留头部 system', () => {
  it('截断兜底不丢 L0', () => {
    const history: LLMMessage[] = [{ role: 'system', content: L0 }, ...longDialog(10)];
    const r = truncateHistory(history, 100);
    assert.equal(r.truncated, true);
    assert.equal(r.messages[0].content, L0);
    assert.ok(r.droppedMessages > 0);
  });
});

describe('compactHistory：Provider tokenizer 适配', () => {
  it('使用 Provider tokenizer 的消息计数，而不是仅按字符估算', async () => {
    const provider = stubProvider(`${SUMMARY_MARK}按原生 tokenizer 压缩。`);
    provider.tokenizer = {
      id: 'test-tokenizer',
      countText: (text) => text.length,
      countMessages: (messages) => messages.length * 50,
    };
    const history: LLMMessage[] = Array.from({ length: 5 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' }));
    const result = await compactHistory(history, 100, { provider, model: 'stub-model' });
    assert.equal(result.mode, 'compact');
    assert.ok(result.compactedMessages > 0);
  });
});

describe('compactHistory：工具调用完整性', () => {
  it('切点不会拆开 assistant tool_call 与 tool 回执', async () => {
    const history: LLMMessage[] = [
      { role: 'user', content: '先查资料' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search', arguments: '{}' } }] },
      { role: 'tool', content: '结果', tool_call_id: 'call-1' },
      { role: 'user', content: '继续总结这件事' },
      { role: 'assistant', content: '当前结论' },
      { role: 'user', content: '再补充一句' },
    ];
    assert.equal(contextBoundaryPreservesTools(history, 2), false);
    assert.equal(contextBoundaryPreservesTools(history, 3), true);
    const result = await compactHistory(history, 20, { provider: stubProvider(`${SUMMARY_MARK}保留工具事实。`), model: 'stub-model' });
    const ids = result.messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id);
    const calls = result.messages.flatMap((message) => Array.isArray(message.tool_calls) ? message.tool_calls.map((call) => (call as { id: string }).id) : []);
    assert.deepEqual(ids, calls.filter((id) => ids.includes(id)));
  });
});

describe('compactHistory：任务与记忆约束完整性', () => {
  it('压缩切点跳过任务/验收/记忆约束消息并逐字保留', async () => {
    const constraints: LLMMessage[] = [
      { role: 'system', content: '【任务约束】必须在工作区完成任务。' },
      { role: 'system', content: '【验收条件】输出必须包含 READY。' },
      { role: 'user', content: '【核心记忆块】用户偏好：中文回复。' },
      { role: 'user', content: '【长期记忆】项目主目录是 maharness。' },
      ...longDialog(10),
    ];
    const result = await compactHistory(constraints, 100, { provider: stubProvider(`${SUMMARY_MARK}早期事实。`), model: 'stub-model' });
    assert.equal(result.mode, 'compact');
    assert.equal(contextIntegrityPreservesConstraints(constraints, result.messages), true);
    for (const message of constraints.slice(0, 4)) {
      assert.ok(result.messages.some((candidate) => candidate.content === message.content));
    }
  });

  it('发现约束丢失时返回 false，作为压缩后的 fail-closed 守卫', () => {
    const before: LLMMessage[] = [{ role: 'system', content: '【验收条件】必须包含 READY。' }];
    const after: LLMMessage[] = [{ role: 'system', content: `${SUMMARY_MARK}READY` }];
    assert.equal(contextIntegrityPreservesConstraints(before, after), false);
  });
});

describe('compactHistory：可解释来源', () => {
  it('压缩 Trace 同时记录来源范围与压缩原因', async () => {
    const finished: Array<Record<string, unknown>> = [];
    const trace = {
      startStep: () => ({
        id: 'compact-step',
        finish: (extra?: Record<string, unknown>) => finished.push(extra ?? {}),
        fail: () => undefined,
        cancel: () => undefined,
      }),
    } as never;
    const result = await compactHistory([{ role: 'system', content: L0 }, ...longDialog(10)], 100, {
      provider: stubProvider(`${SUMMARY_MARK}可追溯摘要。`), model: 'stub-model', trace,
    });
    assert.equal(result.mode, 'compact');
    assert.match(String(finished[0]?.inputSummary), /^history\[\d+\.\.\d+\]/);
    assert.match(String(finished[0]?.outputSummary), /LLM 摘要压缩/);
  });
});
