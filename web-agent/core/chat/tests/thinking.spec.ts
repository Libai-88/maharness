// core/chat/tests/thinking.spec.ts —— 思考标签分流/剥离（MiniMax M2 / DeepSeek-R1 / QwQ 等内联 think 块）
// 注意：测试里的标签一律程序化构造（mkOpen/mkClose），不书写裸标签字面量
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripThinking, ThinkTagStreamSplitter } from '../agent';

const mkOpen = (n: string) => `<${n}>`;
const mkClose = (n: string) => `</${n}>`;
const THINK = 'think';
const THINKING = 'thinking';
const THOUGHT = 'thought';
const REASONING = 'reasoning';

function split(parts: string[]): { out: string; think: string } {
  const s = new ThinkTagStreamSplitter();
  let out = '';
  let think = '';
  s.onOut = (t) => { out += t; };
  s.onThink = (t) => { think += t; };
  for (const p of parts) s.push(p);
  s.end();
  return { out, think };
}

describe('stripThinking', () => {
  it('剥离闭合 think 块并回填 reasoning', () => {
    const text = `${mkOpen(THINK)}先想一下\n${mkClose(THINK)}\n\n在的，有什么可以帮你？`;
    const r = stripThinking(text, '');
    assert.equal(r.clean, '在的，有什么可以帮你？');
    assert.equal(r.extracted, '先想一下');
  });

  it('剥离未闭合 think 块（流截断）', () => {
    const r = stripThinking(`${mkOpen(THINK)}用户打了招呼，`, '');
    assert.equal(r.clean, '');
    assert.equal(r.extracted, '用户打了招呼，');
  });

  it('剥离 thinking / thought / reasoning 变体标签', () => {
    assert.equal(stripThinking(`${mkOpen(THINKING)}想${mkClose(THINKING)}答`, '').clean, '答');
    assert.equal(stripThinking(`${mkOpen(THOUGHT)}想${mkClose(THOUGHT)}答`, '').clean, '答');
    assert.equal(stripThinking(`${mkOpen(REASONING)}想${mkClose(REASONING)}答`, '').clean, '答');
  });

  it('已有原生 reasoning 时不回填，但仍清洗正文', () => {
    const r = stripThinking(`${mkOpen(THINKING)}想${mkClose(THINKING)}答`, '原生思考');
    assert.equal(r.clean, '答');
    assert.equal(r.extracted, '');
  });

  it('无思考标签的正文原样返回', () => {
    const r = stripThinking('普通回答 <b>加粗</b>', '');
    assert.equal(r.clean, '普通回答 <b>加粗</b>');
    assert.equal(r.extracted, '');
  });

  it('行级思考标记：标记行起全部视为思考（沿用历史语义）', () => {
    const r = stripThinking('正文前\n【思考】先想\n这些也是思考', '');
    assert.equal(r.clean, '正文前');
    assert.ok(r.extracted.includes('先想'));
  });

  it('多块思考 + 中间正文（M2 真实形态）', () => {
    const text = `${mkOpen(THINK)}第一段思考${mkClose(THINK)}\n\n中间结论\n\n${mkOpen(THINK)}第二段思考${mkClose(THINK)}\n\n最终答案`;
    const r = stripThinking(text, '');
    assert.equal(r.clean, '中间结论\n\n最终答案');
    assert.ok(r.extracted.includes('第一段'));
    assert.ok(r.extracted.includes('第二段'));
  });
});

describe('ThinkTagStreamSplitter', () => {
  it('整块一次到达', () => {
    const { out, think } = split([`${mkOpen(THINK)}想法${mkClose(THINK)}答案`]);
    assert.equal(out, '答案');
    assert.equal(think, '想法');
  });

  it('闭标签跨 chunk 碎片（逐段喂入不误放行）', () => {
    const { out, think } = split([`${mkOpen(THINK)}一`, '段思', '考</th', 'ink>正文']);
    assert.equal(out, '正文');
    assert.equal(think, '一段思考');
  });

  it('开标签跨 chunk（标签名被切成两半）', () => {
    const { out, think } = split(['<th', 'ink>想法', `${mkClose(THINK)}答`]);
    assert.equal(out, '答');
    assert.equal(think, '想法');
  });

  it('正文中的字面 < 不被吞（a < b 与 markdown 标签）', () => {
    const { out } = split(['a < b 和 <br> 换行']);
    assert.equal(out, 'a < b 和 <br> 换行');
  });

  it('多个思考块交替', () => {
    const { out, think } = split([`${mkOpen(THINK)}一${mkClose(THINK)}A${mkOpen(THINKING)}二${mkClose(THINKING)}B`]);
    assert.equal(out, 'AB');
    assert.equal(think, '一二');
  });

  it('流截断：未闭合块整体归思考', () => {
    const { out, think } = split([`答案。${mkOpen(THINK)}还没说完`]);
    assert.equal(out, '答案。');
    assert.equal(think, '还没说完');
  });

  it('大小写不敏感', () => {
    const { out, think } = split([`<THINK>想${mkClose(THINK)}答`]);
    assert.equal(out, '答');
    assert.equal(think, '想');
  });

  it('开标签后紧跟的换行被吞（避免 reasoning 前导空行）', () => {
    const { think } = split([`${mkOpen(THINK)}\n想法${mkClose(THINK)}`]);
    assert.equal(think, '想法');
  });
});
