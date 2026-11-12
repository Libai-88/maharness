import { contentWords, bigramSet, dice } from '../../kernel/cache';
import { cosineSimilarity } from '../../kernel/vectors';

export interface SkillRouteEntry {
  name: string;
  description: string;
  triggers?: string[];
  appliesWhen?: string[];
  rejectWhen?: string[];
}

export interface SkillScore {
  name: string;
  score: number;
}

/**
 * 技能路由打分：描述是基础，triggers 是显式意图，appliesWhen 是适用条件，
 * rejectWhen 是一票否决的负向条件。保持纯函数，索引注入与离线评测共用同一套逻辑。
 */
export function scoreSkillEntries(
  entries: SkillRouteEntry[],
  query: string,
  opts: {
    queryVector?: number[];
    vectors?: Map<string, number[]>;
  } = {},
): SkillScore[] {
  const qNorm = query.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!qNorm) return entries.map((entry) => ({ name: entry.name, score: 0 }));
  const qWords = new Set(contentWords(qNorm));
  const qBi = bigramSet(contentWords(qNorm));
  const qVector = opts.queryVector;
  return entries.map((entry) => {
    const hay = [
      entry.name,
      entry.description,
      ...(entry.triggers ?? []),
      ...(entry.appliesWhen ?? []),
    ].join(' ').toLowerCase();
    const vector = opts.vectors?.get(entry.name);
    const semantic = qVector?.length && vector?.length === qVector.length
      ? Math.max(0, cosineSimilarity(qVector, vector))
      : 0;
    let score = semantic * 1.2 + dice(qBi, bigramSet(contentWords(hay)));
    for (const word of qWords) if (word.length > 1 && hay.includes(word)) score += 0.15;
    if (hay.includes(qNorm)) score += 0.5;
    for (const trigger of entry.triggers ?? []) {
      const t = trigger.toLowerCase().trim();
      if (t && qNorm.includes(t)) score += 0.35;
    }
    for (const condition of entry.appliesWhen ?? []) {
      const c = condition.toLowerCase().trim();
      if (c && qNorm.includes(c)) score += 0.2;
    }
    for (const condition of entry.rejectWhen ?? []) {
      const c = condition.toLowerCase().trim();
      if (c && qNorm.includes(c)) score -= 0.8;
    }
    return { name: entry.name, score };
  }).sort((a, b) => b.score - a.score);
}

export function topSkills(scores: SkillScore[], limit: number): SkillScore[] {
  return scores.filter((score) => score.score > 0).slice(0, Math.max(1, limit));
}
