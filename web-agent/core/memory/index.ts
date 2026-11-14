import { isUserMessage } from '../../kernel/context';
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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bigramSet } from '../../kernel/cache';
import { cosineSimilarity } from '../../kernel/vectors';
import type { AgentHookCtx } from '../chat/agent';
import type { Plugin, ToolContext } from '../../kernel/types';
import { buildFact, isFactActive, normalizeFact, type MemoryFact, type MemoryFactInput } from './schema';
import { inspectMemoryText } from './privacy';

const MAX_FACTS = 500;                 // 进程级总上限（多租户共享）
const MAX_FACTS_PER_TENANT = 200;      // 单租户上限，防止一个租户挤掉其他租户的记忆
const LESSON_COUNT = 3;       // 失败教训固定注入条数（不重复犯错优先）
const RELATED_BIGRAM_MIN = 3; // 记忆与当前任务共享 ≥3 个字符 bigram 视为相关
const BLOCK_NAME_MAX = 32;    // 核心记忆块名长度上限
const BLOCK_CONTENT_MAX = 1000; // 单个核心记忆块内容上限
const MAX_BLOCKS_PER_TENANT = 32; // 常驻块会每轮注入，必须有数量上限

type Fact = MemoryFact;

/** 核心记忆块（Letta 式 core memory）：agent 用工具自管理、每次对话固定注入的常驻记忆。
 *  对应 2026 记忆分层中的「语义/程序性核心记忆」——与 archive（facts 检索层）互补：
 *  core = 高频、必须始终在场（用户偏好/项目约束/工作纪律）；archive = 大容量、按需检索。 */
interface MemoryBlock { content: string; ts: number }

interface EmbeddingService { model: string; embed(text: string): Promise<number[]> }

interface MemoryData { facts: Fact[]; blocks: Record<string, MemoryBlock>; vectors?: Record<string, number[]> }

export { cosineSimilarity } from '../../kernel/vectors';

export function memoryScore(task: string, fact: Fact, queryVector?: number[], factVector?: number[]): number {
  const ageDays = Math.max(0, Date.now() - fact.ts) / 86_400_000;
  const recency = 1 / (1 + ageDays / 30);
  if (queryVector?.length && factVector?.length === queryVector.length) {
    return Math.max(0, cosineSimilarity(queryVector, factVector)) + fact.confidence * 0.1 + recency * 0.1;
  }
  const tb = bigramSet(task);
  const fb = bigramSet(fact.text);
  let inter = 0;
  for (const x of tb) if (fb.has(x)) inter++;
  if (inter < RELATED_BIGRAM_MIN) return 0;
  const similarity = inter / Math.max(1, Math.sqrt(tb.size * fb.size));
  return similarity + fact.confidence * 0.1 + recency * 0.1;
}

/** 加载/保存记忆（同步、容错；向后兼容旧版仅 facts 的文件）。
 *  文件路径由 onLoad 从 ctx.paths.data 解析（跟随 Kernel dataDir 覆盖，不写死源码树） */
function loadMemory(memoryFile: string): MemoryData {
  try {
    if (!existsSync(memoryFile)) return { facts: [], blocks: {}, vectors: {} };
    const raw = JSON.parse(readFileSync(memoryFile, 'utf-8')) as Partial<MemoryData>;
    const rawVectors = raw.vectors && typeof raw.vectors === 'object' ? raw.vectors : {};
    const vectors: Record<string, number[]> = {};
    for (const [id, vector] of Object.entries(rawVectors)) {
      if (Array.isArray(vector) && vector.length > 0 && vector.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        vectors[id] = vector;
      }
    }
    const blocks: Record<string, MemoryBlock> = {};
    if (raw.blocks && typeof raw.blocks === 'object') {
      for (const [key, value] of Object.entries(raw.blocks)) {
        if (!value || typeof value !== 'object') continue;
        const block = value as MemoryBlock;
        if (typeof block.content !== 'string' || !Number.isFinite(block.ts)) continue;
        blocks[key.includes('\0') ? key : `default\0${key}`] = block;
      }
    }
    return {
      facts: Array.isArray(raw.facts) ? raw.facts
        .filter((fact): fact is Fact => !!fact && typeof fact === 'object' && typeof fact.id === 'string' && typeof fact.text === 'string' && typeof fact.ts === 'number')
        .map((fact) => normalizeFact(fact)) : [],
      blocks,
      vectors,
    };
  } catch { return { facts: [], blocks: {}, vectors: {} }; }
}

