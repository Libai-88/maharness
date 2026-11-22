/**
 * kernel/content-safety.ts —— 外部内容安全检测（纯函数）
 *
 * 只做「标注」不做「授权」：网页、文档、MCP 返回和插件输出里的提示注入/凭据泄露
 * 会以 warning 形式进入工具结果、Trace 和 UI；审批与最小权限仍是最终边界。
 * 预览永远脱敏，避免检测结果本身把密钥二次泄露到日志或界面。
 */
import type { ToolWarning } from './types';

const MAX_SCAN_CHARS = 256_000;
const MAX_WARNINGS = 8;

interface PatternRule {
  re: RegExp;
  label: string;
  severity: ToolWarning['severity'];
  /** 正则的捕获组索引：只展示该组（避免把整段上下文带进预览） */
  capture?: number;
}

const PROMPT_INJECTION_RULES: PatternRule[] = [
  {
    re: /\b(ignore|disregard|forget)\s+(all\s+)?(of\s+)?(the\s+)?(previous|prior|above|earlier|system|developer)\s+(instructions?|prompts?|rules?|messages?)/gi,
    label: '试图覆盖既有指令',
    severity: 'high',
  },
  {
    re: /\b(reveal|print|show|repeat|output)\s+(the\s+)?(system|developer|hidden)\s+(prompt|message|instructions?)/gi,
    label: '试图读取系统提示词',
    severity: 'high',
  },
  {
    re: /\byou\s+are\s+now\s+(a|an|in)\s+(developer|system|unrestricted|jailbreak|dan)\b/gi,
    label: '角色覆盖/越狱话术',
    severity: 'high',
  },
  {
    re: /\b(new|updated)\s+(system|developer)\s+(prompt|instructions?)\s*:/gi,
    label: '伪造系统/开发者指令',
    severity: 'high',
  },
  {
    re: /<\|(system|im_start|im_end)\|>|\[SYSTEM\]|\[INST\]/gi,
    label: '伪造聊天模板标记',
    severity: 'high',
  },
  {
    re: /\b(do\s+not|don't|never)\s+(tell|inform|mention|reveal)\s+(this\s+)?(to\s+)?(the\s+)?user\b/gi,
    label: '要求向用户隐瞒',
    severity: 'medium',
  },
  {
    re: /(忽略|无视|忘记|抛弃|覆盖)(掉)?(之前|以上|前面|先前|原有|所有)的?(指令|规则|提示|要求|设定)/g,
    label: '试图覆盖既有指令',
    severity: 'high',
  },
  {
    re: /(输出|显示|打印|复述|泄露)(你的)?(系统|开发者|隐藏)(提示词|消息|指令)/g,
    label: '试图读取系统提示词',
    severity: 'high',
  },
  {
    re: /(现在|从现在开始)(你|你是|扮演)(一个)?(不受限制|无限制|开发者模式|越狱)/g,
    label: '角色覆盖/越狱话术',
    severity: 'high',
  },
];

const SENSITIVE_DATA_RULES: PatternRule[] = [
  { re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, label: '疑似模型 API Key', severity: 'high' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, label: '疑似 GitHub Token', severity: 'high' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: '疑似 AWS Access Key', severity: 'high' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, label: '疑似 Google API Key', severity: 'high' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: '疑似 Slack Token', severity: 'high' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, label: '疑似 JWT', severity: 'high' },
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*\b/gi, label: '疑似 Bearer Token', severity: 'high' },
  { re: /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g, label: '私钥内容', severity: 'high' },
  {
    re: /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?([A-Za-z0-9_\-./+=]{8,})/gi,
    label: '明文口令/密钥赋值',
    severity: 'high',
    capture: 2,
  },
];

