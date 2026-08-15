/**
 * kernel/cache.ts —— 三层缓存
 *
 * 第一性原理：重复计算是浪费的本质——同一问题的答案、同一工具的结果、同一段 prompt，
 * 都是已被观察过的现实，不值得再次付出代价。缓存不是优化，是「不重复劳动」的纪律。
 * 三层各司其职，因为「重复」有三种本质不同的形态：
 *  - L1 语义缓存：问题的重复（同一含义的提问，无需再问 LLM）——内容词 bigram Dice（轻量语义归一化），免外部 API 始终可用；
 *  - L2 工具结果缓存：观察的重复（同一工具+同一参数+文件未变 = 同一事实）——hash(工具名+参数)+mtime/size 校验；
 *  - L3 prompt 前缀缓存：token 的重复（多轮对话前缀不变，吃 provider KV cache 折扣）——无显式键，靠消息组装策略。
 *
 * 持久化：L1/L2 落盘 data/cache.json（防抖 5s 保存、启动加载）——跨重启保留，
 * 命中率不因进程重启归零（逼近 100% 的前提：缓存必须比进程活得久）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CacheStats } from './types';

type EmbeddingFn = (text: string) => Promise<number[]>;

interface L2Entry {
  value: unknown;
  expiresAt: number;
  hits: number;
}

interface L1Entry {
  vector?: number[];
  bigrams: Set<string>; // 内容词 bigram 特征（语义归一化后）
  actions: string[];    // 动作类别（query/write/delete/execute）：方向不一致不串答案
  answer: string;
  hits: number;
  promptKey: string;    // systemPrompt 指纹：答案依赖完整输入（人设/插件规则不同则不串用）
  expiresAt: number;    // TTL：时效性内容（天气/新闻/用户数据）不永久缓存
}

const L1_THRESHOLD = 0.95;        // 向量余弦相似度命中阈值
const L1_TTL = 24 * 3600_000;     // L1 答案 TTL 24h：时效性内容（天气/新闻/用户数据）不永久缓存
const MAX_L1_ANSWER = 4000;       // 超过该长度的答案不进 L1 缓存

/**
 * 中文功能词（虚词/祈使词）：语义缓存的「内容词过滤」——忽略表面措辞，保留内容词。
 * 借鉴 GPTCache 的归一化思想：同一含义的提问在措辞上差异大，但在内容词上高度重合；
 * 动词与名词保留（「写文件」≠「读文件」，动作词是语义的一部分）。
 */
const STOPWORDS = new Set([
  '的', '了', '吗', '呢', '吧', '啊', '呀', '哦', '噢', '嗯',
  '在', '是', '有', '和', '与', '及', '或', '把', '被', '给', '对', '从', '向', '到', '于', '着', '过',
  '请', '帮', '我', '你', '他', '她', '它', '我们', '你们', '他们', '她们',
  '什么', '怎么', '为什么', '如何', '哪些', '哪个', '一个', '一下', '当前', '现在', '这个', '那个',
  '可以', '能', '要', '会', '应该', '需要', '用', '以', '之', '其', '这', '那',
  '很', '也', '都', '就', '才', '再', '还', '又', '更', '最', '只', '但', '而', '且', '并',
  '或者', '因为', '所以', '如果', '然后', '请问', '给我', '下', '中', '里', '内', '上',
]);

/** 内容词提取：去标点空格 → 去停用词 → 内容词序列（用于 bigram 特征） */
export function contentWords(text: string): string {
  const norm = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  let out = '';
  for (const ch of norm) {
    if (!STOPWORDS.has(ch)) out += ch;
  }
  return out;
}

/** 归一化（精确匹配用）：小写 + 去空白标点 */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * 动作方向校验：内容相似但动作不同（写 vs 读）绝不能串答案。
 * 动词是任务方向的本质：过滤后长文本会让单字动词差异被稀释（bigram 相似度虚高），
 * 故命中前必须比对动作类别。动词先归一到语义类别（列出≈查看≈读），再比较类别集合。
 */
