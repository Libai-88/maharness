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

  if (type !== undefined && !typeMatches(value, String(type))) {
    return [`${path}: 期望 ${type}，实际 ${describe(value)}`];
  }
  if (type === 'object' || (type === undefined && value && typeof value === 'object' && !Array.isArray(value))) {
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
  } else if (type === 'array' || (type === undefined && Array.isArray(value))) {
    if (!Array.isArray(value)) return issues;
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) value.forEach((item, i) => issues.push(...check(item, items, `${path}[${i}]`)));
  } else if (type === 'string') {
    if (typeof value !== 'string') return issues;
    if (typeof schema.enum === 'object' && schema.enum !== null && Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
      issues.push(`${path}: 值 "${value}" 不在允许枚举内`);
    }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      issues.push(`${path}: 长度 ${value.length} < minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      issues.push(`${path}: 长度 ${value.length} > maxLength ${schema.maxLength}`);
    }
  } else if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number') return issues;
    if (type === 'integer' && !Number.isInteger(value)) issues.push(`${path}: 期望整数，实际 ${value}`);
    if (typeof schema.minimum === 'number' && value < schema.minimum) issues.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) issues.push(`${path}: ${value} > maximum ${schema.maximum}`);
  }
  return issues;
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true; // 未知类型：不校验（渐进增强）
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array[${value.length}]`;
  return typeof value;
}
