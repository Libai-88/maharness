import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compactHistory, truncateHistory, SUMMARY_MARK } from '../compact';
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