const ACTION_GROUPS: [string, string[]][] = [
  ['query', ['读', '查看', '列出', '查询', '搜索', '查', '打开', '统计', '分析', '比较', '解释', '显示', '浏览', '获取']],
  ['write', ['写', '创建', '新建', '生成', '设计', '实现', '修改', '改', '编辑', '更新', '添加', '重命名', '转换', '下载', '上传', '复制', '移动', '安装', '重构']],
  ['delete', ['删', '删除', '卸载', '移除', '清理', '关闭']],
  ['execute', ['运行', '执行', '修复', '测试']],
];

/** 提取文本的动作类别集合（写/读/删/执行），用于命中前的方向校验 */
export function actionGroups(text: string): Set<string> {
  const norm = contentWords(text);
  const out = new Set<string>();
  for (const [group, words] of ACTION_GROUPS) {
    if (words.some((w) => norm.includes(w))) out.add(group);
  }
  return out;
}

/** bigram 集合（对内容词序列） */
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

export interface CacheConfig {
  /** 内容词 bigram Dice 命中阈值（默认 0.58，可经 config.json 调整） */
  l1TextThreshold?: number;
  /** L2 工具结果默认 TTL 毫秒（默认 30 分钟） */
  l2TtlMs?: number;
}

export class Cache {
  private l2 = new Map<string, L2Entry>();
  private l1 = new Map<string, L1Entry>(); // key = 归一化文本
  private l1TextThreshold = 0.58;
  private l2TtlMs = 30 * 60_000;
  private saveTimer: NodeJS.Timeout | null = null;
  private counter: CacheStats = {
    l2Hits: 0, l2Misses: 0, l1Hits: 0, l1Misses: 0,
    l3Hits: 0, l3Tokens: 0, savedCost: 0,
  };

  constructor(private embeddingFn?: EmbeddingFn, cfg: CacheConfig = {}, private persistFile?: string) {
    if (cfg.l1TextThreshold !== undefined) this.l1TextThreshold = cfg.l1TextThreshold;
    if (cfg.l2TtlMs !== undefined) this.l2TtlMs = cfg.l2TtlMs;
    if (persistFile) this.load();
  }

  /** 运行时更新缓存参数（配置热更新入口） */
  setConfig(cfg: CacheConfig): void {
    if (cfg.l1TextThreshold !== undefined) this.l1TextThreshold = cfg.l1TextThreshold;
    if (cfg.l2TtlMs !== undefined) this.l2TtlMs = cfg.l2TtlMs;
  }

  // ---------- 持久化（防抖落盘 / 启动加载） ----------

  /** 立即落盘（进程退出前调用；常规写入走防抖） */
  save(): void {
    if (!this.persistFile) return;
    try {
      mkdirSync(dirname(this.persistFile), { recursive: true });
      writeFileSync(this.persistFile, JSON.stringify({
        l1: [...this.l1.entries()].map(([k, e]) => ({
          k, answer: e.answer, hits: e.hits, promptKey: e.promptKey, expiresAt: e.expiresAt,
          bigrams: [...e.bigrams], actions: e.actions, vector: e.vector ? [...e.vector] : undefined,
        })),
        l2: [...this.l2.entries()].map(([k, e]) => ({ k, value: e.value, expiresAt: e.expiresAt, hits: e.hits })),
      }), 'utf8');
    } catch (err) {
      console.warn('[cache] 持久化失败（不影响运行）:', err instanceof Error ? err.message : String(err));
    }
  }

