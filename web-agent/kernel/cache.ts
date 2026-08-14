/**
 * kernel/cache.ts —— 三层缓存
 * L1 语义缓存：问题向量相似度命中（需注入 embeddingFn，未配置自动降级）
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
  vector: number[];
  answer: string;
  hits: number;
}

const L1_THRESHOLD = 0.95;   // 余弦相似度命中阈值
const DEFAULT_TTL = 5 * 60_000; // L2 默认 TTL 5 分钟

export class Cache {
  private l2 = new Map<string, L2Entry>();
  private l1 = new Map<string, L1Entry>(); // key = 原始文本（去空白归一化）
  private counter: CacheStats = {
    l2Hits: 0, l2Misses: 0, l1Hits: 0, l1Misses: 0,
    l3Hits: 0, l3Tokens: 0, savedCost: 0,
  };

  constructor(private embeddingFn?: EmbeddingFn) {}

  /** L1 是否可用（配置了 embedding 才有语义缓存） */
  get l1Enabled(): boolean {
    return !!this.embeddingFn;
  }

  /** 运行时注入 embedding 函数（由 LLM provider 插件检测到配置后调用，激活 L1） */
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

  /** 查询语义缓存：相似度 ≥ 阈值视为命中 */
  async l1Get(question: string): Promise<{ hit: boolean; answer?: string; key?: string }> {
    if (!this.embeddingFn) return { hit: false };
    const norm = question.replace(/\s+/g, ' ').trim();
    if (!norm) return { hit: false };
    const vec = await this.embeddingFn(norm);
    let best: { key: string; score: number } | null = null;
    for (const [key, entry] of this.l1) {
      const score = cosine(vec, entry.vector);
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

  async l1Set(question: string, answer: string): Promise<void> {
    if (!this.embeddingFn) return;
    const norm = question.replace(/\s+/g, ' ').trim();
    if (!norm) return;
    const vec = await this.embeddingFn(norm);
    this.l1.set(norm, { vector: vec, answer, hits: 0 });
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