function redact(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '***';
  if (/PRIVATE\s+KEY/.test(trimmed)) return '-----BEGIN PRIVATE KEY-----…';
  if (trimmed.length <= 10) return '***';
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-2)}`;
}

function previewOf(match: string, capture?: number): string {
  const raw = capture ? (match.split(/\s*[:=]\s*/).pop() ?? match) : match;
  return redact(raw).replace(/\s+/g, ' ').slice(0, 80);
}

function collect(text: string, rules: PatternRule[], kind: ToolWarning['kind'], out: Map<string, ToolWarning>): void {
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let match: RegExpExecArray | null = rule.re.exec(text);
    let count = 0;
    let preview = '';
    while (match !== null) {
      count++;
      if (!preview) preview = previewOf(match[0], rule.capture);
      if (rule.re.lastIndex === match.index) rule.re.lastIndex++;
      match = rule.re.exec(text);
    }
    if (!count) continue;
    const key = `${kind}:${rule.label}:${preview}`;
    if (out.has(key)) continue;
    out.set(key, {
      kind,
      severity: rule.severity,
      label: count > 1 ? `${rule.label}（${count} 处）` : rule.label,
      preview,
    });
  }
}

/** 扫描一段文本。结果按「类型+标签+脱敏预览」去重，最多返回 8 条。 */
export function scanTextForWarnings(text: string, opts: { includeSensitiveData?: boolean } = {}): ToolWarning[] {
  if (!text || text.length < 8) return [];
  const sample = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  const out = new Map<string, ToolWarning>();
  collect(sample, PROMPT_INJECTION_RULES, 'prompt-injection', out);
  if (opts.includeSensitiveData !== false) collect(sample, SENSITIVE_DATA_RULES, 'sensitive-data', out);
  return [...out.values()].slice(0, MAX_WARNINGS);
}

/** 递归扫描工具结果对象，限制深度、键数和总字符，避免大结果拖慢主循环。 */
export function scanValueForWarnings(value: unknown, opts: { includeSensitiveData?: boolean } = {}): ToolWarning[] {
  const chunks: string[] = [];
  let budget = MAX_SCAN_CHARS;
  let visited = 0;
  const walk = (node: unknown, depth: number): void => {
    if (budget <= 0 || visited > 4000 || depth > 6 || node === null || node === undefined) return;
    visited++;
    if (typeof node === 'string') {
      const text = node.length > budget ? node.slice(0, budget) : node;
      chunks.push(text);
      budget -= text.length;
      return;
    }
    if (typeof node === 'number' || typeof node === 'boolean') {
      const text = String(node);
      chunks.push(text);
      budget -= text.length;
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 200)) walk(item, depth + 1);
      return;
    }
    if (typeof node === 'object') {
      for (const [key, item] of Object.entries(node as Record<string, unknown>).slice(0, 200)) {
        if (budget <= 0) return;
        chunks.push(key);
        walk(item, depth + 1);
      }
    }
  };
  walk(value, 0);
  return scanTextForWarnings(chunks.join('\n'), opts);
}

const EXTERNAL_TOOL_NAME = /^(?:web_|mcp_|browser_|read_document$|ocr_|recall_tool_result$)/i;

/** 未声明 contentTrust 时按工具名识别外部来源；插件可显式声明 untrusted。 */
export function shouldScanToolContent(tool: { name: string; contentTrust?: 'trusted' | 'untrusted' }): boolean {
  if (tool.contentTrust === 'untrusted') return true;
  if (tool.contentTrust === 'trusted') return false;
  return EXTERNAL_TOOL_NAME.test(tool.name);
}

/** 给 LLM 的一段简短警告；不复述完整原文。 */
export function summarizeWarnings(warnings: ToolWarning[]): string {
  return warnings.map((warning) => `${warning.kind === 'prompt-injection' ? '提示注入' : '敏感信息'}:${warning.label}`).join('；');
}

/**
 * Trace/诊断参数的统一脱敏：只保留结构，不把凭据写入实时事件或归档。
 * server 与 core 共用这一份，避免两套脱敏规则漂移。
 */
export function redactTraceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactTraceValue);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = /(?:api[-_]?key|token|secret|password|authorization|cookie|credential)/i.test(key) ? '[REDACTED]' : redactTraceValue(child);
  }
  return out;
}
