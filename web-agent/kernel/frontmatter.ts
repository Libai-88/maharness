/**
 * kernel/frontmatter.ts —— Markdown frontmatter 解析（YAML 子集，零依赖）
 * 兼容 Claude Code / Codex / OpenAI skills 的 SKILL.md 约定：
 *   name / description（含 | 与 > 折叠写法、引号写法）/ license / allowed-tools（逗号或列表）
 *   metadata: 下的任意 k: v 映射
 * 解析失败不抛异常：返回已解析部分 + body，保证"坏文件不拖垮技能列表"。
 */

export type FmValue = string | string[] | Record<string, string>;

export interface FrontMatter {
  data: Record<string, FmValue>;
  body: string;
  /** 解析过程中遇到的问题（不致命，供 UI 提示） */
  warnings: string[];
}

const FM_OPEN = /^---[ \t]*\r?\n/;

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  return t;
}

function indentOf(line: string): number {
  const m = /^(\s*)/.exec(line);
  return m ? m[1].length : 0;
}

/** 逗号分隔或 YAML 内联数组 [a, b] → string[] */
function toList(v: string): string[] {
  const t = v.trim();
  const inner = t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1) : t;
  return inner.split(',').map(s => unquote(s)).filter(s => s !== '');
}

export function parseFrontMatter(md: string): FrontMatter {
  const warnings: string[] = [];
  const text = md.replace(/^\uFEFF/, '');
  if (!FM_OPEN.test(text)) return { data: {}, body: text, warnings };
  const after = text.slice(text.indexOf('\n') + 1);
  const endRel = /^---[ \t]*$/m.exec(after);
  if (!endRel || endRel.index === undefined) {
    warnings.push('frontmatter 未闭合（缺少结束 ---），按无 frontmatter 处理');
    return { data: {}, body: text, warnings };
  }
  const raw = after.slice(0, endRel.index);
  const body = after.slice(endRel.index + endRel[0].length).replace(/^\r?\n/, '');
  const data: Record<string, FmValue> = {};
  const lines = raw.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (indentOf(line) > 0) { warnings.push(`忽略缩进的游离行: ${line.trim().slice(0, 40)}`); continue; }
    const kv = /^([A-Za-z0-9_.-]+):(.*)$/.exec(line);
    if (!kv) { warnings.push(`无法解析的行: ${line.trim().slice(0, 40)}`); continue; }
    const key = kv[1];
    let value = kv[2];

    // 折叠/字面块标量（description: | 或 description: >）
    if (/^\s*[|>][-+]?\s*$/.test(value)) {
      const folded = value.trim().startsWith('>');
      const block: string[] = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === '' || indentOf(lines[i + 1]) > 0)) {
        block.push(lines[i + 1].trim());
        i++;
      }
      data[key] = folded ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim();
      continue;
    }
    // YAML 列表（- item）
    if (value.trim() === '' && i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        i++;
        items.push(unquote(lines[i].replace(/^\s*-\s+/, '')));
      }
      data[key] = items;
      continue;
    }
    // 嵌套映射（metadata: 下 k: v）
    if (value.trim() === '' && i + 1 < lines.length && indentOf(lines[i + 1]) > 0 && /^[A-Za-z0-9_.-]+:/.test(lines[i + 1].trim())) {
      const map: Record<string, string> = {};
      while (i + 1 < lines.length && lines[i + 1].trim() !== '' && indentOf(lines[i + 1]) > 0) {
        i++;
        const sub = /^([A-Za-z0-9_.-]+):(.*)$/.exec(lines[i].trim());
        if (sub) map[sub[1]] = unquote(sub[2]);
      }
      data[key] = map;
      continue;
    }
    value = value.trim();
    if (/^\[.*\]$,?$/.test(value) || (value.includes(',') && !/^["'].*["']$/.test(value) && key.includes('tool'))) {
      data[key] = toList(value);
    } else {
      data[key] = unquote(value);
    }
  }
  return { data, body, warnings };
}

/** 取标量值（数组/映射时取首个或空串） */
export function fmString(data: Record<string, FmValue>, key: string): string {
  const v = data[key];
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v[0] ?? '';
  return '';
}

/** 取值并归一为字符串数组（兼容 "a, b" 与 YAML 列表） */
export function fmList(data: Record<string, FmValue>, key: string): string[] {
  const v = data[key];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) return toList(v);
  return [];
}

export function fmMap(data: Record<string, FmValue>, key: string): Record<string, string> {
  const v = data[key];
  return v && !Array.isArray(v) && typeof v === 'object' ? v : {};
}
