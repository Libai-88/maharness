/**
 * plugins/workbench/index.ts —— 办公工作台插件（日常生活管理规划 + 项目进度管理）
 * 设计原则（贴合大众习惯 / 普适 / 低上手）：
 *  - 心智模型只有两个：「今天要做的事」与「我手头的项目」——不看教程就会用；
 *  - 日程 = 日期 + 可选时刻（24h 制），按时间排序；过期未完成一键顺延到今天；
 *  - 重复任务三档（每天 / 工作日 / 每周），完成即生成下一次实例（滴答清单式）；
 *  - 项目进度 = 项目下任务完成比，勾任务进度条自己涨，无需手动维护百分比；
 *  - 与 core/todo 分工：todo 是「模型执行清单」（会话内多步任务），workbench 是
 *    「用户的日常与项目」（跨会话长期数据）——两份事实，互不混用。
 * 完全插件化：数据落 data/workbench.json（独立文件），卸载/停用即从能力注册表
 * 完全回收（api 路由 404、工具/persona 消失），对内核与既有功能零侵入。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Plugin, ToolContext } from '../../kernel/types';

// ============ 数据模型 ============

export type WbRepeat = 'daily' | 'weekdays' | 'weekly';
export type WbProjectStatus = 'active' | 'paused' | 'done';

export interface WbTask {
  id: string;                  // wb-xxxxxxxx
  title: string;
  notes?: string;
  date: string;                // 'YYYY-MM-DD'（必填；收件箱任务在添加时自动落到今天）
  time?: string;               // 'HH:MM'（可选，24 小时制）
  done: boolean;
  doneAt?: number;
  projectId?: string;          // 归属项目（可选）
  repeat?: WbRepeat;           // 重复：完成即生成下一次实例
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface WbProject {
  id: string;                  // pj-xxxxxxxx
  name: string;
  desc?: string;
  color: string;               // 主题色（调色板内）
  status: WbProjectStatus;     // active 进行中 / paused 已搁置 / done 已完成
  deadline?: string;           // 'YYYY-MM-DD'（可选）
  order: number;
  createdAt: number;
  updatedAt: number;
}

interface WbData {
  version: 1;
  tasks: WbTask[];
  projects: WbProject[];
}

const MAX_TASKS = 1000;
const MAX_PROJECTS = 100;
const REPEATS: WbRepeat[] = ['daily', 'weekdays', 'weekly'];
const PROJECT_STATUS: WbProjectStatus[] = ['active', 'paused', 'done'];
/** 项目色板：与 UI 设计系统「暖炭手作」同源（陶土/松绿/琥珀/赭橙/砖红/暖灰） */
export const WB_COLORS = ['#d0856b', '#82a873', '#d9a441', '#e0913f', '#d96856', '#a89673'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ============ 日期工具（本地时区，YYYY-MM-DD 字符串可直接字典序比较） ============

function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}
function fmtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function todayStr(): string { return fmtDate(new Date()); }
function isDateStr(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(parseDate(s).getTime());
}
/** 重复任务的下一次日期：从 max(基准日, 今天) 的下一天起找首个匹配日 */
function nextOccurrence(date: string, repeat: WbRepeat): string {
  const base = parseDate(date);
  let d = base > parseDate(todayStr()) ? base : parseDate(todayStr());
  for (let i = 0; i < 400; i++) {
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    const dow = d.getDay();
    if (repeat === 'daily') return fmtDate(d);
    if (repeat === 'weekdays' && dow >= 1 && dow <= 5) return fmtDate(d);
    if (repeat === 'weekly' && dow === base.getDay()) return fmtDate(d);
  }
  return fmtDate(d);
}

