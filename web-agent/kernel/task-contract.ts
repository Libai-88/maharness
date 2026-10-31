import type { TaskContract, TaskCriterion } from './task-verifier';

const QUOTED = /(?:必须包含|需要包含|包含短语|输出(?:内容)?(?:为|是)?|回答|返回|(?:must\s+)?contain|must\s+include|include(?:s)? the phrase|(?:respond|reply|answer|return)\s+(?:with|as)|output(?: exactly)?(?: as|:))\s*[「『“"']([^」』”"']{1,160})[」』”"']/gi;
const OUTPUT_MATCHES_QUOTED = /(?:最终(?:回答|答案)|输出|回答|answer|response|output)\s*(?:匹配(?:正则|表达式)?|符合正则|matches?|match(?:es)?|conforms?\s+to)\s*[正则\s]*[「『“"']([^」』”"']{1,160})[」』”"']/giu;
const OUTPUT_MATCHES_SLASH = /(?:最终(?:回答|答案)|输出|回答|answer|response|output)\s*(?:匹配(?:正则|表达式)?|符合正则|matches?|match(?:es)?|conforms?\s+to)\s*[正则\s]*\/((?:\\.|[^\/\r\n]){1,160})\/([dgimsuvy]*)/giu;
const FILE_PATH = /(?:创建|新建|写入|保存|生成|create|write|save|generate)[^\r\n]{0,40}?([\w.-]+(?:[\\/][\w.-]+)*\.[a-z0-9]{1,10})/gi;
const FILE_CONTAINS = /(?:文件|file)\s*[「『“"']?([\w.-]+(?:[\\/][\w.-]+)*\.[a-z0-9]{1,10})[」』”"']?[^\r\n]{0,24}?(?:包含|内容(?:中)?(?:有|为)|contains?|includes?)\s*[「『“"']([^」』”"']{1,160})[」』”"']/gi;
const TOOL_SUCCEEDED = /(?:工具|tool)\s*[「『“"']?([a-z][\w-]{1,80})[」』”"']?\s*(?:调用|执行|返回)?\s*(?:成功|成功返回|succeed(?:ed|s)?|ok)(?=$|[\s，。；,.;])/gi;

export function deriveTaskContract(objective: string, now = Date.now()): TaskContract {
  const text = objective.trim();
  const acceptance: TaskCriterion[] = [];
  for (const match of text.matchAll(OUTPUT_MATCHES_QUOTED)) {
    const pattern = match[1]?.trim();
    if (pattern && !isNegatedAt(text, match.index ?? 0) && isValidRegex(pattern)
      && !acceptance.some((criterion) => criterion.type === 'output_matches' && criterion.pattern === pattern && !criterion.flags)) {
      acceptance.push({ type: 'output_matches', pattern });
    }
  }
  for (const match of text.matchAll(OUTPUT_MATCHES_SLASH)) {
    const pattern = match[1]?.trim();
    const flags = match[2] || undefined;
    if (pattern && !isNegatedAt(text, match.index ?? 0) && isValidRegex(pattern, flags)
      && !acceptance.some((criterion) => criterion.type === 'output_matches' && criterion.pattern === pattern && criterion.flags === flags)) {
      acceptance.push({ type: 'output_matches', pattern, ...(flags ? { flags } : {}) });
    }
  }
  for (const match of text.matchAll(QUOTED)) {
    const value = match[1]?.trim();
    if (value && !isNegatedAt(text, match.index ?? 0)
      && !acceptance.some((criterion) => criterion.type === 'output_contains' && criterion.value === value)) {
      acceptance.push({ type: 'output_contains', value });
    }
  }
  for (const match of text.matchAll(FILE_PATH)) {
    const rawFilePath = match[1];
    const filePath = rawFilePath?.replace(/\\/g, '/');
    if (filePath && !isNegatedAt(text, match.index ?? 0) && !/[a-z]:[\\/]/i.test(text) && !filePath.startsWith('/')
      && !filePath.split('/').some((segment) => segment === '.' || segment === '..')
      && !acceptance.some((criterion) => criterion.type === 'file_exists' && criterion.path === filePath)) {
      acceptance.push({ type: 'file_exists', path: filePath });
    }
  }
  for (const match of text.matchAll(FILE_CONTAINS)) {
    const rawFilePath = match[1];
    const value = match[2]?.trim();
    const filePath = rawFilePath?.replace(/\\/g, '/');
    if (filePath && value && !isNegatedAt(text, match.index ?? 0) && !isNegatedPredicate(match[0] ?? '')
      && !/[a-z]:[\\/]/i.test(text) && !filePath.startsWith('/')
      && !filePath.split('/').some((segment) => segment === '.' || segment === '..')
      && !acceptance.some((criterion) => criterion.type === 'file_contains' && criterion.path === filePath && criterion.value === value)) {
      acceptance.push({ type: 'file_contains', path: filePath, value });
    }
  }
  for (const match of text.matchAll(TOOL_SUCCEEDED)) {
    const name = match[1]?.trim();
    if (name && !isNegatedPredicate(match[0] ?? '')
      && !acceptance.some((criterion) => criterion.type === 'tool_succeeded' && criterion.name === name)) {
      acceptance.push({ type: 'tool_succeeded', name });
    }
  }

  const relativeDeadline = /(?:在|within|完成(?:时间)?(?:为|是|不超过)?|deadline(?:\s+in)?)\s*(\d+(?:\.\d+)?)\s*(秒|分钟|分|小时|天|seconds?|minutes?|hours?|days?)/i.exec(text);
  const duration = relativeDeadline ? Number(relativeDeadline[1]) * durationMs(relativeDeadline[2]!.toLowerCase()) : undefined;
  const relativeAt = duration !== undefined && Number.isFinite(duration) && duration > 0 && Number.isSafeInteger(now + duration) ? now + duration : undefined;
  // 只识别带明确日期标记的 ISO 日期，避免把普通数字或文件名误当成期限。
  const absoluteDeadline = /(?:截止(?:时间|日期)?|完成前|by|deadline\s*(?:at|on)?)\s*(?:为|是|到|:)?\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?)/i.exec(text);
  const parsedAbsolute = absoluteDeadline ? Date.parse(absoluteDeadline[1]!.replace(/\//g, '-')) : NaN;
  const absoluteAt = Number.isFinite(parsedAbsolute) ? parsedAbsolute : undefined;
  const deadlineCandidates = [relativeAt, absoluteAt].filter((value): value is number => value !== undefined && Number.isSafeInteger(value));
  const deadlineAt = deadlineCandidates.length ? Math.min(...deadlineCandidates) : undefined;
  const budgetMatch = /(?:预算|budget)\s*(?:为|是|不超过|上限|[:=])?\s*\$?\s*(\d+(?:\.\d+)?)(?![\d.e])/i.exec(text);
  const budget = budgetMatch ? Number(budgetMatch[1]) : undefined;
  const costBudgetUsd = budget !== undefined && Number.isFinite(budget) && budget > 0 ? budget : undefined;
  const risk: TaskContract['risk'] = /删除|清空|覆盖|部署|发布|付款|转账|execute|delete|deploy|publish|payment/i.test(text)
    ? 'high'
    : /创建|新建|写入|修改|发送|联网|安装|create|write|modify|send|install/i.test(text) ? 'medium' : 'low';

  const isQuestion = /[？?]$|^(请问|能否|是否|为什么|怎么|如何|what|why|how|can you|could you|is it)/i.test(text);
  const actionable = /创建|新建|写入|保存|生成|整理|修改|发送|安装|部署|发布|create|write|save|generate|organize|modify|send|install|deploy|publish/i.test(text);
  const inference = acceptance.length > 0
    ? { confidence: 1, basis: 'explicit' as const, needsConfirmation: false, rationale: '目标包含可直接验证的明确验收条件' }
    : isQuestion
      ? { confidence: 0.1, basis: 'ambiguous' as const, needsConfirmation: true, rationale: '目标是询问或开放式问题，缺少可验证的完成标准' }
      : actionable
        ? { confidence: 0.45, basis: 'inferred' as const, needsConfirmation: true, rationale: '识别到行动意图，但未识别到可验证的完成标准' }
        : { confidence: 0.25, basis: 'ambiguous' as const, needsConfirmation: true, rationale: '未识别到稳定的行动意图或可验证的完成标准' };

  return {
    objective: text,
    acceptance,
    risk,
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
    ...(costBudgetUsd === undefined ? {} : { costBudgetUsd }),
    inference,
  };
}

function isValidRegex(pattern: string, flags?: string): boolean {
  try {
    new RegExp(pattern, flags);
    return true;
  } catch {
    return false;
  }
}

function isNegatedAt(text: string, index: number): boolean {
  const prefix = text.slice(Math.max(0, index - 32), index);
  return /(?:不要|不需要|不必|不能|不得|不应|不可|无需|无须|禁止|避免|别|没有|并未|未能|未|do\s+not|don't|does\s+not|doesn't|did\s+not|must\s+not|should\s+not|cannot|can't|never|without)\s*(?:去|to)?\s*$/i.test(prefix);
}

function isNegatedPredicate(expression: string): boolean {
  return /(?:不|未|没)(?:包含|含有|执行成功|调用成功|返回成功)|\b(?:not|never)\s+(?:contain|include|succeed|succeeded|successful)\b/i.test(expression);
}

function durationMs(unit: string): number {
  if (unit.startsWith('秒') || unit.startsWith('second')) return 1000;
  if (unit.startsWith('分') || unit.startsWith('minute')) return 60_000;
  if (unit.startsWith('小时') || unit.startsWith('hour')) return 3_600_000;
  return 86_400_000;
}
