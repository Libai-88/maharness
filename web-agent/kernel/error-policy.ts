export type ErrorCategory = 'transient' | 'auth' | 'parameter' | 'business' | 'aborted' | 'unknown';

export interface ClassifiedError {
  category: ErrorCategory;
  code: string;
  retryable: boolean;
  retryDelayMs: number;
  message: string;
  cause: unknown;
}

export interface ErrorCorpusCase { message: string; expected: ErrorCategory; status?: number }
export interface ErrorCorpusScore { total: number; correct: number; macroF1: number; perCategory: Record<ErrorCategory, { precision: number; recall: number; f1: number }> }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '未知错误');
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

function retryAfterOf(error: unknown): number | undefined {
  const retryAfterMs = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : undefined;
}

function isAbort(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return name === 'AbortError' || /\bAbortError\b|\babort(ed)?\b|用户停止|已停止|signal aborted|This operation was aborted/i.test(messageOf(error));
}

/** 统一错误分类裁判。分类只依赖稳定状态码/错误信号，原始 cause 始终保留。 */
export function classifyError(error: unknown): ClassifiedError {
  const message = messageOf(error);
  if (isAbort(error)) return { category: 'aborted', code: 'ABORTED', retryable: false, retryDelayMs: 0, message, cause: error };
  const status = statusOf(error);
  if (status !== undefined) {
    if (status === 401 || status === 403) return { category: 'auth', code: `HTTP_${status}`, retryable: false, retryDelayMs: 0, message, cause: error };
    if (status === 408 || status === 425 || status === 429 || status >= 500) {
      return { category: 'transient', code: `HTTP_${status}`, retryable: true, retryDelayMs: retryAfterOf(error) ?? (status === 429 ? 2000 : 1200), message, cause: error };
    }
    if (status === 400 || status === 404 || status === 422) return { category: 'parameter', code: `HTTP_${status}`, retryable: false, retryDelayMs: 0, message, cause: error };
    return { category: 'unknown', code: `HTTP_${status}`, retryable: false, retryDelayMs: 0, message, cause: error };
  }
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|连接.*超时|连接.*断/i.test(message)) {
    return { category: 'transient', code: 'NETWORK_TRANSIENT', retryable: true, retryDelayMs: 1200, message, cause: error };
  }
  if (/unauthorized|invalid api key|permission denied|access denied|not authorized|权限不足|没有权限|无权限|凭据无效|密钥无效/i.test(message)) {
    return { category: 'auth', code: 'AUTH_REJECTED', retryable: false, retryDelayMs: 0, message, cause: error };
  }
  if (/invalid|参数|参数错误|malformed|schema|tool.*not found|不存在.*工具/i.test(message)) {
    return { category: 'parameter', code: 'INVALID_REQUEST', retryable: false, retryDelayMs: 0, message, cause: error };
  }
  if (/拒绝|forbidden|不允许|业务失败|business.*reject|\brejected\b|quota exceeded|内容审核/i.test(message)) {
    return { category: 'business', code: 'BUSINESS_REJECTED', retryable: false, retryDelayMs: 0, message, cause: error };
  }
  return { category: 'unknown', code: 'UNKNOWN', retryable: false, retryDelayMs: 0, message, cause: error };
}

export function shouldRetry(error: unknown, attempt: number, maxAttempts = 2): boolean {
  return attempt + 1 < maxAttempts && classifyError(error).retryable;
}

/** 固定错误语料的可复算指标，供质量门禁和后续回归报告使用。 */
export function scoreErrorCorpus(cases: ErrorCorpusCase[]): ErrorCorpusScore {
  const categories: ErrorCategory[] = ['transient', 'auth', 'parameter', 'business', 'aborted', 'unknown'];
  const perCategory = Object.fromEntries(categories.map((category) => [category, { tp: 0, fp: 0, fn: 0 }])) as Record<ErrorCategory, { tp: number; fp: number; fn: number }>;
  let correct = 0;
  for (const item of cases) {
    const error = Object.assign(new Error(item.message), item.status === undefined ? {} : { status: item.status });
    const predicted = classifyError(error).category;
    if (predicted === item.expected) { correct++; perCategory[item.expected].tp++; }
    else { perCategory[predicted].fp++; perCategory[item.expected].fn++; }
  }
  const metrics = Object.fromEntries(categories.map((category) => {
    const { tp, fp, fn } = perCategory[category];
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    return [category, { precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0 }];
  })) as ErrorCorpusScore['perCategory'];
  return { total: cases.length, correct, macroF1: categories.reduce((sum, category) => sum + metrics[category].f1, 0) / categories.length, perCategory: metrics };
}