function saveMemory(memoryFile: string, data: MemoryData): void {
  try {
    mkdirSync(dirname(memoryFile), { recursive: true });
    // 原子写：先临时文件再 rename——崩溃/断电不留下截断 JSON（旧实现直接覆盖）
    const tmp = `${memoryFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, memoryFile);
  } catch { /* 持久化失败不阻断对话 */ }
}

export default {
  id: 'memory',
  name: '长期记忆',
  version: '0.1.0',
  onLoad(ctx) {
    const memoryFile = join(ctx.paths.data, 'memory.json');
    const { facts, blocks, vectors: initialVectors } = loadMemory(memoryFile);
    const vectors = initialVectors ?? {};
    let embedding: EmbeddingService | undefined;
    ctx.inject('service:embedding', (value) => {
      embedding = value as EmbeddingService | undefined;
    });

    const persist = () => saveMemory(memoryFile, { facts, blocks, vectors });
    const blockKey = (tenantId: string, name: string): string => `${tenantId}\0${name}`;
    const setBlock = (tenantId: string, name: string, content: string): MemoryBlock => {
      blocks[blockKey(tenantId, name)] = { content, ts: Date.now() };
      persist();
      return blocks[blockKey(tenantId, name)]!;
    };
    const deleteBlock = (tenantId: string, name: string): boolean => {
      const key = blockKey(tenantId, name);
      if (!(key in blocks)) return false;
      delete blocks[key];
      persist();
      return true;
    };
    const remember = async (text: string, input: MemoryFactInput = {}): Promise<Fact | undefined> => {
      if (inspectMemoryText(text).sensitive) return undefined;
      const f = buildFact(randomUUID(), text, Date.now(), input);
      for (const conflictId of f.conflictsWith) {
        const conflict = facts.find((item) => item.id === conflictId && item.tenantId === f.tenantId);
        if (conflict && !conflict.conflictsWith.includes(f.id)) conflict.conflictsWith.push(f.id);
      }
      facts.push(f);
      const tenantId = f.tenantId;
      const tenantFacts = facts.filter((fact) => fact.tenantId === tenantId);
      if (tenantFacts.length > MAX_FACTS_PER_TENANT) {
        for (const removed of [...tenantFacts].sort((a, b) => a.ts - b.ts).slice(0, tenantFacts.length - MAX_FACTS_PER_TENANT)) {
          const index = facts.indexOf(removed);
          if (index >= 0) facts.splice(index, 1);
          delete vectors[removed.id];
        }
      }
      if (facts.length > MAX_FACTS) {
        for (const removed of [...facts].sort((a, b) => a.ts - b.ts).slice(0, facts.length - MAX_FACTS)) {
          const index = facts.indexOf(removed);
          if (index >= 0) facts.splice(index, 1);
          delete vectors[removed.id];
        }
      }
      if (embedding) {
        try {
          const vector = await embedding.embed(text.slice(0, 500));
          if (vector.length) vectors[f.id] = vector;
        } catch { /* embedding 不可用 → 保留 bigram 路径 */ }
      }
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
      if (!ctx.config.get<boolean>('memory.automaticLessons', false)) return;
      const h = e.data as AgentHookCtx;
      if (!h || !Array.isArray(h.history) || h.scratchpad.memoryInjected) return;
      const tenantId = h.tenantId ?? 'default';
      const hasLesson = h.history.some((m) => m.role === 'user' && String(m.content ?? '').startsWith('【失败教训】'));
      if (hasLesson) return;
      const lessons = facts.filter((f) => f.tenantId === tenantId && isFactActive(f) && f.text.startsWith('【自动】')).slice(-LESSON_COUNT).reverse();
      if (lessons.length === 0) return;
      h.history.push({
        role: 'user',
        content: `【失败教训】（来自之前会话，避免重复犯错）\n${lessons.map((f) => `- ${f.text}`).join('\n')}`,
      });
      h.scratchpad.memoryInjected = true;
    });

    // 查询向量：同一任务文本只计算一次；供 context provider 做向量召回。
    ctx.on('agent.before_llm', async (e) => {
      const h = e.data as AgentHookCtx;
      if (!embedding || !Array.isArray(h.history)) return;
      const lastUser = [...h.history].reverse()
        .find((m) => m.role === 'user' && m.content && !String(m.content).startsWith('【'));
      if (!lastUser?.content) return;
      const task = String(lastUser.content).slice(0, 500);
      const previous = h.scratchpad.memoryQuery as { text: string; vector: number[] } | undefined;
      if (previous?.text === task) return;
      try {
        const vector = await embedding.embed(task);
        if (vector.length) h.scratchpad.memoryQuery = { text: task, vector };
      } catch { /* embedding 失败 → content provider 自动回退 bigram */ }
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
        description: '注入核心记忆块（常驻）+ 按任务检索相关长期记忆（embeddings 优先，bigram 回退）',
        weight: 10,
        maxTokens: 1_500,
        contentFn({ history, scratchpad, tenantId }) {
          const scope = tenantId ?? 'default';
          const hasMemory = history.some((m) => m.context?.source === 'memory' || m.context?.source === 'memory-recall');
          const hasBlocks = history.some((m) => m.context?.source === 'memory-blocks');
          if (hasMemory || hasBlocks) return null;
          const parts: string[] = [];
          const blockEntries = Object.entries(blocks)
            .filter(([key]) => key.startsWith(`${scope}\0`))
            .map(([key, block]) => [key.slice(scope.length + 1), block] as const);
          if (blockEntries.length > 0) {
            parts.push(`【核心记忆块】（来源：工作区保存的记忆，仅供参考）\n${blockEntries.map(([name, b]) => `- ${name}: ${b.content}`).join('\n')}`);
          }
          const lastUser = [...history].reverse()
            .find(isUserMessage);
          if (lastUser?.content) {
            const task = lastUser.content.slice(0, 80);
            const queryVector = (scratchpad.memoryQuery as { vector?: number[] } | undefined)?.vector;
            const hits = facts
              .filter((f) => f.tenantId === scope && isFactActive(f) && !f.text.startsWith('【自动】')) // 教训由钩子注入，这里不重复
              .map((fact) => ({ fact, score: memoryScore(task, fact, queryVector, vectors[fact.id]) }))
              .filter((item) => item.score > 0)
              .sort((a, b) => b.score - a.score)
              .slice(0, 5)
              .map((item) => item.fact);
            if (hits.length > 0) {
              parts.push(`【长期记忆】（与当前任务相关，供参考）\n${hits.map((f) => `- [${f.id}] ${f.text}`).join('\n')}`);
            }
          }
          return parts.length ? { content: parts.join('\n\n'), source: 'memory' } : null;
        },
      },
    });

    // ---- 钩子：失败教训自动记忆（"不重复犯错"的底层机制） ----
    // 工具执行失败 → 自动记录一条教训（带【自动】标记，同工具同错误 1 小时内去重），
    // 下次会话 before_llm 注入时 LLM 即知道哪些做法不可行，避免重复踩坑。
    ctx.on('agent.after_tool', (e) => {
      if (!ctx.config.get<boolean>('memory.automaticLessons', false)) return;
      const d = e.data as AgentHookCtx & { tool?: { name: string }; result?: { ok?: boolean; error?: string; governed?: boolean } };
      const result = d.result;
      if (!result || result.ok !== false || !result.error) return;
      // H5：治理决策（用户拒绝审批）不是工具失败——不记教训，避免污染"不重复犯错"记忆
      if (result.governed === true || String(result.error).includes('用户拒绝')) return;
      const err = String(result.error).replace(/\s+/g, ' ').slice(0, 120);
      const dedupKey = `【自动】工具失败教训: ${d.tool?.name ?? '?'}`;
      const now = Date.now();
      if (facts.some((f) => f.text.startsWith(dedupKey) && now - f.ts < 3600_000)) return; // 1 小时内去重
      void remember(`${dedupKey} ${err}`);
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
          '重要事实用 remember_fact；需要跨会话常驻的偏好或项目约束用 set_memory_block。',
          '涉及先前信息时先 recall_facts；记忆失实先撤回或删除；不要记忆密码、密钥等敏感信息。',
        ].join('\n'),
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["workspace.read","workspace.write"],
        name: 'remember_fact',
        risk: 'low',
        costHint: 'low',
        sideEffect: 'write',
        outputSchema: {
          type: 'object', required: ['id', 'count'],
          properties: { id: { type: 'string' }, count: { type: 'integer' }, source: { type: 'string' }, confidence: { type: 'number' } },
        },
        output: '{id, count, source, confidence, conflictsWith}',
        description: '记住一条长期事实（跨会话有效，持久化到 data/memory.json）。用于用户偏好、重要信息、任务结论。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '事实内容（一句话，简洁完整）' },
            source: { type: 'string', enum: ['user', 'agent', 'tool', 'import', 'system'] },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            expiresAt: { type: 'number', minimum: 0 },
            conflictsWith: { type: 'array', items: { type: 'string' } },
          },
          required: ['text'],
        },
        async handler(args: { text?: string; source?: MemoryFactInput['source']; confidence?: number; expiresAt?: number; conflictsWith?: string[] }, tctx: ToolContext) {
          const text = String(args.text ?? '').trim();
          if (!text) return { ok: false, error: '缺少 text' };
          const tenantId = tctx?.tenantId ?? 'default';
          const f = await remember(text, { source: args.source, confidence: args.confidence, expiresAt: args.expiresAt, conflictsWith: args.conflictsWith, tenantId });
          if (!f) return { ok: false, error: '内容疑似包含凭据、私钥或敏感凭据路径，拒绝写入长期记忆' };
          return { ok: true, data: { id: f.id, count: facts.filter((item) => item.tenantId === tenantId).length, source: f.source, confidence: f.confidence, conflictsWith: f.conflictsWith } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["workspace.read"],
        name: 'recall_facts',
        risk: 'low',
        costHint: 'low',
        sideEffect: 'read',
        contentTrust: 'untrusted',
        outputSchema: {
          type: 'object', required: ['count', 'facts'],
          properties: { count: { type: 'integer' }, facts: { type: 'array' } },
        },
        output: '{count, facts: [{id, text, ts, source, confidence, expiresAt, conflictsWith}]}',
        description: '查询长期记忆（按关键词过滤，返回最近 20 条；不传关键词返回全部最近记忆）。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '可选：关键词（大小写不敏感）' } },
        },
        async handler(args: { query?: string }, tctx: ToolContext) {
          const q = String(args.query ?? '').trim().toLowerCase();
          const tenantId = tctx?.tenantId ?? 'default';
          const list = [...facts]
            .reverse()
            .filter((f) => f.tenantId === tenantId && isFactActive(f) && (!q || f.text.toLowerCase().includes(q)))
            .slice(0, 20)
            .map((f) => ({ id: f.id, text: f.text, ts: f.ts, source: f.source, confidence: f.confidence, expiresAt: f.expiresAt, conflictsWith: f.conflictsWith }));
          return { ok: true, data: { count: list.length, facts: list } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["workspace.read","workspace.write"],
        name: 'forget_fact',
        risk: 'medium',
        costHint: 'low',
        sideEffect: 'write',
        outputSchema: {
          type: 'object', required: ['removed', 'count'],
          properties: { removed: { type: 'string' }, count: { type: 'integer' } },
        },
        description: '删除一条长期记忆（按 recall_facts 返回的 id）。',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: '记忆 id' } },
          required: ['id'],
        },
        async handler(args: { id?: string }, tctx: ToolContext) {
          const id = String(args.id ?? '');
          const tenantId = tctx?.tenantId ?? 'default';
          const i = facts.findIndex((f) => f.id === id && f.tenantId === tenantId);
          if (i < 0) return { ok: false, error: `记忆不存在: ${id}` };
          facts.splice(i, 1);
          delete vectors[id];
          persist();
          return { ok: true, data: { removed: id, count: facts.filter((f) => f.tenantId === tenantId).length } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["workspace.read","workspace.write"],
        name: 'revoke_fact',
        risk: 'medium',
        costHint: 'low',
        sideEffect: 'write',
        outputSchema: {
          type: 'object', required: ['revoked', 'revokedAt'],
          properties: { revoked: { type: 'string' }, revokedAt: { type: 'integer' } },
        },
        description: '撤回一条长期记忆（保留审计记录，但不再召回）；按 recall_facts 返回的 id。',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        async handler(args: { id?: string }, tctx: ToolContext) {
          const id = String(args.id ?? '');
          const tenantId = tctx?.tenantId ?? 'default';
          const fact = facts.find((item) => item.id === id && item.tenantId === tenantId);
          if (!fact) return { ok: false, error: `记忆不存在: ${id}` };
          if (fact.revokedAt === undefined) { fact.revokedAt = Date.now(); persist(); }
          return { ok: true, data: { revoked: id, revokedAt: fact.revokedAt } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["workspace.read","workspace.write"],
        name: 'set_memory_block',
        risk: 'medium',
        costHint: 'low',
        sideEffect: 'write',
        outputSchema: {
          type: 'object', required: ['name', 'ts', 'blockCount'],
          properties: { name: { type: 'string' }, ts: { type: 'integer' }, blockCount: { type: 'integer' } },
        },
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
        async handler(args: { name?: string; content?: string }, tctx: ToolContext) {
          const name = String(args.name ?? '').trim();
          const content = String(args.content ?? '').trim();
          if (!name) return { ok: false, error: '缺少 name' };
          if (name.length > BLOCK_NAME_MAX) return { ok: false, error: `块名过长（≤${BLOCK_NAME_MAX} 字符）` };
          if (!content) return { ok: false, error: '缺少 content' };
          if (content.length > BLOCK_CONTENT_MAX) return { ok: false, error: `块内容过长（≤${BLOCK_CONTENT_MAX} 字符），请拆分` };
          const tenantId = tctx?.tenantId ?? 'default';
          const privacy = inspectMemoryText(content);
          if (privacy.sensitive) {
            return { ok: false, error: '核心记忆块疑似包含凭据、私钥或敏感凭据路径，拒绝写入' };
          }
          const key = blockKey(tenantId, name);
          const tenantBlockCount = Object.keys(blocks).filter((item) => item.startsWith(`${tenantId}\0`)).length;
          if (!(key in blocks) && tenantBlockCount >= MAX_BLOCKS_PER_TENANT) {
            return { ok: false, error: `核心记忆块已达上限（${MAX_BLOCKS_PER_TENANT} 个），请先删除过时块` };
          }
          const b = setBlock(tenantId, name, content);
          return { ok: true, data: { name, ts: b.ts, blockCount: Object.keys(blocks).filter((key) => key.startsWith(`${tenantId}\0`)).length } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["workspace.read"],
        name: 'list_memory_blocks',
        risk: 'low',
        costHint: 'low',
        sideEffect: 'read',
        contentTrust: 'untrusted',
        outputSchema: {
          type: 'object', required: ['blocks'],
          properties: { blocks: { type: 'array' } },
        },
        output: '{blocks: [{name, content, ts}]}',
        description: '列出全部核心记忆块（常驻记忆，每轮自动注入）。',
        parameters: { type: 'object', properties: {} },
        async handler(_args: Record<string, unknown>, tctx: ToolContext) {
          const tenantId = tctx?.tenantId ?? 'default';
          const list = Object.entries(blocks)
            .filter(([key]) => key.startsWith(`${tenantId}\0`))
            .map(([key, b]) => ({ name: key.slice(tenantId.length + 1), content: b.content, ts: b.ts }))
            .sort((a, b) => b.ts - a.ts);
          return { ok: true, data: { blocks: list } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        version: '2.0.0',
        permissions: ["workspace.read","workspace.write"],
        name: 'delete_memory_block',
        risk: 'medium',
        costHint: 'low',
        sideEffect: 'write',
        outputSchema: {
          type: 'object', required: ['removed', 'blockCount'],
          properties: { removed: { type: 'string' }, blockCount: { type: 'integer' } },
        },
        description: '删除一个核心记忆块（按 list_memory_blocks 返回的 name）。',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: '块名' } },
          required: ['name'],
        },
        async handler(args: { name?: string }, tctx: ToolContext) {
          const name = String(args.name ?? '').trim();
          if (!name) return { ok: false, error: '缺少 name' };
          const tenantId = tctx?.tenantId ?? 'default';
          if (!deleteBlock(tenantId, name)) return { ok: false, error: `记忆块不存在: ${name}（list_memory_blocks 查看）` };
          return { ok: true, data: { removed: name, blockCount: Object.keys(blocks).filter((key) => key.startsWith(`${tenantId}\0`)).length } };
        },
      },
    });

    ctx.logger.info(`工具就绪: remember_fact / recall_facts / forget_fact + set/list/delete_memory_block（facts ${facts.length} 条 · blocks ${Object.keys(blocks).length} 个，分层记忆已启用）`);
  },
} satisfies Plugin;
