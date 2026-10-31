export interface MemoryPrivacyResult { sensitive: boolean; reason?: string }

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i, 'private-key'],
  [/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)\s*[:=]/i, 'credential-assignment'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i, 'bearer-token'],
  [/(?:^|\s)sk-[A-Za-z0-9_-]{12,}/, 'provider-key'],
];

const SECRET_PATH_PATTERNS: Array<[RegExp, string]> = [
  [/(?:^|[\\/\s])\.env(?:\.|$)/i, 'env-file'],
  [/(?:^|[\\/])secret\.key(?:\.|$)/i, 'secret-key-file'],
  [/(?:^|[\\/])(?:id_rsa|id_ed25519|credentials\.json)(?:$|[\\/])/i, 'credential-file'],
  [/(?:^|[\\/\s])\.ssh[\\/]/i, 'ssh-directory'],
];

export function inspectMemoryText(text: string): MemoryPrivacyResult {
  for (const [pattern, reason] of SECRET_PATTERNS) if (pattern.test(text)) return { sensitive: true, reason };
  for (const [pattern, reason] of SECRET_PATH_PATTERNS) if (pattern.test(text)) return { sensitive: true, reason };
  return { sensitive: false };
}
