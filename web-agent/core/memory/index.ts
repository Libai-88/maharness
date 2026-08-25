/**
 * core/memory/index.ts —— 长期记忆插件
 * 上下文工程（context provider 的实战消费者）：
 *   普通记忆 = context provider：按当前任务动态组装——contentFn 用最后
 *   user 消息与记忆做字符 bigram 相关匹配，只注入相关记忆（无关记忆零成本）；
 *   失败教训 = before_llm 钩子：固定注入最近几条（"不重复犯错"优先，任何任务都可能相关）。
 *   注入均追加到 history 末尾 → 不动前缀 → 不破坏 L3 provider KV 缓存命中。
 * 持久化：data/memory.json（facts 列表，上限 200 条，最旧淘汰；重启不丢）。
 * 工具：remember_fact / recall_facts / forget_fact。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { bigramSet } from '../../kernel/cache';
import type { AgentHookCtx } from '../chat/agent';
import type { Plugin } from '../../kernel/types';

const rootDir = fileURLToPath(new URL('../..', import.meta.url));
const dataDir = join(rootDir, 'data');
const memoryFile = join(dataDir, 'memory.json');

const MAX_FACTS = 200;
const LESSON_COUNT = 3;       // 失败教训固定注入条数（不重复犯错优先）
const RELATED_BIGRAM_MIN = 3; // 记忆与当前任务共享 ≥3 个字符 bigram 视为相关
const BLOCK_NAME_MAX = 32;    // 核心记忆块名长度上限
const BLOCK_CONTENT_MAX = 1000; // 单个核心记忆块内容上限

interface Fact { id: string; text: string; ts: number }

/** 核心记忆块（Letta 式 core memory）：agent 用工具自管理、每次对话固定注入的常驻记忆。
 *  对应 2026 记忆分层中的「语义/程序性核心记忆」——与 archive（facts 检索层）互补：
 *  core = 高频、必须始终在场（用户偏好/项目约束/工作纪律）；archive = 大容量、按需检索。 */
interface MemoryBlock { content: string; ts: number }

interface MemoryData { facts: Fact[]; blocks: Record<string, MemoryBlock> }

/** 记忆与任务相关性：字符 bigram 重叠数（与 L1 语义缓存同源思想） */
function relatedToTask(task: string, factText: string): boolean {
  const tb = bigramSet(task);
  const fb = bigramSet(factText);
  let inter = 0;
  for (const x of tb) if (fb.has(x)) inter++;
  return inter >= RELATED_BIGRAM_MIN;
}

/** 加载/保存记忆（同步、容错；向后兼容旧版仅 facts 的文件） */
function loadMemory(): MemoryData {
  try {
    if (!existsSync(memoryFile)) return { facts: [], blocks: {} };
    const raw = JSON.parse(readFileSync(memoryFile, 'utf-8')) as Partial<MemoryData>;
    return {
      facts: Array.isArray(raw.facts) ? raw.facts : [],
      blocks: raw.blocks && typeof raw.blocks === 'object' ? raw.blocks : {},
    };
  } catch { return { facts: [], blocks: {} }; }
}

function saveMemory(data: MemoryData): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(memoryFile, JSON.stringify(data, null, 2), 'utf8');
  } catch { /* 持久化失败不阻断对话 */ }
}

