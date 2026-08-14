/**
 * kernel/tokens.ts —— token 估算工具（core 与 server 共用）
 * 粗略估算：中文字符 ≈ 1 token，其他字符 ≈ 4 字符 1 token。
 * 用于上下文预算管理、L3 前缀缓存统计等场景（非精确计费，仅近似）。
 */

/** 估算一段文本的 token 数 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

/** 估算两组消息的公共前缀 token 数（provider 的 prompt 前缀缓存/KV cache 可复用的部分） */
export function sharedPrefixTokens(
  a: { role?: string; content?: string | null }[],
  b: { role?: string; content?: string | null }[],
): number {
  let tokens = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i].role !== b[i].role || a[i].content !== b[i].content) break;
    tokens += estimateTokens(a[i].content ?? '');
  }
  return tokens;
}
