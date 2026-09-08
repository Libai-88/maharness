/**
 * core/evolve/index.ts —— 自进化：任务后技能提案
 * 触发（agent.run.finished 的三个信号）：
 *   1. 用户强调：问题里出现「记住/以后都/不要再/必须/约定」等规则性表述 → 值得固化为技能；
 *   2. 高失败环节：本次 run 工具失败 ≥N 次，或同一工具跨 run 累计失败超阈值；
 *   3. 重复任务：与历史问题高度相似（bigram Dice）的问题再次出现。
 * 产出：data/skill-proposals/<id>.md（SKILL.md 形状草稿 + 提案元数据），
 *      等用户「采纳」才写入 data/skills/（skills 插件的 user 源），拒绝则归档。
 * 边界：只写 proposals/skills 目录，绝不自动改写任何既有技能或代码。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRunSummary, Plugin } from '../../kernel/types';
import { contentWords, bigramSet, dice } from '../../kernel/cache';
import { parseFrontMatter, fmString } from '../../kernel/frontmatter';

const EMPHASIS_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /(记住|记一下|以后(都|每次|再也?不|一定|务必)|下次(也|记得|一定))/, why: '用户给出了需要长期遵守的指示' },
  { re: /(不要(再|要|得)|别再|禁止|不准|不许|务必不要|千万别)/, why: '用户划定了禁止事项' },
  { re: /(必须|一定要|务必|规范|约定|标准做法|按.*(流程|规范|约定))/, why: '用户强调了做法的强制性' },
  { re: /(每次.*(都要|都必须|记得)|总是(要|记得))/, why: '用户描述了应每次都执行的步骤' },
];

const STOPWORDS_SKILL = /^(好的|谢谢|继续|然后呢|嗯)+[。！!？?]*$/;

export interface ProposalMeta {
  id: string;
  name: string;
  description: string;
  reason: string;
  signals: string[];
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: number;
  updatedAt: number;
  seen: number;
  question?: string;
  evidence?: string;
}

let busOff: (() => void) | null = null;

export default {
  id: 'evolve',
  name: '自进化提案',
  version: '0.1.0',
  onLoad(ctx) {
    const enabled = ctx.config.get<boolean>('evolve.enabled', true);
    const auto = ctx.config.get<boolean>('evolve.autoProposals', true);
    const minFailures = Math.max(2, ctx.config.get<number>('evolve.minToolFailures', 2));
    const dir = join(ctx.paths.data, 'skill-proposals');
    const stateFile = join(ctx.paths.data, 'evolve-state.json');
    mkdirSync(dir, { recursive: true });

    interface State { toolStats: Record<string, { calls: number; fails: number; lastFailTs: number }>; questions: { text: string; ts: number }[] }
    let state: State = { toolStats: {}, questions: [] };
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf-8')) as State;
      if (parsed && typeof parsed === 'object') state = { toolStats: parsed.toolStats ?? {}, questions: parsed.questions ?? [] };
    } catch { /* 首次运行无状态文件 */ }
    let dirty = false;
    const save = () => {
      if (!dirty) return;
      dirty = false;
      try { writeFileSync(stateFile, JSON.stringify(state), 'utf-8'); } catch { /* 状态写盘失败不影响主流程 */ }
    };
    const timer = setInterval(save, 20_000);
    (timer as { unref?: () => void }).unref?.();

    const slug = (s: string): string => s.toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'skill';
    const newId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

    function loadProposals(): ProposalMeta[] {
      if (!existsSync(dir)) return [];
      const out: ProposalMeta[] = [];
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        try {
          const fm = parseFrontMatter(readFileSync(join(dir, f), 'utf-8'));
          const name = fmString(fm.data, 'name');
          if (!name) continue;
          out.push({
            id: f.replace(/\.md$/, ''),
            name,
            description: fmString(fm.data, 'description'),
            reason: fmString(fm.data, 'reason'),
            signals: (fm.data['signals'] as string[] | undefined) ?? String(fm.data['signals'] ?? '').split(',').filter(Boolean),
            status: (fmString(fm.data, 'status') || 'pending') as ProposalMeta['status'],
            createdAt: Number(fmString(fm.data, 'created-at')) || Date.now(),
            updatedAt: Number(fmString(fm.data, 'updated-at')) || Date.now(),
            seen: Number(fmString(fm.data, 'seen')) || 1,
            question: fmString(fm.data, 'question') || undefined,
            evidence: fmString(fm.data, 'evidence') || undefined,
          });
        } catch { /* 坏文件跳过 */ }
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    }

    function writeProposal(p: ProposalMeta, body: string): void {
      const file = join(dir, `${p.id}.md`);
      const md = ['---',
        `name: ${p.name}`,
        `description: ${p.description}`,
        `reason: ${p.reason}`,
        `signals: ${p.signals.join(', ')}`,
        `status: ${p.status}`,
        `created-at: ${p.createdAt}`,
        `updated-at: ${p.updatedAt}`,
        `seen: ${p.seen}`,
        `question: ${(p.question ?? '').replace(/\r?\n/g, ' ').slice(0, 200)}`,
        '---', '', body].join('\n');
      writeFileSync(file, md, 'utf-8');
    }

    const skillsHandle = ctx.inject('service:skills');
    const skillsSvc = () => skillsHandle.value as { invalidateCache?: () => void } | undefined;

    /** 读回提案正文（frontmatter 之后的部分） */
    function proposalBody(id: string): string | null {
      const file = join(dir, `${id}.md`);
      if (!existsSync(file)) return null;
      try { return parseFrontMatter(readFileSync(file, 'utf-8')).body; } catch { return null; }
    }

    /** 命中同名待确认提案则累加次数，否则新建 */
    function upsert(signals: string[], name: string, description: string, reason: string, body: string, question: string, evidence?: string): ProposalMeta | null {
      const pending = loadProposals().filter(p => p.status === 'pending');
      if (pending.length >= 12) return null;                 // 待确认积压过多时不再打扰
      const dup = pending.find(p => p.name === name || (p.signals.length > 0 && p.signals.join() === signals.join()));
      if (dup) {
        dup.seen++;
        dup.updatedAt = Date.now();
        writeProposal(dup, proposalBody(dup.id) ?? body);
        ctx.bus.emit({ type: 'evolve.proposal', data: { id: dup.id, name: dup.name, seen: dup.seen, updated: true }, ts: Date.now() });
        return dup;
      }
      const p: ProposalMeta = {
        id: newId(), name, description, reason, signals,
        status: 'pending', createdAt: Date.now(), updatedAt: Date.now(), seen: 1, question: question.slice(0, 300), evidence,
      };
      writeProposal(p, body);
      ctx.bus.emit({ type: 'evolve.proposal', data: { id: p.id, name: p.name, seen: 1, updated: false }, ts: Date.now() });
      return p;
    }

    const draftBody = (p: { name: string; description: string; reason: string }, question: string): string => [
      `# ${p.name}`, '',
      `> 由 maharness 在任务后自动起草（${p.reason}）。采纳前请核对内容。`, '',
      '## 何时使用', '',
      p.description || `用户提出与下列表述同类的需求时使用：「${question.slice(0, 120)}」`, '',
      '## 步骤', '',
      '1. 先复述目标与约束，确认与用户一致；',
      '2. 按下列固定做法执行（把失败点写成显式步骤，而不是靠临场回忆）：',
      '   - （把本次任务里被验证有效的操作序列写在这里，含具体命令/路径/参数）',
      '3. 完成后自检：逐条核对用户强调的要求是否全部满足。', '',
      '## 禁止事项', '',
      '- （把本次任务里踩过的坑、被用户纠正过的点写在这里）', '',
      '## 来源', '',
      `- 触发问题：${question.slice(0, 300)}`,
      `- 起草时间：${new Date().toLocaleString('zh-CN')}`,
      '',
    ].join('\n');

    function onRunFinished(summary: AgentRunSummary): void {
      if (!enabled || !auto) return;
      for (const [tool, n] of Object.entries(summary.failedTools)) {
        const row = state.toolStats[tool] ??= { calls: 0, fails: 0, lastFailTs: 0 };
        row.fails += n;
        row.lastFailTs = Date.now();
        dirty = true;
      }
      const calls = state.toolStats as State['toolStats'];
      const q = String(summary.question ?? '').trim();
      if (!q || STOPWORDS_SKILL.test(q)) return;

      const emphasis = EMPHASIS_PATTERNS.find(e => e.re.test(q));
      const signals: string[] = [];
      let name = '';
      let description = '';
      let reason = '';
      if (emphasis) {
        signals.push('用户强调');
        name = `rule-${slug(q.slice(0, 24))}`;
        description = `固化用户强调的做法：${q.slice(0, 120)}`;
        reason = emphasis.why;
      } else if (summary.toolFailures >= minFailures) {
        const worst = Object.entries(summary.failedTools).sort((a, b) => b[1] - a[1])[0];
        signals.push('高失败环节');
        name = `fix-${slug(worst?.[0] ?? 'tool')}-failures`;
        description = `把「${worst?.[0] ?? '工具'}」反复失败后摸索出的正确路径固化为技能`;
        reason = `本次任务工具失败 ${summary.toolFailures} 次`;
      } else {
        const hist = state.questions.find(x => Date.now() - x.ts < 30 * 864e5 && dice(bigramSet(contentWords(x.text)), bigramSet(contentWords(q))) >= 0.55);
        if (!hist) { state.questions.push({ text: q.slice(0, 200), ts: Date.now() }); if (state.questions.length > 200) state.questions.shift(); dirty = true; return; }
        signals.push('重复任务');
        name = `flow-${slug(q.slice(0, 24))}`;
        description = `重复出现的任务流程，沉淀后可直接套用：${q.slice(0, 100)}`;
        reason = '近 30 天内出现相似问题';
      }
      for (const t of Object.keys(summary.failedTools)) if (calls[t]?.fails >= minFailures * 2 && !signals.includes('历史高失败')) signals.push('历史高失败');
      const body = draftBody({ name, description, reason }, q);
      upsert(signals, name, description, reason, body, q,
        Object.keys(summary.failedTools).length ? `失败统计: ${JSON.stringify(summary.failedTools)}` : undefined);
    }

    const off = ctx.bus.on('agent.run.finished', (e) => {
      try { onRunFinished((e as { data: AgentRunSummary }).data); } catch { /* 进化失败绝不影响对话 */ }
    });
    busOff = () => { try { off(); } catch { /* 已卸载 */ } };

    ctx.register({
      kind: 'persona',
      persona: {
        id: 'evolve-rules',
        name: '自进化规则',
        description: '任务完成后何时提议沉淀技能',
        priority: 8,
        content: [
          '自进化规则：',
          '1. 任务完成时，如果本次有用户特别强调的要求、或某个工具反复失败后才摸索出正确做法、或这是重复出现的流程——主动用一句话询问用户是否沉淀为技能；',
          '2. 用户同意后才调用 propose_skill 产出提案（草稿写清楚「何时使用/步骤/禁止事项」），并告知用户提案可在「技能」页采纳；',
          '3. 不要为一次性、上下文特殊的问答提提案；同一类信号合并，避免刷屏；',
          '4. 提案只是草稿：不得直接改 data/skills 下已有技能，不得把提案当作已生效规则。',
        ].join('\n'),
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'propose_skill',
        risk: 'low',
        costHint: 'low',
        limits: '只写 data/skill-proposals/，采纳由用户在界面确认',
        output: '{id, name, status}',
        description: '产出一份「可复用技能」提案草稿（等用户采纳）。当用户表示"以后都这样做/把这个流程固化"时使用；正文按「何时使用 / 步骤 / 禁止事项」组织。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '技能名（小写短横线，如 weekly-report-flow）' },
            description: { type: 'string', description: '一句话描述（索引会展示给未来的自己）' },
            body: { type: 'string', description: 'SKILL.md 正文（Markdown）' },
            reason: { type: 'string', description: '为什么要固化（用户强调过什么 / 哪个环节易错）' },
          },
          required: ['name', 'description', 'body'],
        },
        async handler(args: { name?: string; description?: string; body?: string; reason?: string }) {
          const name = String(args.name ?? '').trim().replace(/[^\w.\u4e00-\u9fa5-]/g, '').slice(0, 60);
          if (!name) return { ok: false, error: 'name 不合法（用小写短横线或中文）' };
          const p = upsert(['模型主动提议'], name, String(args.description ?? '').slice(0, 300),
            String(args.reason ?? '模型判断值得复用').slice(0, 300), String(args.body ?? ''), String(args.reason ?? ''));
          return p ? { ok: true, data: { id: p.id, name: p.name, status: p.status } }
            : { ok: false, error: '待确认提案已达上限（12 条），请先到技能页处理' };
        },
      },
    });

    ctx.register({
      kind: 'service',
      service: {
        id: 'evolve',
        instance: {
          list: loadProposals,
          toolStats: () => state.toolStats,
          /** 采纳：写入 data/skills/<name>/SKILL.md 并标记 accepted（skills 插件 user 源生效） */
          accept(id: string): { ok: boolean; error?: string; name?: string } {
            const file = join(dir, `${id}.md`);
            if (!existsSync(file)) return { ok: false, error: '提案不存在' };
            const md = readFileSync(file, 'utf-8');
            const fm = parseFrontMatter(md);
            const name = fmString(fm.data, 'name').replace(/[^\w.\u4e00-\u9fa5-]/g, '');
            if (!name) return { ok: false, error: '提案缺少 name' };
            const userDir = join(ctx.paths.data, 'skills', name);
            if (existsSync(join(userDir, 'SKILL.md'))) return { ok: false, error: `同名技能已存在: ${name}` };
            mkdirSync(userDir, { recursive: true });
            writeFileSync(join(userDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${fmString(fm.data, 'description')}\n---\n\n${fm.body}`, 'utf-8');
            const meta = loadProposals().find(p => p.id === id);
            if (meta) { meta.status = 'accepted'; meta.updatedAt = Date.now(); writeProposal(meta, fm.body); }
            skillsSvc()?.invalidateCache?.();
            ctx.bus.emit({ type: 'evolve.accepted', data: { id, name }, ts: Date.now() });
            return { ok: true, name };
          },
          reject(id: string): { ok: boolean; error?: string } {
            const file = join(dir, `${id}.md`);
            if (!existsSync(file)) return { ok: false, error: '提案不存在' };
            const meta = loadProposals().find(p => p.id === id);
            if (meta) { meta.status = 'rejected'; meta.updatedAt = Date.now(); writeProposal(meta, parseFrontMatter(readFileSync(file, 'utf-8')).body); }
            return { ok: true };
          },
          remove(id: string): { ok: boolean } {
            rmSync(join(dir, `${id}.md`), { force: true });
            return { ok: true };
          },
        },
      },
    });

    const pending = loadProposals().filter(p => p.status === 'pending').length;
    ctx.logger.info(`自进化就绪：${auto ? 'run 结束自动提案' : '自动提案已关闭'}，待确认提案 ${pending} 条（${dir}）`);
  },
  onStop() {
    busOff?.();
    busOff = null;
  },
} satisfies Plugin;
