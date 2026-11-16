export function verificationLabel(value: unknown): string {
  if (!value || typeof value !== 'object') return '尚未验证';
  const type = (value as { type?: string }).type;
  return type === 'task_verified' ? '机器验收通过' : type === 'task_partial' ? '机器验收部分通过' : type === 'task_failed' ? '机器验收未通过' : '有验收记录，结论未识别';
}

export function toolStatusLabel(status: string): string {
  return ({ started: '执行中', succeeded: '执行成功', failed: '执行失败', unknown: '结果未知，禁止自动重放' } as Record<string, string>)[status] ?? status;
}

export function latestRunFiles<T extends { id: string; runId: string; kind: string; createdAt: number; metadata?: { draftId?: string; status?: string } }>(files: T[]): T[] {
  const visible = new Map<string, T>();
  for (const file of [...files].sort((a, b) => a.createdAt - b.createdAt)) {
    if (file.kind !== 'file') continue;
    const key = file.metadata?.draftId ? `${file.runId}:${file.metadata.draftId}:${file.metadata.status ?? 'draft'}` : file.id;
    visible.set(key, file);
  }
  return [...visible.values()];
}
