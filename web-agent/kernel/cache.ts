/**
 * kernel/cache.ts —— 三层缓存
 * L1 语义缓存：默认自研文本相似度（字符 bigram Dice，免外部 API 始终可用）；
 *             配置 embedding 后自动升级为向量语义匹配
 * L2 工具结果缓存：hash(工具名+规范化参数)+文件mtime 命中
 * L3 prompt 前缀缓存：无显式键，靠消息组装策略吃 provider KV cache（见 core/chat）
 */
import { createHash } from 'node:crypto';
import type { CacheStats } from './types';

type EmbeddingFn = (text: string) => Promise<number[]>;

interface L2Entry {
  value: unknown;
  expiresAt: number;
  hits: number;
}

interface L1Entry {
  vector?: number[];
  bigrams: Set<string>; // 自研文本相似度特征
  answer: string;
  hits: number;
  promptKey: string;    // systemPrompt 指纹：答案依赖完整输入（人设/插件规则不同则不串用）
}

const L1_THRESHOLD = 0.95;        // 向量余弦相似度命中阈值
const L1_TEXT_THRESHOLD = 0.85;   // 自研 bigram Dice 命中阈值（近义问题可命中；无关文本仍远低于阈值）
const DEFAULT_TTL = 30 * 60_000;  // L2 默认 TTL 30 分钟（文件类键含 mtime+size 校验，TTL 只是防膨胀）
const MAX_L1_ANSWER = 4000;       // 超过该长度的答案不进 L1 缓存

export class Cache {
  private l2 = new Map<string, L2Entry>();
  private l1 = new Map<string, L1Entry>(); // key = 原始文本（去空白归一化）
  private counter: CacheStats = {
    l2Hits: 0, l2Misses: 0, l1Hits: 0, l1Misses: 0,
    l3Hits: 0, l3Tokens: 0, savedCost: 0,
  };

  constructor(private embeddingFn?: EmbeddingFn) {}

  /** L1 始终可用（自研文本相似度）；配置 embedding 后自动升级为向量语义匹配 */
  get l1Enabled(): boolean {
    return true;
  }

  /** 运行时注入 embedding 函数（由 LLM provider 插件检测到配置后调用，激活向量语义匹配） */
  setEmbeddingFn(fn: EmbeddingFn): void {
    this.embeddingFn = fn;
  }

  /** 生成稳定缓存键（sha256 摘要） */
  makeKey(parts: string[]): string {
    return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
  }

  // ---------- L2 工具结果缓存 ----------

  l2Get(key: string): { hit: boolean; value?: unknown } {
    const e = this.l2.get(key);
    if (!e) { this.counter.l2Misses++; return { hit: false }; }
    if (e.expiresAt < Date.now()) {
      this.l2.delete(key);
      this.counter.l2Misses++;
      return { hit: false };
    }
    e.hits++;
    this.counter.l2Hits++;
    return { hit: true, value: e.value };
  }

  l2Set(key: string, value: unknown, ttlMs = DEFAULT_TTL): void {
    this.l2.set(key, { value, expiresAt: Date.now() + ttlMs, hits: 0 });
    // 防内存膨胀：上限 2000 条，超出清最旧
    if (this.l2.size > 2000) {
      const oldest = this.l2.keys().next().value;
      if (oldest !== undefined) this.l2.delete(oldest);
    }
  }

  l2Delete(key: string): void {
    this.l2.delete(key);
  }

  // ---------- L1 语义缓存 ----------

  /** 查询语义缓存：相同/近似问题命中直接返回缓存答案（跳过 LLM 调用）
   *  promptKey：systemPrompt 指纹。LLM 输出依赖完整输入（system + 历史），
   *  人设/插件规则变更后 systemPrompt 不同 → 按 promptKey 隔离缓存空间，不串用旧答案。 */
  async l1Get(question: string, promptKey = ''): Promise<{ hit: boolean; answer?: string; key?: string }> {
    const norm = question.replace(/\s+/g, ' ').trim();
    if (!norm || norm.length < 8) {
      // 短问题（"继续/你好"等）不参与语义匹配，避免跨上下文误命中
      this.counter.l1Misses++;
      return { hit: false };
    }
    if (this.embeddingFn) {
      const vec = await this.embeddingFn(norm);
      let best: { key: string; score: number } | null = null;
      for (const [key, entry] of this.l1) {
        if (entry.promptKey !== promptKey) continue;
        const score = cosine(vec, entry.vector ?? []);
        if (score > (best?.score ?? 0)) best = { key, score };
      }
      if (best && best.score >= L1_THRESHOLD) {
        const entry = this.l1.get(best.key)!;
        entry.hits++;
        this.counter.l1Hits++;
        return { hit: true, answer: entry.answer, key: best.key };
      }
      this.counter.l1Misses++;
      return { hit: false };
    }
    // 自研文本相似度：字符 bigram Dice 系数
    const qBigrams = bigramSet(norm);
    let best: { key: string; score: number } | null = null;
    for (const [key, entry] of this.l1) {
      if (entry.promptKey !== promptKey) continue;
      const score = dice(qBigrams, entry.bigrams);
      if (score > (best?.score ?? 0)) best = { key, score };
    }
    if (best && best.score >= L1_TEXT_THRESHOLD) {
      const entry = this.l1.get(best.key)!;
      entry.hits++;
      this.counter.l1Hits++;
      return { hit: true, answer: entry.answer, key: best.key };
    }
    this.counter.l1Misses++;
    return { hit: false };
  }

  async l1Set(question: string, answer: string, promptKey = ''): Promise<void> {
    const norm = question.replace(/\s+/g, ' ').trim();
    if (!norm || norm.length < 8 || !answer || answer.length > MAX_L1_ANSWER) return;
    const entry: L1Entry = { bigrams: bigramSet(norm), answer, hits: 0, promptKey };
    if (this.embeddingFn) entry.vector = await this.embeddingFn(norm);
    this.l1.set(`${promptKey}|${norm}`, entry);
    if (this.l1.size > 500) {
      const oldest = this.l1.keys().next().value;
      if (oldest !== undefined) this.l1.delete(oldest);
    }
  }

  clear(): void {
    this.l2.clear();
    this.l1.clear();
  }

  /** L3 prompt 前缀复用统计：由 Agent 循环在每次 LLM 调用前记录与上一轮公共前缀的 token 数 */
  recordPrefixRepeat(tokens: number): void {
    if (tokens <= 0) return;
    this.counter.l3Hits++;
    this.counter.l3Tokens += tokens;
  }

  /** 累计缓存节省成本（按 provider 价格 × 估算 token；由命中方报告） */
  recordSavedCost(cost: number): void {
    if (cost > 0) this.counter.savedCost += cost;
  }

  stats(): CacheStats {
    return { ...this.counter };
  }

  statsSnapshot(): CacheStats {
    return this.stats();
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------- 自研文本相似度（L1 默认方案，免 embedding API） ----------

/** 归一化 + 字符 bigram 集合（小写，去标点空白） */
export function bigramSet(text: string): Set<string> {
  const norm = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const set = new Set<string>();
  for (let i = 0; i < norm.length - 1; i++) set.add(norm.slice(i, i + 2));
  return set;
}

/** Dice 系数：2×|A∩B| / (|A|+|B|)，0~1 */
export function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return (2 * inter) / (a.size + b.size);
}
