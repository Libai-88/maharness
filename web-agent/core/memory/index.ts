/**
 * core/memory/index.ts —— 长期记忆插件
 * 钩子管线（agent.before_llm）的首个实战消费者：
 *   每轮对话开始前，把最近记忆作为一条 user 消息追加到 history 末尾注入 LLM。
 *   追加在末尾 = 不动 system prompt 与历史前缀 → 不破坏 L3 provider KV 缓存命中。
 * 持久化：data/memory.json（facts 列表，上限 200 条，最旧淘汰；重启不丢）。
 * 工具：remember_fact / recall_facts / forget_fact。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { AgentHookCtx } from '../chat/agent';
import type { Plugin } from '../../kernel/types';

const rootDir = fileURLToPath(new URL('../..', import.meta.url));
const dataDir = join(rootDir, 'data');
const memoryFile = join(dataDir, 'memory.json');

const MAX_FACTS = 200;
const INJECT_COUNT = 5;       // 每轮注入最近 N 条记忆

interface Fact { id: string; text: string; ts: number }

/** 加载/保存记忆（同步、容错） */
function loadFacts(): Fact[] {
  try {
    if (!existsSync(memoryFile)) return [];
    const raw = JSON.parse(readFileSync(memoryFile, 'utf-8')) as { facts?: Fact[] };
    return Array.isArray(raw.facts) ? raw.facts : [];
  } catch { return []; }
}

function saveFacts(facts: Fact[]): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(memoryFile, JSON.stringify({ facts }, null, 2), 'utf8');
  } catch { /* 持久化失败不阻断对话 */ }
}

export default {
  id: 'memory',
  name: '长期记忆',
  version: '0.1.0',
  onLoad(ctx) {
    const facts = loadFacts();

    const persist = () => saveFacts(facts);
    const remember = (text: string): Fact => {
      const f: Fact = { id: randomUUID().slice(0, 8), text, ts: Date.now() };
      facts.push(f);
      if (facts.length > MAX_FACTS) facts.splice(0, facts.length - MAX_FACTS);
      persist();
      return f;
    };

    // ---- 钩子：每轮 LLM 调用前注入记忆（追加到 history 末尾，保持前缀稳定） ----
    ctx.bus.on('agent.before_llm', (e) => {
      const h = e.data as AgentHookCtx;
      if (!h || !Array.isArray(h.history) || h.scratchpad.memoryInjected) return;
      if (facts.length === 0) return;
      const recent = facts.slice(-INJECT_COUNT).reverse();
      h.history.push({
        role: 'user',
        content: `【长期记忆】（来自之前会话，供参考）\n${recent.map((f) => `- ${f.text}`).join('\n')}`,
      });
      h.scratchpad.memoryInjected = true;
    });

    // ---- L2 人设：记忆使用规则 ----
    ctx.register({
      kind: 'persona',
      persona: {
        id: 'memory-rules',
        name: '长期记忆使用规则',
        description: '约束 LLM 正确使用长期记忆',
        priority: 8,
        content: [
          '长期记忆规则：',
          '1. 用户告知的偏好、重要事实、任务结论，用 remember_fact 记住（一句话一条）；',
          '2. 回答涉及先前信息时，先用 recall_facts 查询相关记忆，再回答；',
          '3. 每轮对话开始会自动注入最近记忆（勿重复要求，也不要逐条复述）；',
          '4. 记忆与事实不符或用户否认时，用 forget_fact 删除，不要带着错误记忆回答；',
          '5. 不要记忆敏感信息（密码、密钥等）。',
        ].join('\n'),
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'remember_fact',
        description: '记住一条长期事实（跨会话有效，持久化到 data/memory.json）。用于用户偏好、重要信息、任务结论。',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', description: '事实内容（一句话，简洁完整）' } },
          required: ['text'],
        },
        async handler(args: { text?: string }) {
          const text = String(args.text ?? '').trim();
          if (!text) return { ok: false, error: '缺少 text' };
          const f = remember(text);
          return { ok: true, data: { id: f.id, count: facts.length } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'recall_facts',
        description: '查询长期记忆（按关键词过滤，返回最近 20 条；不传关键词返回全部最近记忆）。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '可选：关键词（大小写不敏感）' } },
        },
        async handler(args: { query?: string }) {
          const q = String(args.query ?? '').trim().toLowerCase();
          const list = [...facts]
            .reverse()
            .filter((f) => !q || f.text.toLowerCase().includes(q))
            .slice(0, 20)
            .map((f) => ({ id: f.id, text: f.text, ts: f.ts }));
          return { ok: true, data: { count: list.length, facts: list } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'forget_fact',
        description: '删除一条长期记忆（按 recall_facts 返回的 id）。',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: '记忆 id' } },
          required: ['id'],
        },
        async handler(args: { id?: string }) {
          const id = String(args.id ?? '');
          const i = facts.findIndex((f) => f.id === id);
          if (i < 0) return { ok: false, error: `记忆不存在: ${id}` };
          facts.splice(i, 1);
          persist();
          return { ok: true, data: { removed: id, count: facts.length } };
        },
      },
    });

    ctx.logger.info(`工具就绪: remember_fact / recall_facts / forget_fact（已存 ${facts.length} 条记忆，before_llm 钩子注入）`);
  },
} satisfies Plugin;
