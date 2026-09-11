/**
 * plugins/workbench/index.ts —— 办公工作台 v2
 * 嵌入用户的「个人办公工作台.html」全量应用 + workbench-data.json 文件桥联动。
 *
 * 架构：
 *   1) 嵌入：GET /wb/app 返回 HTML 应用（单文件，无外部依赖）
 *   2) 文件桥：data/workbench-bridge/workbench-data.json 作为单一事实源
 *      Agent 工具（读→合并→写）与 HTML 应用（FileStore 写 + 轮询吸收）通过桥文件交换数据
 *   3) 合并语义与原版 JS 完全一致（LWW by updatedAt + 墓碑 + _s 示例剔除）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, watch, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from '../../kernel/types';

// ═══════════════════════════════════════════════════════════
// 桥文件数据模型（workbench-data.json 的完整形状）
// ═══════════════════════════════════════════════════════════

interface BridgeTask {
  id: string;
  title: string;
  prio: number;        // 1-4（默认 3）
  due: string;         // YYYY-MM-DD
  start: string;
  done: boolean;
  doneAt: number | null;
  pid: string;
  rolls: number;
  repeat: string;      // '' | 'daily' | 'weekdays' | 'weekly' | 'monthly'
  pomo: number;
  subs: { t: string; d: boolean }[];
  tags: string[];
  link: string;
  note: string;
  status: string;      // 'todo' | 'doing' | 'wait' | 'cancel'
  est: number;
  createdAt: number;
  updatedAt: number;
  _s?: boolean;
  [k: string]: unknown;
}

interface BridgeNote {
  id: string;
  text: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  _s?: boolean;
}

interface BridgeProject {
  id: string;
  name: string;
  stage: string;
  next: string;
  blocker: string;
  status: string;      // 'active' | 'blocked' | 'done'
  updatedAt: number;
  _s?: boolean;
}

interface BridgeFile {
  v: number;
  app: string;
  savedAt: string;
  tasks: BridgeTask[];
  notes: BridgeNote[];
  projects: BridgeProject[];
  diary: Record<string, string>;
  tomb: Record<string, number>;
  diaryTs: Record<string, number>;
  bin: unknown[];
  meta: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════
// 合并纯函数（逐行移植自原版 JS，语义完全一致）
// ═══════════════════════════════════════════════════════════

function mergeKindList<T extends { _s?: unknown }>(lArr: T[], rArr: T[]) {
  const lReal = lArr.some(x => !x._s), rReal = rArr.some(x => !x._s);
  let l = lArr, r = rArr;
  if (lReal && !rReal) r = [];
  else if (rReal && !lReal) l = [];
  else if (lReal && rReal) { l = l.filter(x => !x._s); r = r.filter(x => !x._s); }
  return { l, r };
}

function mergeLists<T extends { id: string; updatedAt: number; _s?: unknown }>(
  lArr: T[], rArr: T[], tomb: Record<string, number>,
): T[] {
  const { l, r } = mergeKindList(lArr, rArr);
  const lm = new Map(l.map(x => [String(x.id), x]));
  const rm = new Map(r.map(x => [String(x.id), x]));
  const out: T[] = [];
  new Set([...lm.keys(), ...rm.keys()]).forEach(id => {
    const lx = lm.get(id), rx = rm.get(id);
    const lT = lx ? Number(lx.updatedAt) || 0 : 0;
    const rT = rx ? Number(rx.updatedAt) || 0 : 0;
    const dT = Number(tomb[id]) || 0;
    if (dT && dT >= Math.max(lT, rT)) return;   // 墓碑有效：记录仍被删除
    if (dT) delete tomb[id];                    // 新编辑推翻删除 → 复活
    if (!lx) out.push(rx!);
    else if (!rx) out.push(lx);
    else out.push(lT >= rT ? lx : rx);          // LWW by updatedAt
  });
  return out;
}

type Mergeable = { id: string; updatedAt: number; _s?: unknown };
interface MergeInput<T1 extends Mergeable, T2 extends Mergeable, T3 extends Mergeable> {
  tasks?: T1[];
  notes?: T2[];
  projects?: T3[];
  tomb?: Record<string, number>;
}

export function mergeData<T1 extends Mergeable, T2 extends Mergeable, T3 extends Mergeable>(
  local: MergeInput<T1, T2, T3>, remote: MergeInput<T1, T2, T3>,
) {
  const tomb: Record<string, number> = { ...(local.tomb || {}), ...(remote.tomb || {}) };
  const cut = Date.now() - 90 * 864e5;
  Object.keys(tomb).forEach(id => {
    if (Number(tomb[id]) && Number(tomb[id]) < cut) delete tomb[id];
  });
  return {
    tasks: mergeLists(local.tasks ?? [], remote.tasks ?? [], tomb),
    notes: mergeLists(local.notes ?? [], remote.notes ?? [], tomb),
    projects: mergeLists(local.projects ?? [], remote.projects ?? [], tomb),
    tomb,
  };
}

export function mergeDiary(localD: Record<string, string>, localTs: Record<string, number>,
                           remoteD: Record<string, string>, remoteTs: Record<string, number>) {
  const out: Record<string, string> = {};
  const ts: Record<string, number> = { ...(localTs || {}), ...(remoteTs || {}) };
  const dates = new Set([...Object.keys(localD || {}), ...Object.keys(remoteD || {})]);
  dates.forEach(d => {
    const l = localD[d], r = remoteD[d];
    if (l === undefined) { out[d] = r; return; }
    if (r === undefined) { out[d] = l; return; }
    const lt = Number(localTs?.[d]) || 0, rt = Number(remoteTs?.[d]) || 0;
    if (lt >= rt) { out[d] = l; ts[d] = lt; } else { out[d] = r; ts[d] = rt; }
  });
  return { diary: out, diaryTs: ts };
}

export function mergeMeta(local: { meta?: Record<string, unknown> }, remote: { meta?: Record<string, unknown> }) {
  const lm = local.meta || {}, rm = remote.meta || {};
  const pomoLog: Record<string, number> = { ...(lm.pomoLog as Record<string, number> || {}) };
  Object.entries(rm.pomoLog as Record<string, number> || {}).forEach(([d, c]) => {
    pomoLog[d] = Math.max(Number(pomoLog[d]) || 0, Number(c) || 0);
  });
  return { ...lm, pomoLog, sample: !!(lm.sample && rm.sample) };
}

// ═══════════════════════════════════════════════════════════
// 日期工具
// ═══════════════════════════════════════════════════════════

function fmtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function todayStr(): string { return fmtDate(new Date()); }

function shift(base: string, n: number): string {
  const d = new Date(base + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

function nextDue(due: string, rpt: string): string {
  const base = due || todayStr();
  if (rpt === 'daily') return shift(base, 1);
  if (rpt === 'weekly') return shift(base, 7);
  if (rpt === 'weekdays') {
    let n = shift(base, 1);
    while ([0, 6].includes(new Date(n + 'T00:00:00').getDay())) n = shift(n, 1);
    return n;
  }
  if (rpt === 'monthly') {
    const d = new Date(base + 'T00:00:00'), day = d.getDate();
    d.setMonth(d.getMonth() + 1);
    if (d.getDate() !== day) d.setDate(0);   // 月末钳位（1/31 → 2/28）
    return fmtDate(d);
  }
  return base;
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const now = () => Date.now();

// ═══════════════════════════════════════════════════════════
// 桥文件读写
// ═══════════════════════════════════════════════════════════

const MAX_TASKS = 2000;
const MAX_NOTES = 1000;

function buildBridgePayload(local: Partial<BridgeFile>): BridgeFile {
  return {
    v: 1,
    app: 'workbench',
    savedAt: new Date().toISOString(),
    tasks: local.tasks ?? [],
    notes: local.notes ?? [],
    projects: local.projects ?? [],
    diary: local.diary ?? {},
    tomb: local.tomb ?? {},
    diaryTs: local.diaryTs ?? {},
    bin: local.bin ?? [],
    meta: local.meta ?? {},
  };
}

// ═══════════════════════════════════════════════════════════
// 默认导出：插件定义
// ═══════════════════════════════════════════════════════════

export default {
  id: 'workbench',
  name: '办公工作台',
  version: '0.2.0',

  onLoad(ctx) {
    const bridgeDir = process.env.WORKBENCH_BRIDGE_DIR || join(ctx.paths.data, 'workbench-bridge');
    const bridgeFile = join(bridgeDir, 'workbench-data.json');
    const legacyFile = join(ctx.paths.data, 'workbench.json');
    const appHtmlPath = join(ctx.paths.root, 'plugins', 'workbench', 'app.html');

    mkdirSync(bridgeDir, { recursive: true });

    // ---- 桥状态 ----
    let cached: BridgeFile | null = null;
    let lastWrittenRaw = '';
    let lastExternalAt = 0;
    let watcher: ReturnType<typeof watch> | null = null;

    // ---- 桥文件读取（轻量规整，确保数组字段存在） ----
    function readBridge(): BridgeFile | null {
      try {
        const raw = JSON.parse(readFileSync(bridgeFile, 'utf8'));
        return {
          v: 1,
          app: raw.app || 'workbench',
          savedAt: raw.savedAt || new Date().toISOString(),
          tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
          notes: Array.isArray(raw.notes) ? raw.notes : [],
          projects: Array.isArray(raw.projects) ? raw.projects : [],
          diary: raw.diary || {},
          tomb: raw.tomb || {},
          diaryTs: raw.diaryTs || {},
          bin: Array.isArray(raw.bin) ? raw.bin : [],
          meta: raw.meta || {},
        };
      } catch { return null; }
    }

    // ---- 桥文件原子写入（tmp + rename） ----
    function writeBridge(data: BridgeFile) {
      const payload = buildBridgePayload(data);
      const json = JSON.stringify(payload, null, 2);
      mkdirSync(bridgeDir, { recursive: true });
      const tmp = `${bridgeFile}.tmp`;
      try {
        writeFileSync(tmp, json, 'utf8');
        renameSync(tmp, bridgeFile);
      } catch {
        // Windows 文件锁或磁盘错误：回退到直接写入（不保留原子性，但保证数据持久化）
        try { writeFileSync(bridgeFile, json, 'utf8'); } catch { /* 不可写则静默放弃 */ }
      }
      lastWrittenRaw = json;
      cached = payload;
    }

    // ---- 事件广播 ----
    const notify = (reason: string) => {
      ctx.bus.emit({ type: 'workbench.updated', data: { reason, ts: now() }, ts: now() });
    };

    // ---- 桥状态端点数据 ----
    function bridgeStatus() {
      const fileExists = existsSync(bridgeFile);
      let mtimeMs = 0, lastSavedAt: string | null = null;
      if (fileExists) {
        try { mtimeMs = statSync(bridgeFile).mtimeMs; } catch {}
        if (!cached) cached = readBridge();
        lastSavedAt = cached?.savedAt ?? null;
      }
      return {
        ok: true,
        connected: fileExists,
        dir: bridgeDir,
        file: bridgeFile,
        records: {
          tasks: cached?.tasks?.length ?? 0,
          notes: cached?.notes?.length ?? 0,
          projects: cached?.projects?.length ?? 0,
        },
        lastSavedAt,
        lastExternalAt,
        mtimeMs,
      };
    }

    // ---- 字段规整（确保每条记录的关键字段存在） ----
    function ensureTaskFields(t: Partial<BridgeTask>): BridgeTask {
      return {
        id: String(t.id || newId()),
        title: String(t.title || '').trim(),
        prio: [1, 2, 3, 4].includes(Number(t.prio)) ? Number(t.prio) : 3,
        due: /^\d{4}-\d{2}-\d{2}$/.test(String(t.due || '')) ? String(t.due) : todayStr(),
        start: /^\d{4}-\d{2}-\d{2}$/.test(String(t.start || '')) ? String(t.start) : '',
        done: !!t.done,
        doneAt: t.doneAt != null ? (Number(t.doneAt) || null) : null,
        pid: String(t.pid || ''),
        rolls: Number(t.rolls) || 0,
        repeat: ['daily', 'weekdays', 'weekly', 'monthly'].includes(t.repeat as string) ? (t.repeat as string) : '',
        pomo: Number(t.pomo) || 0,
        subs: Array.isArray(t.subs) ? t.subs.slice(0, 9) : [],
        tags: Array.isArray(t.tags) ? t.tags.map(x => String(x).trim()).filter(Boolean).slice(0, 12) : [],
        link: String(t.link || '').trim().slice(0, 2048),
        note: String(t.note || '').trim().slice(0, 2000),
        status: ['todo', 'doing', 'wait', 'cancel'].includes(t.status as string) ? (t.status as string) : 'todo',
        est: Math.max(0, Math.min(20, Math.round(Number(t.est) || 0))),
        createdAt: Number(t.createdAt) || now(),
        updatedAt: Number(t.updatedAt) || now(),
        _s: t._s as boolean | undefined,
      };
    }

    function ensureNoteFields(n: Partial<BridgeNote>): BridgeNote {
      return {
        id: String(n.id || newId()),
        text: String(n.text || '').trim().slice(0, 1200),
        tags: Array.isArray(n.tags) ? n.tags.map(x => String(x).trim()).filter(Boolean).slice(0, 12) : [],
        createdAt: Number(n.createdAt) || now(),
        updatedAt: Number(n.updatedAt) || now(),
        _s: n._s as boolean | undefined,
      };
    }

    // ---- 读→合并外部变更→修改→写 模板 ----
    function withBridge(fn: (data: BridgeFile) => boolean | void): BridgeFile {
      const disk = readBridge();
      let data: BridgeFile;
      if (!disk) {
        data = cached ?? { v: 1, app: 'workbench', savedAt: new Date().toISOString(),
                           tasks: [], notes: [], projects: [], diary: {}, tomb: {}, diaryTs: {}, bin: [], meta: {} };
      } else if (!cached) {
        data = disk;
      } else {
        const m = mergeData(cached, disk);
        const md = mergeDiary(cached.diary, cached.diaryTs, disk.diary, disk.diaryTs);
        data = { ...cached, ...m, ...md, bin: disk.bin ?? cached.bin, meta: mergeMeta(cached, disk), savedAt: disk.savedAt };
      }
      const changed = fn(data);
      if (changed !== false) {
        cached = data;
        try { writeBridge(data); } catch { /* 写入失败：内存已更新，下次读仍有效 */ }
      }
      return data;
    }

    // ---- 重复任务推进 ----
    function spawnRepeat(t: BridgeTask): BridgeTask | null {
      if (!t.repeat || !t.due) return null;
      return ensureTaskFields({
        ...t, id: newId(),
        due: nextDue(t.due, t.repeat),
        start: t.start ? nextDue(t.start, t.repeat) : '',
        done: false, doneAt: null,
        rolls: 0, pomo: 0,
        subs: (t.subs || []).slice(0, 9).map(s => ({ t: s.t, d: false })),
        status: 'todo',
        createdAt: now(), updatedAt: now(),
      });
    }

    // ---- 项目名/id 互查 ----
    function resolveProject(ref: string | undefined, data: BridgeFile): string {
      if (!ref) return '';
      const s = String(ref).trim();
      const hit = data.projects.find(p => p.id === s || p.name === s);
      return hit?.id ?? '';
    }

    // ---- 旧数据迁移（maharness wb v1 → 桥格式） ----
    if (!existsSync(bridgeFile) && existsSync(legacyFile)) {
      try {
        const raw = JSON.parse(readFileSync(legacyFile, 'utf8'));
        if (raw && (Array.isArray(raw.tasks) || Array.isArray(raw.projects))) {
          const wbTasks: { id: string; title: string; notes?: string; date: string; time?: string; done: boolean; projectId?: string; repeat?: string; createdAt: number; updatedAt: number; order?: number }[] = raw.tasks ?? [];
          const wbProjects: { id: string; name: string; desc?: string; color?: string; status?: string; deadline?: string; updatedAt: number }[] = raw.projects ?? [];

          const projectMap = new Map<string, string>();
          const projects: BridgeProject[] = wbProjects.map(p => {
            const id = String(p.id || newId());
            return {
              id, name: String(p.name || ''),
              stage: String(p.desc || ''), next: '', blocker: '',
              status: p.status === 'paused' ? 'blocked' : p.status === 'done' ? 'done' : 'active',
              updatedAt: p.updatedAt || now(),
            };
          });

          const tasks: BridgeTask[] = wbTasks.filter(t => t && t.title).map(t => {
            const newPid = t.projectId ? (projectMap.get(t.projectId) ?? '') : '';
            if (t.projectId && !projectMap.has(t.projectId)) {
              const target = projects.find(p => p.id === t.projectId);
              if (target) projectMap.set(t.projectId, target.id);
            }
            const noteParts = [t.time ? `⏰ ${t.time}` : '', t.notes].filter(Boolean);
            return ensureTaskFields({
              id: t.id, title: t.title, prio: 2, due: t.date, start: '',
              done: !!t.done, doneAt: null, pid: newPid, rolls: 0,
              repeat: ['daily', 'weekdays', 'weekly'].includes(t.repeat ?? '') ? t.repeat : '',
              pomo: 0, subs: [], tags: [], link: '',
              note: noteParts.join(' · '), status: 'todo', est: 0,
              createdAt: t.createdAt, updatedAt: t.updatedAt,
            });
          });

          const data: BridgeFile = {
            v: 1, app: 'workbench', savedAt: new Date().toISOString(),
            tasks, notes: [], projects,
            diary: {}, tomb: {}, diaryTs: {}, bin: [],
            meta: { migratedFrom: 'maharness-workbench-v1', migratedAt: new Date().toISOString(), pomoLog: {} },
          };
          writeBridge(data);
          try { renameSync(legacyFile, `${legacyFile}.pre-bridge`); } catch {}
          console.log(`[workbench] 已迁移 ${tasks.length} 条任务 / ${projects.length} 个项目至桥文件`);
        }
      } catch (e) {
        console.warn('[workbench] 旧数据迁移失败:', e instanceof Error ? e.message : String(e));
      }
    }

    // ---- 初始加载 + 首次写入 ----
    cached = readBridge();
    if (cached) {
      console.log(`[workbench] 桥已连接：${bridgeFile}（${cached.tasks.length} tasks / ${cached.notes.length} notes / ${cached.projects.length} projects）`);
      try { writeBridge(cached); } catch {}
    } else {
      console.log(`[workbench] 桥未连接（文件不存在）：${bridgeFile}——用户在应用「备份」视图连接文件夹后生效`);
      cached = { v: 1, app: 'workbench', savedAt: new Date().toISOString(),
                 tasks: [], notes: [], projects: [], diary: {}, tomb: {}, diaryTs: {}, bin: [], meta: {} };
      try { writeBridge(cached); } catch {}
    }
    lastWrittenRaw = JSON.stringify(cached);

    // ---- 文件监听（外部写入 → 更新缓存 → 广播） ----
    try {
      let watchDebounce: ReturnType<typeof setTimeout> | null = null;
      watcher = watch(bridgeDir, () => {
        if (watchDebounce) return;
        watchDebounce = setTimeout(() => {
          watchDebounce = null;
          try {
            const raw = readFileSync(bridgeFile, 'utf8');
            if (raw === lastWrittenRaw) return;     // 自己写入的：跳过
            cached = readBridge();
            lastExternalAt = now();
            notify('bridge-external');
          } catch {}
        }, 300);
      });
      // fs.watch 可能因目录/文件系统异常触发 error 事件——监听并静默处理，
      // 避免未捕获异常导致整个进程崩溃（watcher 仍在内存但功能降级）
      if (watcher && typeof (watcher as any).on === 'function') {
        (watcher as any).on('error', (err: Error) => {
          console.warn('[workbench] 文件监听异常（不影响内存态）:', err.message);
        });
      }
    } catch {}

    // ---- 人设（扩展笔记/日记描述） ----
    ctx.register({
      kind: 'persona',
      persona: {
        id: 'workbench-rules',
        name: '办公工作台使用规则',
        description: '用户提到日程安排、今天要做的事、项目进度、灵感笔记、今日感想时，读写办公工作台数据',
        priority: 4,
        content: [
          '办公工作台使用规则（数据来自文件桥：与用户本地工作台实时联动）：',
          '1. 用户问日程/安排/今天做什么/项目进度时，先调 workbench_today 看真实数据再回答；',
          '2. 用户让你记日程或待办（如「明天下午3点开会」）→ workbench_add_task（due=YYYY-MM-DD，不传默认今天）；',
          '3. 用户说某件事做完/改期 → workbench_update_task（id 来自 workbench_today）；',
          '4. 用户记录灵感/想法 → workbench_add_note；记录今日感想 → workbench_diary；',
          '5. 工作台是用户本人的日常安排、灵感与项目，与 todo（你的执行清单）是两套数据，不要混写。',
        ].join('\n'),
      },
    });

    // ---- Agent 工具 ----
    ctx.register({
      kind: 'tool',
      tool: {
        name: 'workbench_today',
        risk: 'low',
        costHint: 'low',
        output: '{today, schedule, overdue, doneToday, projects, diary, upcoming, notesCount}',
        description: '查看办公工作台今日概览：今日任务、过期未完成数、各项目进度、今日日记、未来 7 天预告、灵感数。用户问日程/安排/进度时先调用。',
        parameters: { type: 'object', properties: {} },
        async handler() {
          if (!cached) return { ok: false, error: '桥未连接：请先在工作台「备份」视图连接文件夹' };
          const today = todayStr();
          const isCancel = (t: BridgeTask) => t.status === 'cancel';
          const schedule = cached.tasks
            .filter(t => t.due === today && !t.done && !isCancel(t))
            .sort((a, b) => (a.prio - b.prio) || (a.createdAt - b.createdAt));
          const overdue = cached.tasks.filter(t => t.due && t.due < today && !t.done && !isCancel(t)).length;
          const doneToday = cached.tasks.filter(t => t.due === today && t.done).length;
          const projOf = (pid: string) => cached!.projects.find(p => p.id === pid);
          const projects = cached.projects
            .filter(p => p.status !== 'done')
            .map(p => {
              const list = cached!.tasks.filter(t => t.pid === p.id && !isCancel(t));
              const d = list.filter(t => t.done).length;
              return { id: p.id, name: p.name, status: p.status, total: list.length, done: d, pct: list.length ? Math.round((d / list.length) * 100) : 0 };
            });
          const upcoming: { date: string; title: string; prio: number; project: string }[] = [];
          for (let i = 1; i <= 7; i++) {
            const d = shift(today, i);
            cached.tasks
              .filter(t => t.due === d && !t.done && !isCancel(t))
              .forEach(t => upcoming.push({ date: d, title: t.title, prio: t.prio, project: projOf(t.pid)?.name ?? '' }));
          }
          return {
            ok: true,
            data: {
              today,
              schedule: schedule.map(t => ({ id: t.id, title: t.title, prio: t.prio, done: t.done, status: t.status, project: projOf(t.pid)?.name ?? '', due: t.due })),
              overdue,
              doneToday,
              projects,
              diary: cached.diary?.[today] ?? null,
              upcoming: upcoming.slice(0, 15),
              notesCount: cached.notes.length,
            },
          };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'workbench_add_task',
        risk: 'low',
        costHint: 'low',
        output: '{id, title, due, prio}',
        description: '向办公工作台添加一条日程/待办（如「明天下午3点开会」→ due=明天）。不传 due 默认今天。重复任务完成时自动推进。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '事项标题（一句话）' },
            due: { type: 'string', description: '日期 YYYY-MM-DD（默认今天）' },
            prio: { type: 'number', description: '优先级 1-4（1=最急，默认 2）' },
            project: { type: 'string', description: '所属项目（id 或精确名称，可选）' },
            repeat: { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'monthly'], description: '重复频率（可选）' },
            note: { type: 'string', description: '补充说明（可选）' },
            status: { type: 'string', enum: ['todo', 'doing', 'wait'], description: '状态（默认 todo）' },
          },
          required: ['title'],
        },
        async handler(args: Record<string, unknown>) {
          if (!cached) return { ok: false, error: '桥未连接' };
          const title = String(args.title ?? '').trim();
          if (!title) return { ok: false, error: '缺少 title' };
          if (cached.tasks.length >= MAX_TASKS) return { ok: false, error: `任务已达上限（${MAX_TASKS}）` };

          const prio = [1, 2, 3, 4].includes(Number(args.prio)) ? Number(args.prio) : 2;
          const due = /^\d{4}-\d{2}-\d{2}$/.test(String(args.due || '')) ? String(args.due) : todayStr();
          const repeat = ['daily', 'weekdays', 'weekly', 'monthly'].includes(args.repeat as string) ? (args.repeat as string) : '';
          const status = ['todo', 'doing', 'wait'].includes(args.status as string) ? (args.status as string) : 'todo';
          const pid = resolveProject(args.project as string | undefined, cached);
          const note = String(args.note || '').trim().slice(0, 2000);

          let task: BridgeTask | null = null;
          withBridge(d => {
            task = ensureTaskFields({ id: newId(), title, prio, due, start: '', done: false, doneAt: null, pid, rolls: 0, repeat, pomo: 0, subs: [], tags: [], link: '', note, status, est: 0, createdAt: now(), updatedAt: now() });
            d.tasks.unshift(task);
            return true;
          });
          notify('agent-add');
          return { ok: true, data: { id: task!.id, title: task!.title, due: task!.due, prio: task!.prio } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'workbench_update_task',
        risk: 'low',
        costHint: 'low',
        output: '{id, title, done, due, prio, status}',
        description: '更新办公工作台的一条任务：完成/取消完成、改期、改优先级、改状态。id 来自 workbench_today。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '任务 id（workbench_today 返回）' },
            done: { type: 'boolean', description: '是否完成（重复任务完成会自动生成下一次）' },
            due: { type: 'string', description: '改期到 YYYY-MM-DD（可选）' },
            prio: { type: 'number', description: '优先级 1-4（可选）' },
            status: { type: 'string', enum: ['todo', 'doing', 'wait', 'cancel'], description: '状态（可选）' },
            note: { type: 'string', description: '补充说明（可选）' },
            project: { type: 'string', description: '归属项目（可选）' },
          },
          required: ['id'],
        },
        async handler(args: { id?: string; done?: boolean; due?: string; prio?: number; status?: string; note?: string; project?: string }) {
          if (!cached) return { ok: false, error: '桥未连接' };
          if (!args.id) return { ok: false, error: '缺少 id' };
          let updated: BridgeTask | undefined;
          withBridge(d => {
            const t = d.tasks.find(x => x.id === args.id);
            if (!t) return false;
            updated = t;
            if (typeof args.done === 'boolean' && args.done !== t.done) {
              t.done = args.done;
              t.doneAt = args.done ? now() : null;
              t.updatedAt = now();
              // 重复任务完成 → 生成下一个实例
              if (args.done) {
                const next = spawnRepeat({ ...t });
                if (next && d.tasks.length < MAX_TASKS) d.tasks.unshift(next);
              }
            }
            if (args.due != null && /^\d{4}-\d{2}-\d{2}$/.test(String(args.due))) t.due = String(args.due);
            if ([1, 2, 3, 4].includes(Number(args.prio))) t.prio = Number(args.prio);
            if (['todo', 'doing', 'wait', 'cancel'].includes(args.status ?? '')) t.status = args.status!;
            if (typeof args.note === 'string') t.note = args.note.trim().slice(0, 2000);
            if (args.project != null) t.pid = resolveProject(args.project, d);
            t.updatedAt = now();
            return true;
          });
          if (!updated) return { ok: false, error: `任务不存在: ${args.id}` };
          notify('agent-update');
          return { ok: true, data: { id: updated.id, title: updated.title, done: updated.done, due: updated.due, prio: updated.prio, status: updated.status } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'workbench_add_note',
        risk: 'low',
        costHint: 'low',
        output: '{id, text}',
        description: '向办公工作台「灵感」添加一条笔记（一句话/想法/摘录，可带标签）。与任务和日记分开存储。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '笔记内容（≤1200字）' },
            tags: { type: 'array', items: { type: 'string' }, description: '标签列表（可选，最多12个）' },
          },
          required: ['text'],
        },
        async handler(args: Record<string, unknown>) {
          if (!cached) return { ok: false, error: '桥未连接' };
          const text = String(args.text ?? '').trim();
          if (!text) return { ok: false, error: '缺少 text' };
          if (cached.notes.length >= MAX_NOTES) return { ok: false, error: `灵感已达上限（${MAX_NOTES}）` };
          const tags = Array.isArray(args.tags) ? (args.tags as unknown[]).map(x => String(x).trim()).filter(Boolean).slice(0, 12) : [];
          let note: BridgeNote | null = null;
          withBridge(d => {
            note = ensureNoteFields({ id: newId(), text, tags, createdAt: now(), updatedAt: now() });
            d.notes.unshift(note);
            return true;
          });
          notify('agent-note');
          return { ok: true, data: { id: note!.id, text: note!.text } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'workbench_diary',
        risk: 'low',
        costHint: 'low',
        output: '{date, text}',
        description: '记录今日一笔（一句话日记，每天只能记一句；重复调用覆盖）。如「今天下午图书馆效率很高」。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '一句话感想（≤200字）' },
            date: { type: 'string', description: '日期 YYYY-MM-DD（默认今天）' },
          },
          required: ['text'],
        },
        async handler(args: Record<string, unknown>) {
          if (!cached) return { ok: false, error: '桥未连接' };
          const text = String(args.text ?? '').trim().slice(0, 200);
          if (!text) return { ok: false, error: '缺少 text' };
          const date = /^\d{4}-\d{2}-\d{2}$/.test(String(args.date || '')) ? String(args.date) : todayStr();
          withBridge(d => {
            d.diary = d.diary ?? {};
            d.diaryTs = d.diaryTs ?? {};
            d.diary[date] = text;
            d.diaryTs[date] = now();
            return true;
          });
          notify('agent-diary');
          return { ok: true, data: { date, text } };
        },
      },
    });

    // ---- REST API ----
    ctx.register({
      kind: 'api',
      api: {
        mount: 'wb',
        router: ((req: { method?: string; path?: string }, res: any) => {
          try {
            const raw = (req.path ?? '/').replace(/\/+$/, '') || '/';
            let p = raw;
            if (p === '/wb') p = '/';
            else if (p.startsWith('/wb/')) p = p.slice('/wb'.length);

            // ---- 联动状态 ----
            if (req.method === 'GET' && p === '/bridge') {
              res.json(bridgeStatus());
              return;
            }

            // ---- 页头状态（nav.status 契约）：前端顶栏通用轮询 + 展示 text ----
            // 这是「插件把状态显示在自己标签页的页头」的标准通道：通用字段 text，
            // 附加字段供更强的前端展示（connected 决定状态点颜色、stats 是详情文本）。
            if (req.method === 'GET' && p === '/status') {
              const info = bridgeStatus() as unknown as {
                connected?: boolean; records?: { tasks?: number; notes?: number; projects?: number };
                lastExternalAt?: number; mtimeMs?: number; dir?: string;
              };
              const rec = info.records ?? {};
              const total = (rec.tasks ?? 0) + (rec.notes ?? 0) + (rec.projects ?? 0);
              const syncAt = info.lastExternalAt ?? info.mtimeMs ?? 0;
              const mins = syncAt ? Math.max(0, Math.floor((Date.now() - syncAt) / 60000)) : 0;
              const ago = !syncAt ? '—' : mins < 1 ? '刚刚' : mins < 60 ? `${mins} 分钟前` : `${Math.floor(mins / 60)} 小时前`;
              res.json({
                connected: !!info.connected,
                text: info.connected ? '桥已连接' : '桥未连接',
                detail: total > 0
                  ? `${rec.tasks ?? 0} 任务 / ${rec.notes ?? 0} 灵感 / ${rec.projects ?? 0} 项目 · 最后同步：${ago}`
                  : `暂无记录${syncAt ? ` · 最后同步：${ago}` : ''}`,
                dir: info.dir ?? '',
              });
              return;
            }

            // ---- HTML 应用（嵌入主入口） ----
            if (req.method === 'GET' && (p === '/app' || p === '/app/')) {
              try {
                const html = readFileSync(appHtmlPath, 'utf8');
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.setHeader('Cache-Control', 'no-cache');
                res.send(html);
              } catch {
                res.status(404).send('应用文件未找到（app.html）');
              }
              return;
            }

            // ---- 插件面板（迷你概览） ----
            if (req.method === 'GET' && p === '/panel') {
              const d = cached ?? readBridge();
              const today = todayStr();
              const todays = (d?.tasks ?? []).filter((t: BridgeTask) => t.due === today);
              const done = todays.filter((t: BridgeTask) => t.done).length;
              const overdue = (d?.tasks ?? []).filter((t: BridgeTask) => !t.done && t.due && t.due < today).length;
              const projs = (d?.projects ?? []).filter((p: BridgeProject) => p.status === 'done').length;
              const notesCount = d?.notes?.length ?? 0;
              const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
              const rows = todays.filter((t: BridgeTask) => !t.done)
                .sort((a: BridgeTask, b: BridgeTask) => (a.prio - b.prio))
                .slice(0, 6)
                .map((t: BridgeTask) => {
                  const proj = d?.projects?.find((p: BridgeProject) => p.id === t.pid);
                  const prioStr = t.prio === 1 ? '🔴' : t.prio === 2 ? '🟡' : t.prio === 3 ? '🟢' : '⚪';
                  return `<div style="padding:3px 0">${prioStr} <span style="color:var(--text-2)">${esc(t.title)}</span>${proj ? ` <span style="color:var(--text-4);font-size:11px">· ${esc(proj.name)}</span>` : ''}</div>`;
                }).join('');
              const completed = todays.filter((t: BridgeTask) => t.done).slice(0, 4)
                .map((t: BridgeTask) => `<div style="padding:2px 0;text-decoration:line-through;color:var(--text-4)">${esc(t.title)}</div>`).join('');

              res.json({
                title: '办公工作台',
                html: `<div style="font-family:var(--font-sans);color:var(--text-1)">
                  <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
                    <b style="font-size:15px">办公工作台</b>
                    <span style="font-size:12px;color:var(--text-3)">${done}/${todays.length} 今日完成${overdue ? ' · 过期 ' + overdue : ''}</span>
                    <span style="flex:1"></span>
                    <span style="font-size:11px;color:var(--text-4)">${notesCount} 条灵感 · ${d?.projects?.length ?? 0} 个项目${projs ? ` · 已完成 ${projs}` : ''}</span>
                  </div>
                  ${rows ? `<div style="margin-bottom:10px"><div style="font-size:11px;color:var(--text-3);margin-bottom:4px">今日待办</div>${rows}</div>` : '<div style="color:var(--text-4);margin-bottom:10px">今天暂无安排</div>'}
                  ${completed ? `<div style="margin-bottom:10px"><div style="font-size:11px;color:var(--text-3);margin-bottom:4px">已完成</div>${completed}</div>` : ''}
                  <div style="margin-top:8px;font-size:11px;color:var(--text-4)">主页面「工作台」Tab 可完整使用（嵌入版）</div>
                </div>`,
              });
              return;
            }

            // ---- 向后兼容：旧 /state → 从桥数据派生（插件面板备用） ----
            if (req.method === 'GET' && p === '/state') {
              const d = cached ?? readBridge();
              const today = todayStr();
              const tasks = (d?.tasks ?? []).map((t: BridgeTask) => ({
                id: t.id, title: t.title, notes: t.note, date: t.due,
                done: t.done, projectId: t.pid, repeat: t.repeat || undefined,
                createdAt: t.createdAt, updatedAt: t.updatedAt,
              }));
              const projects = (d?.projects ?? []).map((p: BridgeProject) => {
                return { id: p.id, name: p.name, desc: p.stage, color: '#d0856b',
                         status: p.status, deadline: undefined, order: 0,
                         createdAt: p.updatedAt, updatedAt: p.updatedAt };
              });
              res.json({ today, tasks, projects });
              return;
            }

            res.status(404).json({ error: '未知端点' });
          } catch (err) {
            console.error('[workbench] API 异常:', err instanceof Error ? err.message : String(err));
            res.status(500).json({ error: '工作台内部错误' });
          }
        }),
      },
    });

    ctx.logger.info('办公工作台 v2 就绪：嵌入全量应用 + 文件桥联动（GET /wb/app + Agent 工具 5 个）');
  },

  onStop(_ctx) { /* watcher 由 onUnload 清理 */ },
  onUnload(_ctx) { /* 清理由 plugin-loader 回收时执行 */ },
} satisfies Plugin;
