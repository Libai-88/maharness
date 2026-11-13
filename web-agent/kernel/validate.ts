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

import type { ToolDef } from './types';

export type ValidationIssue = string;

/** 校验值是否符合 schema；返回问题列表（空 = 通过） */
export function validateAgainstSchema(value: unknown, schema: Record<string, unknown>): ValidationIssue[] {
  return check(value, schema, '$');
}

export function validateToolArguments(tool: ToolDef, args: unknown): ValidationIssue[] {
  return validateAgainstSchema(args, tool.parameters);
}

function check(value: unknown, schema: Record<string, unknown>, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const type = schema.type;

  if ('const' in schema && !sameJsonValue(value, schema.const)) {
    issues.push(`${path}: 值必须等于 ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).some((item) => sameJsonValue(item, value))) {
    issues.push(`${path}: 值 ${JSON.stringify(value)} 不在允许枚举内`);
  }
  for (const [keyword, mode] of [['allOf', 'all'], ['anyOf', 'any'], ['oneOf', 'one']] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    const results = branches.map((branch) => {
      if (!branch || typeof branch !== 'object' || Array.isArray(branch)) return [`${path}: ${keyword} 分支必须是 schema`];
      return check(value, branch as Record<string, unknown>, path);
    });
    const passed = results.filter((result) => result.length === 0).length;
    if (mode === 'all' && passed !== results.length) issues.push(`${path}: allOf 未全部通过`);
    if (mode === 'any' && passed === 0) issues.push(`${path}: anyOf 没有任何分支通过`);
    if (mode === 'one' && passed !== 1) issues.push(`${path}: oneOf 必须恰好一个分支通过（实际 ${passed}）`);
    if ((mode === 'any' || mode === 'one') && passed === 0) {
      for (const [index, result] of results.entries()) {
        issues.push(...result.map((issue) => `${issue}（${keyword}[${index}]）`));
      }
    }
  }

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
      if (!Object.hasOwn(obj, key) || obj[key] === undefined) issues.push(`${path}.${key}: 缺少必填字段`);
    }
    const propertyCount = Object.values(obj).filter(value => value !== undefined).length;
    if (typeof schema.minProperties === 'number' && propertyCount < schema.minProperties) {
      issues.push(`${path}: 属性数 ${propertyCount} < minProperties ${schema.minProperties}`);
    }
    if (typeof schema.maxProperties === 'number' && propertyCount > schema.maxProperties) {
      issues.push(`${path}: 属性数 ${propertyCount} > maxProperties ${schema.maxProperties}`);
    }
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const [key, propSchema] of Object.entries(props)) {
      if (Object.hasOwn(obj, key) && obj[key] !== undefined) issues.push(...check(obj[key], propSchema, `${path}.${key}`));
    }
    const patterns = (schema.patternProperties ?? {}) as Record<string, Record<string, unknown>>;
    for (const [key, valueOfKey] of Object.entries(obj)) {
      if (valueOfKey === undefined) continue;
      if (key in props) continue;
      let matchedPattern = false;
      for (const [pattern, patternSchema] of Object.entries(patterns)) {
        let re: RegExp;
        try { re = new RegExp(pattern); } catch { issues.push(`${path}: patternProperties 正则无效 ${pattern}`); continue; }
        if (!re.test(key)) continue;
        matchedPattern = true;
        issues.push(...check(valueOfKey, patternSchema, `${path}.${key}`));
      }
      if (matchedPattern) continue;
      if (schema.additionalProperties === false) {
        issues.push(`${path}.${key}: 不允许的额外属性`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        issues.push(...check(valueOfKey, schema.additionalProperties as Record<string, unknown>, `${path}.${key}`));
      }
    }
  } else if (typeName === 'array' || (type === undefined && Array.isArray(value))) {
    if (!Array.isArray(value)) return issues;
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      issues.push(`${path}: 元素数 ${value.length} < minItems ${schema.minItems}`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      issues.push(`${path}: 元素数 ${value.length} > maxItems ${schema.maxItems}`);
    }
    if (schema.uniqueItems === true) {
      for (let i = 0; i < value.length; i++) {
        for (let j = i + 1; j < value.length; j++) {
          if (sameJsonValue(value[i], value[j])) issues.push(`${path}[${j}]: 与 [${i}] 重复（uniqueItems）`);
        }
      }
    }
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) value.forEach((item, i) => issues.push(...check(item, items, `${path}[${i}]`)));
  } else if (typeName === 'string' || (type === undefined && typeof value === 'string')) {
    // 未显式声明 type 时按值的实际类型应用规则：string 值照常校验 enum/minLength/maxLength
    // （旧实现只认 type==='string'，无 type 声明的 schema 三条规则全部静默跳过）
    if (typeof value !== 'string') return issues;
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      issues.push(`${path}: 长度 ${value.length} < minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      issues.push(`${path}: 长度 ${value.length} > maxLength ${schema.maxLength}`);
    }
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) issues.push(`${path}: 不匹配 pattern ${schema.pattern}`);
      } catch {
        issues.push(`${path}: schema 的 pattern 正则无效 ${schema.pattern}`);
      }
    }
  } else if (typeName === 'number' || typeName === 'integer') {
    if (typeof value !== 'number') return issues;
    if (typeName === 'integer' && !Number.isInteger(value)) issues.push(`${path}: 期望整数，实际 ${value}`);
    if (typeof schema.minimum === 'number' && value < schema.minimum) issues.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) issues.push(`${path}: ${value} > maximum ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) issues.push(`${path}: ${value} <= exclusiveMinimum ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) issues.push(`${path}: ${value} >= exclusiveMaximum ${schema.exclusiveMaximum}`);
  }
  return issues;
}

function sameJsonValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
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
