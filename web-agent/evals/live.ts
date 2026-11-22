/**
 * 真实模型评测：一次采样 + LLM-as-judge。
 * 与 eval:ci 的确定性录制回放互补——回放测契约，live 测模型行为。
 */
export interface LiveEvalCase {
  name: string;
  prompt: string;
  system?: string;
  rubric: string[];
  minScore?: number;
}

export interface LiveEvalCaseResult {
  name: string;
  pass: boolean;
  score: number;
  reason: string;
  answer: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  error?: string;
  judgeRaw?: string;
}

export interface LiveEvalReport {
  kind: 'text-smoke';
  costUsd: number;
  budgetUsd: number;
  model: string;
  cases: LiveEvalCaseResult[];
  passRate: number;
  averageScore: number;
  totalTokensIn: number;
  totalTokensOut: number;
}

export interface LiveEvalOptions {
  budgetUsd: number;
  prices: Record<string, { inputUsdPerMillion: number; outputUsdPerMillion: number }>;
  baseUrl: string;
  apiKey: string;
  model: string;
  cases: LiveEvalCase[];
  judgeModel?: string;
  temperature?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface ChatReply {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

function endpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

function parseJudge(text: string): { score: number; pass: boolean; reason: string } | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(cleaned.slice(start, end + 1)) as { score?: unknown; pass?: unknown; reason?: unknown };
    const score = Number(data.score);
    if (!Number.isFinite(score)) return null;
    return {
      score: Math.max(1, Math.min(5, score)),
      pass: typeof data.pass === 'boolean' ? data.pass : score >= 4,
      reason: typeof data.reason === 'string' ? data.reason : '',
    };
  } catch {
    return null;
  }
}

const JUDGE_SYSTEM = [
  '你是严格的模型输出评测员。根据评分标准给回答打分（1-5，5 最好）。',
  '只输出一个 JSON 对象，不要解释、不要代码围栏：',
  '{"score":1-5,"pass":true|false,"reason":"一句话理由"}',
].join('\n');

export async function runLiveEval(opts: LiveEvalOptions): Promise<LiveEvalReport> {
  if (!Number.isFinite(opts.budgetUsd) || opts.budgetUsd <= 0) throw new Error('必须显式设置正数评测总费用上限');
  for (const model of new Set([opts.model, opts.judgeModel ?? opts.model])) {
    const price = opts.prices[model];
    if (
      !price ||
      !Number.isFinite(price.inputUsdPerMillion) ||
      price.inputUsdPerMillion < 0 ||
      !Number.isFinite(price.outputUsdPerMillion) ||
      price.outputUsdPerMillion < 0
    )
      throw new Error(`缺少模型 ${model} 的有效测试价格`);
  }
  let costUsd = 0;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = endpoint(opts.baseUrl);
  const timeoutMs = Math.max(1_000, opts.timeoutMs ?? 60_000);
  const temperature = opts.temperature ?? 0.2;

  const chat = async (messages: { role: string; content: string }[], maxTokens: number, model = opts.model): Promise<ChatReply> => {
    const price = opts.prices[model];
    // UTF-8 bytes bound text token count conservatively; reserve framing overhead separately.
    const inputBound = Buffer.byteLength(JSON.stringify(messages), 'utf8') + 4096;
    const reservation = (inputBound * price.inputUsdPerMillion + maxTokens * price.outputUsdPerMillion) / 1_000_000;
    if (costUsd + reservation > opts.budgetUsd) throw new Error('EVAL_BUDGET_EXHAUSTED');
    costUsd += reservation;
    // A failed/ambiguous request retains its full reservation and is never replayed.
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content;
    const validUsage =
      Number.isSafeInteger(data.usage?.prompt_tokens) &&
      Number(data.usage?.prompt_tokens) >= 0 &&
      Number.isSafeInteger(data.usage?.completion_tokens) &&
      Number(data.usage?.completion_tokens) >= 0;
    if (validUsage) {
      const actual =
        (Number(data.usage!.prompt_tokens) * price.inputUsdPerMillion + Number(data.usage!.completion_tokens) * price.outputUsdPerMillion) /
        1_000_000;
      costUsd += actual - reservation;
    }
    if (typeof text !== 'string' || !text.trim()) throw new Error('模型响应没有 content');
    return {
      text: text.trim(),
      tokensIn: Number(data.usage?.prompt_tokens) || 0,
      tokensOut: Number(data.usage?.completion_tokens) || 0,
    };
  };

  const results: LiveEvalCaseResult[] = [];
  for (const item of opts.cases) {
    const started = Date.now();
    let answer = '';
    let tokensIn = 0;
    let tokensOut = 0;
    try {
      const reply = await chat(
        [...(item.system ? [{ role: 'system', content: item.system }] : []), { role: 'user', content: item.prompt }],
        1200,
      );
      answer = reply.text;
      tokensIn += reply.tokensIn;
      tokensOut += reply.tokensOut;
      const judged = await chat(
        [
          { role: 'system', content: JUDGE_SYSTEM },
          {
            role: 'user',
            content: [
              `评分标准：\n${item.rubric.map((line, index) => `${index + 1}. ${line}`).join('\n')}`,
              `用户问题：\n${item.prompt}`,
              `候选回答：\n${answer}`,
            ].join('\n\n'),
          },
        ],
        400,
        opts.judgeModel ?? opts.model,
      );
      tokensIn += judged.tokensIn;
      tokensOut += judged.tokensOut;
      const parsed = parseJudge(judged.text);
      if (!parsed) {
        results.push({
          name: item.name,
          pass: false,
          score: 0,
          reason: 'judge 输出不是可解析 JSON',
          answer,
          latencyMs: Date.now() - started,
          tokensIn,
          tokensOut,
          error: 'judge_parse',
          judgeRaw: judged.text.slice(0, 1000),
        });
        continue;
      }
      const minScore = Math.min(5, Math.max(1, item.minScore ?? 4));
      results.push({
        name: item.name,
        pass: parsed.pass && parsed.score >= minScore,
        score: parsed.score,
        reason: parsed.reason,
        answer,
        latencyMs: Date.now() - started,
        tokensIn,
        tokensOut,
      });
    } catch (err) {
      results.push({
        name: item.name,
        pass: false,
        score: 0,
        reason: '调用失败',
        answer,
        latencyMs: Date.now() - started,
        tokensIn,
        tokensOut,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const passed = results.filter((item) => item.pass).length;
  return {
    kind: 'text-smoke',
    costUsd,
    budgetUsd: opts.budgetUsd,
    model: opts.model,
    cases: results,
    passRate: results.length ? passed / results.length : 0,
    averageScore: results.length ? results.reduce((sum, item) => sum + item.score, 0) / results.length : 0,
    totalTokensIn: results.reduce((sum, item) => sum + item.tokensIn, 0),
    totalTokensOut: results.reduce((sum, item) => sum + item.tokensOut, 0),
  };
}