export default {
  id: 'memory',
  name: '长期记忆',
  version: '0.1.0',
  onLoad(ctx) {
    const { facts, blocks } = loadMemory();

    const persist = () => saveMemory({ facts, blocks });
    const setBlock = (name: string, content: string): MemoryBlock => {
      blocks[name] = { content, ts: Date.now() };
      persist();
      return blocks[name];
    };
    const deleteBlock = (name: string): boolean => {
      if (!(name in blocks)) return false;
      delete blocks[name];
      persist();
      return true;
    };
    const remember = (text: string): Fact => {
      const f: Fact = { id: randomUUID().slice(0, 8), text, ts: Date.now() };
      facts.push(f);
      if (facts.length > MAX_FACTS) facts.splice(0, facts.length - MAX_FACTS);
      persist();
      return f;
    };

    // ---- 钩子：失败教训注入（before_llm，追加到末尾保持前缀稳定） ----
    // 教训任何任务都可能相关（不重复犯错优先），固定注入最近几条；
    // 普通记忆走下方 context provider（按任务动态组装）。
    // ctx.on = 自动退订的事件订阅（可逆效应）：重载/卸载时监听器随作用域回收，
    // 不会出现「旧监听器残留 → 教训双重注入」的泄漏。
    // 去重：发送序列快照同步后教训已入库，历史中已有【失败教训】则跳过——
    // 否则每次 run 重新注入会插在历史中段，破坏 L3 前缀缓存（跨 run 前缀断裂）。
    ctx.on('agent.before_llm', (e) => {
      const h = e.data as AgentHookCtx;
      if (!h || !Array.isArray(h.history) || h.scratchpad.memoryInjected) return;
      const hasLesson = h.history.some((m) => m.role === 'user' && String(m.content ?? '').startsWith('【失败教训】'));
      if (hasLesson) return;
      const lessons = facts.filter((f) => f.text.startsWith('【自动】')).slice(-LESSON_COUNT).reverse();
      if (lessons.length === 0) return;
      h.history.push({
        role: 'user',
        content: `【失败教训】（来自之前会话，避免重复犯错）\n${lessons.map((f) => `- ${f.text}`).join('\n')}`,
      });
      h.scratchpad.memoryInjected = true;
    });

    // ---- Context Provider：分层记忆按需/常驻注入（上下文工程） ----
    //  core（核心记忆块）= 每次对话固定注入（用户偏好/项目约束/工作纪律，Letta 式 core memory）；
    //  archive（facts）= 按当前任务 bigram 相关检索注入，无关零成本。
    // 去重：发送序列快照同步后旧记忆已入库，历史已有【核心记忆块】/【长期记忆】则跳过本次注入
    // （缓存前缀稳定优先；新记忆可通过 recall_facts 主动查询获取）。
    ctx.register({
      kind: 'context',
      context: {
        id: 'memory-recall',
        description: '注入核心记忆块（常驻）+ 按任务检索相关长期记忆（字符 bigram 相关匹配）',
        weight: 10,
        contentFn({ history }) {
          const hasMemory = history.some((m) => String(m.content ?? '').startsWith('【长期记忆】'));
          const hasBlocks = history.some((m) => String(m.content ?? '').startsWith('【核心记忆块】'));
          if (hasMemory || hasBlocks) return null;
          const parts: string[] = [];
          const blockEntries = Object.entries(blocks);
          if (blockEntries.length > 0) {
            parts.push(`【核心记忆块】（常驻记忆，始终生效）\n${blockEntries.map(([name, b]) => `- ${name}: ${b.content}`).join('\n')}`);
          }
          const lastUser = [...history].reverse()
            .find((m) => m.role === 'user' && m.content && !String(m.content).startsWith('【长期记忆】') && !String(m.content).startsWith('【失败教训】') && !String(m.content).startsWith('【继续】'));
          if (lastUser?.content) {
            const task = lastUser.content.slice(0, 80);
            const hits = facts
              .filter((f) => !f.text.startsWith('【自动】') && relatedToTask(task, f.text)) // 教训由钩子注入，这里不重复
              .slice(-5)
              .reverse();
            if (hits.length > 0) {
              parts.push(`【长期记忆】（与当前任务相关，供参考）\n${hits.map((f) => `- ${f.text}`).join('\n')}`);
            }
          }
          return parts.length ? parts.join('\n\n') : null;
        },
      },
    });

    // ---- 钩子：失败教训自动记忆（"不重复犯错"的底层机制） ----
    // 工具执行失败 → 自动记录一条教训（带【自动】标记，同工具同错误 1 小时内去重），
    // 下次会话 before_llm 注入时 LLM 即知道哪些做法不可行，避免重复踩坑。
    ctx.on('agent.after_tool', (e) => {
      const d = e.data as AgentHookCtx & { tool?: { name: string }; result?: { ok?: boolean; error?: string; governed?: boolean } };
      const result = d.result;
      if (!result || result.ok !== false || !result.error) return;
      // H5：治理决策（用户拒绝审批）不是工具失败——不记教训，避免污染"不重复犯错"记忆
      if (result.governed === true || String(result.error).includes('用户拒绝')) return;
      const err = String(result.error).replace(/\s+/g, ' ').slice(0, 120);
      const dedupKey = `【自动】工具失败教训: ${d.tool?.name ?? '?'}`;
      const now = Date.now();
      if (facts.some((f) => f.text.startsWith(dedupKey) && now - f.ts < 3600_000)) return; // 1 小时内去重
      remember(`${dedupKey} ${err}`);
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
          '3. 每轮对话开始会自动注入核心记忆块与最近相关记忆（勿重复要求，也不要逐条复述）；',
          '4. 记忆与事实不符或用户否认时，用 forget_fact 删除，不要带着错误记忆回答；',
          '5. 不要记忆敏感信息（密码、密钥等）；',
          '6. 工具失败会自动记录教训（【自动】标记）；若教训已不适用，用 forget_fact 删除。',
          '核心记忆块（分层记忆的 core 层）：',
          '7. 高频且必须始终在场的记忆（用户偏好、项目约束、工作纪律、关键路径约定），用 set_memory_block 写入——每轮对话固定注入；',
          '8. 一次性/低频事实用 remember_fact 存档案（archive 层，按需检索），不要占用常驻核心块；',
          '9. 用 list_memory_blocks 查看已有块，delete_memory_block 删除过时块。',
        ].join('\n'),
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'remember_fact',
        risk: 'low',
        costHint: 'low',
        output: '{id, count}',
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
        risk: 'low',
        costHint: 'low',
        output: '{count, facts: [{id, text, ts}]}',
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
        risk: 'medium',
        costHint: 'low',
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

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'set_memory_block',
        risk: 'medium',
        costHint: 'low',
        output: '{name, ts}',
        description: '写入/更新一个核心记忆块（分层记忆 core 层）：常驻记忆，每轮对话自动注入。' +
          '用于高频且必须始终在场的记忆（用户偏好、项目约束、工作纪律、关键路径约定）。' +
          '低频/一次性事实用 remember_fact 存档案层即可，不要占用常驻块。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '块名（≤32 字符，如 user-profile / project-rules）' },
            content: { type: 'string', description: '块内容（≤1000 字符，一句话一条，简洁明确）' },
          },
          required: ['name', 'content'],
        },
        async handler(args: { name?: string; content?: string }) {
          const name = String(args.name ?? '').trim();
          const content = String(args.content ?? '').trim();
          if (!name) return { ok: false, error: '缺少 name' };
          if (name.length > BLOCK_NAME_MAX) return { ok: false, error: `块名过长（≤${BLOCK_NAME_MAX} 字符）` };
          if (!content) return { ok: false, error: '缺少 content' };
          if (content.length > BLOCK_CONTENT_MAX) return { ok: false, error: `块内容过长（≤${BLOCK_CONTENT_MAX} 字符），请拆分` };
          const b = setBlock(name, content);
          return { ok: true, data: { name, ts: b.ts, blockCount: Object.keys(blocks).length } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'list_memory_blocks',
        risk: 'low',
        costHint: 'low',
        output: '{blocks: [{name, content, ts}]}',
        description: '列出全部核心记忆块（常驻记忆，每轮自动注入）。',
        parameters: { type: 'object', properties: {} },
        async handler() {
          const list = Object.entries(blocks)
            .map(([name, b]) => ({ name, content: b.content, ts: b.ts }))
            .sort((a, b) => b.ts - a.ts);
          return { ok: true, data: { blocks: list } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'delete_memory_block',
        risk: 'medium',
        costHint: 'low',
        description: '删除一个核心记忆块（按 list_memory_blocks 返回的 name）。',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: '块名' } },
          required: ['name'],
        },
        async handler(args: { name?: string }) {
          const name = String(args.name ?? '').trim();
          if (!name) return { ok: false, error: '缺少 name' };
          if (!deleteBlock(name)) return { ok: false, error: `记忆块不存在: ${name}（list_memory_blocks 查看）` };
          return { ok: true, data: { removed: name, blockCount: Object.keys(blocks).length } };
        },
      },
    });

    ctx.logger.info(`工具就绪: remember_fact / recall_facts / forget_fact + set/list/delete_memory_block（facts ${facts.length} 条 · blocks ${Object.keys(blocks).length} 个，分层记忆已启用）`);
  },
} satisfies Plugin;