  /** 启动加载：恢复未过期的 L1/L2 条目（跨重启命中） */
  load(): void {
    if (!this.persistFile) return;
    try {
      if (!existsSync(this.persistFile)) return;
      const data = JSON.parse(readFileSync(this.persistFile, 'utf8')) as {
        l1?: { k: string; answer: string; hits: number; promptKey: string; expiresAt: number; bigrams: string[]; actions?: string[]; vector?: number[] }[];
        l2?: { k: string; value: unknown; expiresAt: number; hits: number }[];
      };
      const now = Date.now();
      for (const item of data.l1 ?? []) {
        if (item.expiresAt < now) continue;
        this.l1.set(item.k, {
          answer: item.answer, hits: item.hits, promptKey: item.promptKey, expiresAt: item.expiresAt,
          bigrams: new Set(item.bigrams ?? []), actions: item.actions ?? [], vector: item.vector,
        });
      }
      for (const item of data.l2 ?? []) {
        if (item.expiresAt < now) continue;
        this.l2.set(item.k, { value: item.value, expiresAt: item.expiresAt, hits: item.hits });
      }
      if (data.l1?.length || data.l2?.length) {
        console.log(`[cache] 已从磁盘恢复缓存：L1 ${data.l1?.length ?? 0} 条 / L2 ${data.l2?.length ?? 0} 条`);
      }
    } catch (err) {
      console.warn('[cache] 缓存加载失败（从空开始）:', err instanceof Error ? err.message : String(err));
    }
  }

  private scheduleSave(): void {
    if (!this.persistFile) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, 5000);
  }

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

  l2Set(key: string, value: unknown, ttlMs = this.l2TtlMs): void {
    this.l2.set(key, { value, expiresAt: Date.now() + ttlMs, hits: 0 });
    // 防内存膨胀：上限 2000 条，超出清最旧
    if (this.l2.size > 2000) {
      const oldest = this.l2.keys().next().value;
      if (oldest !== undefined) this.l2.delete(oldest);
    }
    this.scheduleSave();
  }

  l2Delete(key: string): void {
    this.l2.delete(key);
    this.scheduleSave();
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
        if (entry.expiresAt < Date.now()) {
          this.l1.delete(key);
          continue;
        }
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
    // 自研文本相似度：内容词 bigram Dice（轻量语义归一化——忽略表面措辞，保留内容词）
    // 精确匹配优先：归一化后全等（同句重复提问）直接命中，不走相似度
    if (this.l1.has(`${promptKey}|${norm}`)) {
      const entry = this.l1.get(`${promptKey}|${norm}`)!;
      if (entry.expiresAt >= Date.now()) {
        entry.hits++;
        this.counter.l1Hits++;
        return { hit: true, answer: entry.answer, key: `${promptKey}|${norm}` };
      }
      this.l1.delete(`${promptKey}|${norm}`);
    }
    const qBigrams = bigramSet(contentWords(norm));
    const qActions = actionGroups(norm);
    let best: { key: string; score: number } | null = null;
    for (const [key, entry] of this.l1) {
      if (entry.promptKey !== promptKey) continue;
      if (entry.expiresAt < Date.now()) { // TTL 过期：删除并按未命中处理
        this.l1.delete(key);
        continue;
      }
      const score = dice(qBigrams, entry.bigrams);
      if (score > (best?.score ?? 0)) best = { key, score };
    }
    if (best && best.score >= this.l1TextThreshold) {
      const entry = this.l1.get(best.key)!;
      // 动作方向校验：写/读/删等类别不一致 = 不同任务，不串答案（防内容词过滤导致的误命中）
      const a1 = new Set(entry.actions);
      const sameAction = a1.size === qActions.size && [...qActions].every((x) => a1.has(x));
      if (!sameAction) {
        this.counter.l1Misses++;
        return { hit: false };
      }
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
    const entry: L1Entry = {
      bigrams: bigramSet(contentWords(norm)), actions: [...actionGroups(norm)], answer, hits: 0, promptKey,
      expiresAt: Date.now() + L1_TTL,
    };
    if (this.embeddingFn) entry.vector = await this.embeddingFn(norm);
    this.l1.set(`${promptKey}|${norm}`, entry);
    if (this.l1.size > 500) {
      const oldest = this.l1.keys().next().value;
      if (oldest !== undefined) this.l1.delete(oldest);
    }
    this.scheduleSave();
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