export default {
  id: 'workbench',
  name: '办公工作台',
  version: '0.1.0',
  onLoad(ctx) {
    // 数据目录跟随 Kernel 的 dataDir 覆盖（AGENT_DATA_DIR/测试隔离），不写死源码树 data/
    const dataFile = join(ctx.paths.data, 'workbench.json');
    // ---- 数据源：内存 + 落盘（data/workbench.json，跨重启保留） ----
    let data: WbData = { version: 1, tasks: [], projects: [] };
    try {
      if (existsSync(dataFile)) {
        const raw = JSON.parse(readFileSync(dataFile, 'utf8')) as Partial<WbData>;
        data = {
          version: 1,
          tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
          projects: Array.isArray(raw.projects) ? raw.projects : [],
        };
        if (data.tasks.length || data.projects.length) {
          console.log(`[workbench] 已从磁盘恢复 ${data.tasks.length} 条任务 / ${data.projects.length} 个项目`);
        }
      }
    } catch (err) {
      console.warn('[workbench] 加载失败（从空开始）:', err instanceof Error ? err.message : String(err));
    }
    const save = () => {
      try {
        mkdirSync(dirname(dataFile), { recursive: true });
        // 原子写：先临时文件再 rename——崩溃/断电/磁盘错误不留下截断 JSON
        //（旧实现直接覆盖，损坏后下次启动从空开始、后续保存会覆盖原数据）
        const tmp = `${dataFile}.tmp`;
        writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
        renameSync(tmp, dataFile);
      } catch (err) {
        console.warn('[workbench] 持久化失败（不影响运行）:', err instanceof Error ? err.message : String(err));
      }
    };
    const notify = (reason: string) => {
      ctx.bus.emit({ type: 'workbench.updated', data: { reason, ts: Date.now() }, ts: Date.now() });
    };
    const newId = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;
    const maxTaskOrder = () => data.tasks.reduce((m, t) => Math.max(m, t.order ?? 0), -1);
    const maxProjectOrder = () => data.projects.reduce((m, p) => Math.max(m, p.order ?? 0), -1);

    // ---- 校验/规整助手 ----
    const cleanTitle = (v: unknown, max = 200) => String(v ?? '').trim().slice(0, max);
    const cleanTime = (v: unknown): string | undefined => {
      const s = String(v ?? '').trim();
      return TIME_RE.test(s) ? s : undefined;
    };
    const cleanDate = (v: unknown, fallback: string): string => (isDateStr(v) ? v : fallback);
    const cleanRepeat = (v: unknown): WbRepeat | undefined =>
      REPEATS.includes(v as WbRepeat) ? (v as WbRepeat) : undefined;
    const cleanColor = (v: unknown): string =>
      typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : WB_COLORS[0];
    /** 项目引用规整：接受项目 id 或精确名称（LLM 与人类都好记） */
    const resolveProject = (v: unknown): string | undefined => {
      const s = String(v ?? '').trim();
      if (!s) return undefined;
      const hit = data.projects.find((p) => p.id === s || p.name === s);
      return hit?.id;
    };
    /** 完成任务：重复任务完成即生成下一次实例（保留标题/时刻/项目/重复） */
    const completeTask = (t: WbTask, done: boolean) => {
      t.done = done;
      t.doneAt = done ? Date.now() : undefined;
      t.updatedAt = Date.now();
      if (done && t.repeat && t.date && data.tasks.length < MAX_TASKS) {
        data.tasks.push({
          ...t,
          id: newId('wb'),
          date: nextOccurrence(t.date, t.repeat),
          done: false,
          doneAt: undefined,
          order: maxTaskOrder() + 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    };
    const snapshot = () => ({ today: todayStr(), tasks: data.tasks, projects: data.projects });
    /** 项目进度（完成比）：done/total，无任务为 0 */
    const projectProgress = (p: WbProject) => {
      const list = data.tasks.filter((t) => t.projectId === p.id);
      const done = list.filter((t) => t.done).length;
      return { total: list.length, done, pct: list.length ? Math.round((done / list.length) * 100) : 0 };
    };

    // ---- L2 人设：引导 LLM 在合适时机读写工作台（随插件启停自动增减） ----
    ctx.register({
      kind: 'persona',
      persona: {
        id: 'workbench-rules',
        name: '办公工作台使用规则',
        description: '用户提到日程安排、今天要做的事、项目进度时，读写办公工作台数据',
        priority: 4,
        content: [
          '办公工作台使用规则：',
          '1. 用户问日程/安排/今天做什么/项目进度时，先调 workbench_today 看真实数据再回答；',
          '2. 用户让你记日程或待办（如「明天下午3点开会」）→ workbench_add_task（date=YYYY-MM-DD，time=HH:MM 24小时制，默认今天）；',
          '3. 用户说某件事做完/改期 → workbench_update_task（id 来自 workbench_today）；',
          '4. 工作台是用户本人的日常安排与项目，与 todo（你的执行清单）是两套数据，不要混写。',
        ].join('\n'),
      },
    });

    // ---- Agent 工具（低风险：仅插件自身数据文件，不触文件系统/网络） ----
    ctx.register({
      kind: 'tool',
      tool: {
        name: 'workbench_today',
        risk: 'low',
        costHint: 'low',
        output: '{today, schedule: [{id, time?, title, project?}], overdue: n, projects: [{id, name, pct, done, total, deadline?}]}',
        description: '查看办公工作台今日概览：今天的日程任务（按时刻排序）、过期未完成数、各项目进度。用户问日程/安排/进度时先调用。',
        parameters: { type: 'object', properties: {} },
        async handler() {
          const today = todayStr();
          const nameOf = (id?: string) => data.projects.find((p) => p.id === id)?.name;
          const todays = data.tasks
            .filter((t) => t.date === today)
            .sort((a, b) => (a.time ?? '99:99').localeCompare(b.time ?? '99:99') || a.createdAt - b.createdAt);
          const overdue = data.tasks.filter((t) => !t.done && t.date && t.date < today).length;
          return {
            ok: true,
            data: {
              today,
              schedule: todays.map((t) => ({ id: t.id, time: t.time, title: t.title, done: t.done, project: nameOf(t.projectId), repeat: t.repeat })),
              overdue,
              projects: data.projects.filter((p) => p.status === 'active').map((p) => ({
                id: p.id, name: p.name, deadline: p.deadline, ...projectProgress(p),
              })),
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
        output: '{id, title, date, time?}',
        description: '向办公工作台添加一条日程/待办（如「明天下午3点开会」→ date=明天, time=15:00）。不传 date 默认今天。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '事项标题（一句话）' },
            date: { type: 'string', description: '日期 YYYY-MM-DD（默认今天）' },
            time: { type: 'string', description: '时刻 HH:MM（24 小时制，可选）' },
            project: { type: 'string', description: '所属项目（id 或精确名称，可选）' },
            repeat: { type: 'string', enum: ['daily', 'weekdays', 'weekly'], description: '重复：每天/工作日/每周（可选）' },
            notes: { type: 'string', description: '补充说明（可选）' },
          },
          required: ['title'],
        },
        async handler(args: Record<string, unknown>, tctx: ToolContext) {
          const title = cleanTitle(args.title);
          if (!title) return { ok: false, error: '缺少 title' };
          if (data.tasks.length >= MAX_TASKS) return { ok: false, error: `任务已达上限（${MAX_TASKS}），请先清理已完成项` };
          const time = cleanTime(args.time);
          if (args.time != null && String(args.time).trim() && !time) return { ok: false, error: 'time 格式应为 HH:MM（24 小时制）' };
          const task: WbTask = {
            id: newId('wb'),
            title,
            notes: args.notes ? String(args.notes).slice(0, 500) : undefined,
            date: cleanDate(args.date, todayStr()),
            time,
            done: false,
            projectId: resolveProject(args.project),
            repeat: cleanRepeat(args.repeat),
            order: maxTaskOrder() + 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          data.tasks.push(task);
          save();
          notify(`agent-add:${tctx.sessionId ?? ''}`);
          return { ok: true, data: { id: task.id, title: task.title, date: task.date, time: task.time } };
        },
      },
    });

    ctx.register({
      kind: 'tool',
      tool: {
        name: 'workbench_update_task',
        risk: 'low',
        costHint: 'low',
        output: '{id, title, done, date, time?}',
        description: '更新办公工作台的一条任务：完成/取消完成、改期、改时刻。id 来自 workbench_today。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '任务 id（workbench_today 返回）' },
            done: { type: 'boolean', description: '是否完成（重复任务完成会自动生成下一次）' },
            date: { type: 'string', description: '改期到 YYYY-MM-DD（可选）' },
            time: { type: 'string', description: '时刻 HH:MM（可选）' },
            notes: { type: 'string', description: '补充说明（可选）' },
          },
          required: ['id'],
        },
        async handler(args: { id?: string; done?: boolean; date?: string; time?: string; notes?: string }) {
          const task = data.tasks.find((t) => t.id === args.id);
          if (!task) return { ok: false, error: `任务不存在: ${args.id}（workbench_today 查看当前清单）` };
          if (typeof args.done === 'boolean' && args.done !== task.done) completeTask(task, args.done);
          if (args.date != null) task.date = cleanDate(args.date, task.date);
          if (args.time != null) {
            const time = cleanTime(args.time);
            if (String(args.time).trim() && !time) return { ok: false, error: 'time 格式应为 HH:MM' };
            task.time = time;
          }
          if (typeof args.notes === 'string') task.notes = args.notes.slice(0, 500) || undefined;
          task.updatedAt = Date.now();
          save();
          notify('agent-update');
          return { ok: true, data: { id: task.id, title: task.title, done: task.done, date: task.date, time: task.time } };
        },
      },
    });

    // ---- REST API（挂载 /api/plugins/workbench/wb/...；同步实现，杜绝 async 路由异常逃逸） ----
    ctx.register({
      kind: 'api',
      api: {
        mount: 'wb',
        router: ((req: { method?: string; path?: string; body?: unknown }, res: {
          json: (v: unknown) => void; status: (n: number) => { json: (v: unknown) => void };
        }) => {
          try {
            // 挂载前缀剥离：请求 /api/plugins/workbench/wb/state → req.path=/wb/state → p=/state
            const raw = (req.path ?? '/').replace(/\/+$/, '') || '/';
            let p = raw;
            if (p === '/wb') p = '/';
            else if (p.startsWith('/wb/')) p = p.slice('/wb'.length);
            const body = (req.body ?? {}) as Record<string, unknown>;
            const ok = (extra: Record<string, unknown> = {}) => res.json({ ok: true, state: snapshot(), ...extra });

            if (p === '/' || p === '/panel') {
              res.json({ title: '办公工作台', html: panelHtml() });
              return;
            }
            // 全量状态：数据集小（千级以内），一次取回由前端派生视图
            if (req.method === 'GET' && p === '/state') {
              res.json(snapshot());
              return;
            }
            // 一键顺延：过期未完成 → 今天（大众习惯「今天重新开始」）
            if (req.method === 'POST' && p === '/rollover') {
              const today = todayStr();
              let moved = 0;
              for (const t of data.tasks) {
                if (!t.done && t.date && t.date < today) { t.date = today; t.updatedAt = Date.now(); moved++; }
              }
              if (moved) { save(); notify('rollover'); }
              ok({ moved });
              return;
            }

            // ---- 任务 ----
            if (p === '/tasks' && req.method === 'POST') {
              const title = cleanTitle(body.title);
              if (!title) return res.status(400).json({ error: '缺少 title' });
              if (data.tasks.length >= MAX_TASKS) return res.status(400).json({ error: '任务已达上限' });
              const time = cleanTime(body.time);
              if (body.time != null && String(body.time).trim() && !time) return res.status(400).json({ error: 'time 格式应为 HH:MM' });
              const task: WbTask = {
                id: newId('wb'),
                title,
                notes: body.notes ? String(body.notes).slice(0, 500) : undefined,
                date: cleanDate(body.date, todayStr()),
                time,
                done: false,
                projectId: resolveProject(body.projectId ?? body.project),
                repeat: cleanRepeat(body.repeat),
                order: maxTaskOrder() + 1,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              };
              data.tasks.push(task);
              save();
              notify('human-add');
              ok({ task });
              return;
            }
            const tm = p.match(/^\/tasks\/([^/]+)$/);
            if (tm) {
              const task = data.tasks.find((t) => t.id === tm[1]);
              if (!task) return res.status(404).json({ error: '任务不存在' });
              if (req.method === 'PATCH') {
                if (typeof body.title === 'string' && body.title.trim()) task.title = body.title.trim().slice(0, 200);
                if (typeof body.done === 'boolean' && body.done !== task.done) completeTask(task, body.done);
                if (body.date != null) task.date = cleanDate(body.date, task.date);
                if (body.time !== undefined) {
                  const time = cleanTime(body.time);
                  if (String(body.time).trim() && !time) return res.status(400).json({ error: 'time 格式应为 HH:MM' });
                  task.time = time;
                }
                if (typeof body.notes === 'string') task.notes = body.notes.slice(0, 500) || undefined;
                if (body.projectId !== undefined) task.projectId = resolveProject(body.projectId);
                if (body.repeat !== undefined) task.repeat = cleanRepeat(body.repeat);
                task.updatedAt = Date.now();
                save();
                notify('human-update');
                ok({ task });
                return;
              }
              if (req.method === 'DELETE') {
                data.tasks = data.tasks.filter((t) => t.id !== tm[1]);
                save();
                notify('human-delete');
                ok();
                return;
              }
            }
            // 清除某天的已完成（今日收尾）
            if (req.method === 'POST' && p === '/tasks/clear-done') {
              const date = cleanDate(body.date, todayStr());
              data.tasks = data.tasks.filter((t) => !(t.done && t.date === date));
              save();
              notify('human-clear-done');
              ok();
              return;
            }

            // ---- 项目 ----
            if (p === '/projects' && req.method === 'POST') {
              const name = cleanTitle(body.name, 100);
              if (!name) return res.status(400).json({ error: '缺少 name' });
              if (data.projects.length >= MAX_PROJECTS) return res.status(400).json({ error: '项目已达上限' });
              const project: WbProject = {
                id: newId('pj'),
                name,
                desc: body.desc ? String(body.desc).slice(0, 500) : undefined,
                color: cleanColor(body.color),
                status: (PROJECT_STATUS.includes(body.status as WbProjectStatus) ? body.status : 'active') as WbProjectStatus,
                deadline: isDateStr(body.deadline) ? body.deadline : undefined,
                order: maxProjectOrder() + 1,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              };
              data.projects.push(project);
              save();
              notify('project-add');
              ok({ project });
              return;
            }
            const pm = p.match(/^\/projects\/([^/]+)$/);
            if (pm) {
              const project = data.projects.find((x) => x.id === pm[1]);
              if (!project) return res.status(404).json({ error: '项目不存在' });
              if (req.method === 'PATCH') {
                if (typeof body.name === 'string' && body.name.trim()) project.name = body.name.trim().slice(0, 100);
                if (typeof body.desc === 'string') project.desc = body.desc.slice(0, 500) || undefined;
                if (body.color != null) project.color = cleanColor(body.color);
                if (body.status && PROJECT_STATUS.includes(body.status as WbProjectStatus)) project.status = body.status as WbProjectStatus;
                if (body.deadline !== undefined) project.deadline = isDateStr(body.deadline) ? body.deadline : undefined;
                project.updatedAt = Date.now();
                save();
                notify('project-update');
                ok({ project });
                return;
              }
              if (req.method === 'DELETE') {
                // 项目删除但其任务保留（去归属），不静默销毁数据
                data.projects = data.projects.filter((x) => x.id !== pm[1]);
                for (const t of data.tasks) {
                  if (t.projectId === pm[1]) { t.projectId = undefined; t.updatedAt = Date.now(); }
                }
                save();
                notify('project-delete');
                ok();
                return;
              }
            }

            res.status(404).json({ error: '未知端点' });
          } catch (err) {
            console.error('[workbench] API 异常:', err instanceof Error ? err.message : String(err));
            res.status(500).json({ error: '工作台内部错误' });
          }
        }) as never,
      },
    });

    ctx.logger.info('办公工作台就绪：今日日程 + 项目进度（REST /api/plugins/workbench/wb/state + 工具 workbench_today/add_task/update_task）');
  },
} satisfies Plugin;

/** 插件面板 HTML（插件详情页渲染）：工作台速览——今日完成度、过期提醒、项目进度条 */
function panelHtml(): string {
  return `<!doctype html>
<div id="wb-panel" style="font-family:system-ui,-apple-system,sans-serif;color:#d8dae5">
  <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
    <b style="font-size:15px">办公工作台</b>
    <span id="wb-summary" style="font-size:12px;color:#8b8fa3"></span>
    <span style="flex:1"></span>
    <span style="font-size:11px;color:#8b8fa3">主页面「工作台」Tab 可完整使用</span>
  </div>
  <div id="wb-body" style="font-size:12px;color:#aab0c5"></div>
</div>
<script>
const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function fmtDate(d) { const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()); }
async function load() {
  try {
    const s = await (await fetch('/api/plugins/workbench/wb/state')).json();
    const today = s.today || fmtDate(new Date());
    const todays = s.tasks.filter(t => t.date === today);
    const done = todays.filter(t => t.done).length;
    const overdue = s.tasks.filter(t => !t.done && t.date && t.date < today).length;
    document.getElementById('wb-summary').textContent = done + '/' + todays.length + ' 今日完成' + (overdue ? ' · 过期 ' + overdue : '');
    const body = document.getElementById('wb-body');
    const rows = todays.filter(t => !t.done).sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99')).slice(0, 6)
      .map(t => '<div style="padding:3px 0">' + (t.time ? '<span style="color:#d9a441;margin-right:6px">' + t.time + '</span>' : '') + esc(t.title) + '</div>').join('');
    const projs = s.projects.filter(p => p.status === 'active').slice(0, 5).map(p => {
      const list = s.tasks.filter(t => t.projectId === p.id);
      const d = list.filter(t => t.done).length;
      const pct = list.length ? Math.round(d / list.length * 100) : 0;
      return '<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;margin-bottom:3px"><span>' + esc(p.name) + '</span><span style="color:#8b8fa3">' + d + '/' + list.length + '</span></div>' +
        '<div style="height:5px;background:#232a40;border-radius:99px"><div style="height:5px;width:' + pct + '%;background:' + esc(p.color) + ';border-radius:99px"></div></div></div>';
    }).join('');
    body.innerHTML =
      (rows ? '<div style="margin-bottom:12px"><div style="font-size:11px;color:#8b8fa3;margin-bottom:4px">接下来</div>' + rows + '</div>' : '<div style="color:#5a6080;margin-bottom:12px">今天暂无安排</div>') +
      (projs ? '<div><div style="font-size:11px;color:#8b8fa3;margin-bottom:6px">项目进度</div>' + projs + '</div>' : '');
  } catch (e) { document.getElementById('wb-body').textContent = '工作台未启用或加载失败'; }
}
load(); setInterval(load, 8000);
</script>`;
}
