/**
 * kernel/validate.ts —— 轻量 JSONSchema 子集校验器
 *
 * 对标 OpenAI/Anthropic 的 structured output：工具声明 outputSchema 后，
 * 执行结果在回填给 LLM 前先做机器校验——"成败机器可判"从 {ok,data/error}
 * 返回值延伸到输出结构本身。校验失败不阻断（LLM 可拿原始结果自我修正），
 * 但回填内容附【输出校验】标注、校验事件入 Trace（可观测）。
 *
 * 刻意不引第三方校验库（保持薄内核、零依赖）：只实现 Agent 工具最常用的子集——
 * type / object.properties / required / array.items / string.enum / number.minimum·maximum /
 * string.minLength·maxLength。超出子集的声明视为"不校验该规则"（渐进增强，不阻断）。
 */

export type ValidationIssue = string;

/** 校验值是否符合 schema；返回问题列表（空 = 通过） */
export function validateAgainstSchema(value: unknown, schema: Record<string, unknown>): ValidationIssue[] {
  return check(value, schema, '$');
}

function check(value: unknown, schema: Record<string, unknown>, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const type = schema.type;

  // B6 修复：未知 type 不再 fail-open。旧实现 `default: return true`，于是
  // `type: 'strng'` 这类拼写错误既通过类型检查、又不落入任何分支规则——
  // 该节点下的 required/properties/enum/minimum 全部静默跳过，且无任何告警。
  // schema 常由 LLM 经 create_plugin 现场生成，拼错概率不低，"静默不校验"
  // 与本项目「成败机器可判」的基调相反，因此改为 fail-closed 并明确报出拼写问题。
  if (type !== undefined && !isSupportedType(type)) {
    return [`${path}: schema 的 type ${JSON.stringify(type)} 不在支持子集内（可能是拼写错误；支持：${SUPPORTED_TYPES.join(' / ')}）`];
  }
  if (type !== undefined && !typeMatches(value, type)) {
    return [`${path}: 期望 ${formatType(type)}，实际 ${describe(value)}`];
  }
  const typeName = Array.isArray(type) ? (type as string[]).find((t) => typeMatches(value, t)) : type;
  if (typeName === 'object' || (type === undefined && value && typeof value === 'object' && !Array.isArray(value))) {
    if (value === null || Array.isArray(value)) return issues;
    const obj = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const key of required) {
      if (!(key in obj)) issues.push(`${path}.${key}: 缺少必填字段`);
    }
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const [key, propSchema] of Object.entries(props)) {
      if (key in obj) issues.push(...check(obj[key], propSchema, `${path}.${key}`));
    }
  } else if (typeName === 'array' || (type === undefined && Array.isArray(value))) {
    if (!Array.isArray(value)) return issues;
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) value.forEach((item, i) => issues.push(...check(item, items, `${path}[${i}]`)));
  } else if (typeName === 'string' || (type === undefined && typeof value === 'string')) {
    // 未显式声明 type 时按值的实际类型应用规则：string 值照常校验 enum/minLength/maxLength
    // （旧实现只认 type==='string'，无 type 声明的 schema 三条规则全部静默跳过）
    if (typeof value !== 'string') return issues;
    if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
      issues.push(`${path}: 值 "${value}" 不在允许枚举内`);
    }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      issues.push(`${path}: 长度 ${value.length} < minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      issues.push(`${path}: 长度 ${value.length} > maxLength ${schema.maxLength}`);
    }
  } else if (typeName === 'number' || typeName === 'integer') {
    if (typeof value !== 'number') return issues;
    if (typeName === 'integer' && !Number.isInteger(value)) issues.push(`${path}: 期望整数，实际 ${value}`);
    if (typeof schema.minimum === 'number' && value < schema.minimum) issues.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) issues.push(`${path}: ${value} > maximum ${schema.maximum}`);
  }
  return issues;
}

/** 支持的类型子集（与文件头声明一致）。 */
const SUPPORTED_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'] as const;

function isSupportedType(type: unknown): boolean {
  if (typeof type === 'string') return (SUPPORTED_TYPES as readonly string[]).includes(type);
  // JSONSchema 允许 type 为数组（联合类型）：其中每一项都必须在子集内
  if (Array.isArray(type)) return type.length > 0 && type.every((t) => typeof t === 'string' && (SUPPORTED_TYPES as readonly string[]).includes(t));
  return false;
}

function formatType(type: unknown): string {
  return Array.isArray(type) ? type.join('|') : String(type);
}

function typeMatches(value: unknown, type: unknown): boolean {
  const one = (t: string): boolean => {
    switch (t) {
      case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
      case 'array': return Array.isArray(value);
      case 'string': return typeof value === 'string';
      case 'number': return typeof value === 'number';
      case 'integer': return typeof value === 'number' && Number.isInteger(value);
      case 'boolean': return typeof value === 'boolean';
      case 'null': return value === null;
      default: return false; // 未知类型一律不匹配（配合上方 isSupportedType 的显式报错）
    }
  };
  if (Array.isArray(type)) return type.some((t) => one(String(t)));
  return one(String(type));
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array[${value.length}]`;
  return typeof value;
}
