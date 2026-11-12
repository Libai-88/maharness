export interface RecordBase { id: string; updatedAt: number; _s?: boolean; [key: string]: unknown }
export interface Task extends RecordBase {
  title: string; prio: number; due: string; start: string; done: boolean; pid: string;
  createdAt: number; doneAt: number | null; rolls: number; repeat: string; pomo: number;
  subs: { t: string; d: boolean }[]; tags: string[]; link: string; note: string; status: string; est: number;
}
export interface Note extends RecordBase { text: string; tags: string[]; createdAt: number }
export interface Project extends RecordBase { name: string; stage: string; next: string; blocker: string; status: string }
export type Kind = 'task' | 'note' | 'proj';
export interface BinEntry { id: string; kind: Kind; rec: Task | Note | Project; idx: number; pids?: string[]; at: number }
export interface WorkbenchState {
  v: number; tasks: Task[]; notes: Note[]; projects: Project[]; diary: Record<string, string>;
  diaryTs: Record<string, number>; tomb: Record<string, number>; bin: BinEntry[];
  meta: { sample: boolean; itemsAtExport: number; lastExport: number | null; lastOpen: string; created: number; pomoLog: Record<string, number>; lastChange?: number; autoBackup?: string; [key: string]: unknown };
  [key: string]: unknown;
}
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
export const day = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export function shift(date: string, count: number) { const d = new Date(date + 'T00:00:00'); d.setDate(d.getDate() + count); return day(d); }
export const live = (task: Task) => !task.done && task.status !== 'cancel';
export const todayTask = (task: Task, today = day()) => (live(task) && (!task.due || task.due <= today || (!!task.start && task.start <= today))) || (task.done && !!task.doneAt && day(new Date(task.doneAt)) === today);
export function blank(): WorkbenchState {
  return { v: 1, tasks: [], notes: [], projects: [], diary: {}, diaryTs: {}, tomb: {}, bin: [], meta: { sample: false, itemsAtExport: 0, lastExport: null, lastOpen: day(), created: Date.now(), pomoLog: {} } };
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => String(value ?? '').trim();
const dateValue = (value: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(text(value)) ? text(value) : '';
const tagsValue = (value: unknown) => Array.isArray(value) ? value.map(text).filter(Boolean).slice(0, 12) : [];
const records = (value: unknown) => Array.isArray(value) ? value.filter(x => x && typeof x === 'object' && !Array.isArray(x)).map(object) : [];
export function taskDefaults(patch: Partial<Task> = {}): Task {
  const now = Date.now();
  return { id: uid(), title: '', prio: 3, due: '', start: '', done: false, pid: '', createdAt: now, updatedAt: now, doneAt: null, rolls: 0, repeat: '', pomo: 0, subs: [], tags: [], link: '', note: '', status: 'todo', est: 0, ...patch };
}
export function normalize(input: unknown): WorkbenchState {
  const d = object(input), base = blank(), now = Date.now();
  const result = { ...base, ...d, meta: { ...base.meta, ...object(d.meta), pomoLog: { ...object(object(d.meta).pomoLog) } } } as WorkbenchState;
  result.projects = records(d.projects).map(p => ({ ...p, id: text(p.id) || uid(), name: text(p.name), stage: text(p.stage), next: text(p.next), blocker: text(p.blocker), status: ['active', 'blocked', 'done'].includes(text(p.status)) ? text(p.status) : 'active', updatedAt: Number(p.updatedAt) || now })) as Project[];
  const projectIds = new Set(result.projects.map(p => p.id));
  result.tasks = records(d.tasks).map(k => {
    const task = taskDefaults({ ...k, id: text(k.id) || uid(), title: text(k.title), prio: [1, 2, 3, 4].includes(Number(k.prio)) ? Number(k.prio) : 3, done: !!k.done, due: dateValue(k.due), start: dateValue(k.start), pid: projectIds.has(text(k.pid)) ? text(k.pid) : '', createdAt: Number(k.createdAt) || now, updatedAt: Number(k.updatedAt) || Number(k.doneAt) || Number(k.createdAt) || now, doneAt: Number(k.doneAt) || null, rolls: Number(k.rolls) || 0, repeat: text(k.repeat), pomo: Number(k.pomo) || 0, tags: tagsValue(k.tags), link: text(k.link).slice(0, 2048), note: text(k.note).slice(0, 2000), status: ['todo', 'doing', 'wait', 'cancel'].includes(text(k.status)) ? text(k.status) : 'todo', est: Math.max(0, Math.min(20, Math.round(Number(k.est) || 0))), subs: records(k.subs).map(s => ({ ...s, t: text(s.t), d: !!s.d })) });
    delete task._open; return task;
  }).filter(k => k.title);
  result.notes = records(d.notes).map(n => ({ ...n, id: text(n.id) || uid(), text: text(n.text).slice(0, 1200), tags: tagsValue(n.tags), createdAt: Number(n.createdAt) || now, updatedAt: Number(n.updatedAt) || Number(n.createdAt) || now })).filter(n => n.text) as Note[];
  result.diary = Object.fromEntries(Object.entries(object(d.diary)).map(([key, value]) => [key, String(value ?? '')]));
  result.diaryTs = Object.fromEntries(Object.entries(object(d.diaryTs)).map(([key, value]) => [key, Number(value) || 0]));
  result.tomb = Object.fromEntries(Object.entries(object(d.tomb)).filter(([, value]) => Number(value) > now - 90 * 864e5).map(([key, value]) => [key, Number(value)]));
  result.bin = records(d.bin).filter(e => e.rec && ['task', 'note', 'proj'].includes(text(e.kind)) && Number(e.at) > now - 30 * 864e5).sort((a, b) => Number(b.at) - Number(a.at)).slice(0, 200) as unknown as BinEntry[];
  return result;
}

type Mergeable = { id: string; updatedAt: number; _s?: unknown };
interface MergeInput<A extends Mergeable, B extends Mergeable, C extends Mergeable> { tasks?: A[]; notes?: B[]; projects?: C[]; tomb?: Record<string, number> }
function mergeList<T extends Mergeable>(local: T[], remote: T[], tomb: Record<string, number>) {
  const lReal = local.some(x => !x._s), rReal = remote.some(x => !x._s);
  const left = local.filter(x => !rReal || (lReal && !x._s));
  const right = remote.filter(x => !lReal || (rReal && !x._s));
  const map = new Map(left.map(x => [x.id, x]));
  for (const record of right) if (!map.has(record.id) || record.updatedAt > map.get(record.id)!.updatedAt) map.set(record.id, record);
  return [...map.values()].filter(record => {
    if (tomb[record.id] && tomb[record.id] >= (Number(record.updatedAt) || 0)) return false;
    delete tomb[record.id]; return true;
  });
}
export function mergeData<A extends Mergeable, B extends Mergeable, C extends Mergeable>(local: MergeInput<A, B, C>, remote: MergeInput<A, B, C>) {
  const tomb: Record<string, number> = {};
  for (const source of [local.tomb, remote.tomb]) for (const [id, at] of Object.entries(source || {})) {
    if (Number(at) > Date.now() - 90 * 864e5) tomb[id] = Math.max(tomb[id] || 0, Number(at));
  }
  return { tasks: mergeList(local.tasks || [], remote.tasks || [], tomb), notes: mergeList(local.notes || [], remote.notes || [], tomb), projects: mergeList(local.projects || [], remote.projects || [], tomb), tomb };
}
export function mergeDiary(localD: Record<string, string>, localTs: Record<string, number>, remoteD: Record<string, string>, remoteTs: Record<string, number>) {
  const diary: Record<string, string> = {}, diaryTs: Record<string, number> = {};
  for (const key of new Set([...Object.keys(localD || {}), ...Object.keys(remoteD || {})])) {
    const localWins = remoteD?.[key] === undefined || (localD?.[key] !== undefined && (Number(localTs?.[key]) || 0) >= (Number(remoteTs?.[key]) || 0));
    diary[key] = localWins ? localD[key] : remoteD[key]; diaryTs[key] = Number((localWins ? localTs : remoteTs)?.[key]) || 0;
  }
  return { diary, diaryTs };
}
export function mergeMeta(local: { meta?: Record<string, unknown> }, remote: { meta?: Record<string, unknown> }) {
  const lm = local.meta || {}, rm = remote.meta || {}, pomoLog: Record<string, number> = {};
  for (const source of [object(lm.pomoLog), object(rm.pomoLog)]) for (const [key, value] of Object.entries(source)) pomoLog[key] = Math.max(pomoLog[key] || 0, Number(value) || 0);
  return { ...rm, ...lm, pomoLog, sample: !!(lm.sample && rm.sample) };
}
export function mergeState(local: WorkbenchState, remote: WorkbenchState) {
  const bin = new Map<string, BinEntry>();
  for (const entry of [...remote.bin, ...local.bin]) if (!bin.has(entry.id) || bin.get(entry.id)!.at <= entry.at) bin.set(entry.id, entry);
  return normalize({ ...remote, ...local, ...mergeData(local, remote), ...mergeDiary(local.diary, local.diaryTs, remote.diary, remote.diaryTs), meta: mergeMeta(local, remote), bin: [...bin.values()] });
}
export function nextDue(date: string, repeat: string) {
  const base = date || day();
  if (repeat === 'daily') return shift(base, 1);
  if (repeat === 'weekly') return shift(base, 7);
  if (repeat === 'weekdays') { let next = shift(base, 1); while ([0, 6].includes(new Date(next + 'T00:00:00').getDay())) next = shift(next, 1); return next; }
  if (repeat === 'monthly') { const d = new Date(base + 'T00:00:00'), original = d.getDate(); d.setMonth(d.getMonth() + 1); if (d.getDate() !== original) d.setDate(0); return day(d); }
  return base;
}
export function toggleTask(state: WorkbenchState, id: string) {
  const task = state.tasks.find(x => x.id === id); if (!task) return;
  task.done = !task.done; task.doneAt = task.done ? Date.now() : null; task.updatedAt = Date.now();
  if (task.done && task.repeat) state.tasks.unshift(taskDefaults({ title: task.title, prio: task.prio, due: nextDue(task.due, task.repeat), start: task.start ? nextDue(task.start, task.repeat) : '', pid: task.pid, repeat: task.repeat, tags: [...task.tags], link: task.link, note: task.note, est: task.est, subs: task.subs.slice(0, 9).map(sub => ({ t: sub.t, d: false })) }));
}
const collection = { task: 'tasks', note: 'notes', proj: 'projects' } as const;
export function removeRecords(state: WorkbenchState, kind: Kind, ids: string[]) {
  const key = collection[kind], items = state[key], now = Date.now();
  items.forEach((rec, idx) => {
    if (!ids.includes(rec.id)) return;
    const pids = kind === 'proj' ? state.tasks.filter(task => task.pid === rec.id).map(task => task.id) : undefined;
    state.bin.unshift({ id: rec.id, kind, rec: structuredClone(rec), idx, at: now, pids }); state.tomb[rec.id] = now;
    if (kind === 'proj') state.tasks.forEach(task => { if (task.pid === rec.id) { task.pid = ''; task.updatedAt = now; } });
  });
  (state[key] as RecordBase[]) = items.filter(rec => !ids.includes(rec.id));
}
export function restoreRecord(state: WorkbenchState, id: string) {
  const entry = state.bin.find(x => x.id === id); if (!entry) return;
  const items = state[collection[entry.kind]] as RecordBase[];
  const restored = { ...entry.rec, updatedAt: Math.max(Date.now(), Number(state.tomb[id]) + 1 || 0) };
  const existing = items.findIndex(x => x.id === id); if (existing >= 0) items[existing] = restored; else items.splice(Math.min(entry.idx || 0, items.length), 0, restored);
  if (entry.kind === 'proj') state.tasks.forEach(task => { if (entry.pids?.includes(task.id) && !task.pid) { task.pid = id; task.updatedAt = Date.now(); } });
  delete state.tomb[id]; state.bin = state.bin.filter(x => x.id !== id);
}
export function rollover(state: WorkbenchState, today = day()) {
  if (state.meta.lastOpen === today) return;
  state.tasks.forEach(task => { if (!task.done && task.due && task.due < today) { task.rolls++; task.carried = today; task.updatedAt = Date.now(); } }); state.meta.lastOpen = today;
}

export function parseQuick(raw: string, projects: Project[], today = day()) {
  let source = ' ' + raw.replace(/\s+/g, ' ').trim() + ' ';
  const result: Partial<Task> & { title: string } = { title: raw, due: '', start: '', pid: '', tags: [], est: 0 };
  source = source.replace(/\s[!！pP]([1-4])(?=\s)/, (_, priority: string) => { result.prio = Number(priority); return ' '; });
  const weekdays: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
  const dateToken = (token: string) => {
    const offsets: Record<string, number> = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3, today: 0, tomorrow: 1 };
    if (token in offsets) return shift(today, offsets[token]);
    const week = token.match(/^(下?)(?:周|星期)([一二三四五六日天])$/);
    if (week) { const offset = (weekdays[week[2]] - new Date(today + 'T00:00:00').getDay() + 7) % 7 || 7; return shift(today, offset + (week[1] ? 7 : 0)); }
    const exact = token.match(/^(\d{1,2})[月/.-](\d{1,2})[日号]?$/);
    if (exact && Number(exact[1]) >= 1 && Number(exact[1]) <= 12 && Number(exact[2]) >= 1 && Number(exact[2]) <= 31) {
      const suffix = `-${exact[1].padStart(2, '0')}-${exact[2].padStart(2, '0')}`, year = Number(today.slice(0, 4)); return `${year}${suffix}` >= today ? `${year}${suffix}` : `${year + 1}${suffix}`;
    }
    return '';
  };
  source = source.replace(/\s([^\s~～]+)[~～]([^\s~～]+)(?=\s)/, (whole, left: string, right: string) => {
    const start = dateToken(left), due = dateToken(right); if (!start && !due) return whole; result.start = start; result.due = due || start; return ' ';
  });
  if (!result.due) source = source.replace(/\s([^\s]+)(?=\s)/g, (whole, token: string) => { const parsed = dateToken(token); if (parsed && !result.due) { result.due = parsed; return ' '; } return whole; });
  source = source.replace(/\s[~～](\d{1,2})(?=\s)/, (_, value: string) => { result.est = Math.min(20, Number(value)); return ' '; });
  source = source.replace(/\s#([^\s#!！@，,。.]+)(?=\s)/g, (_, value: string) => {
    const project = projects.find(p => p.name.toLowerCase().includes(value.toLowerCase()) || value.toLowerCase().includes(p.name.toLowerCase()));
    if (project && !result.pid) result.pid = project.id; else result.tags!.push(value); return ' ';
  });
  result.tags = [...new Set(result.tags)].slice(0, 6); result.title = source.trim() || raw.trim(); return result;
}
export function noteToTask(state: WorkbenchState, note: Note) {
  const lines = note.text.split(String.fromCharCode(10)).map(line => line.trim()).filter(Boolean);
  state.tasks.unshift(taskDefaults({ title: (lines[0] || note.text).slice(0, 140), prio: 2, tags: note.tags.slice(0, 6), subs: lines.slice(1, 10).map(t => ({ t: t.slice(0, 80), d: false })) }));
}
export function seed(english = false) {
  const state = blank(), now = Date.now(), hour = 36e5, today = day();
  const names = english ? ['Homepage redesign', 'Q3 growth plan', 'Personal blog migration', 'H1 tax filing'] : ['首页改版', 'Q3 增长方案', '个人博客迁移', '上半年报税'];
  const stages = english ? ['Second round of visual review', 'Data conclusions ready, report missing its conclusion page', 'All posts exported', 'Filed and paid'] : ['视觉稿第二轮评审中', '数据结论已出，报告差结论页', '文章已全部导出', '已提交并完成缴款'];
  const next = english ? ['Finalize by Friday and submit for dev scheduling', 'Finish the conclusion page, present Monday', 'Pick a theme for the new site and deploy', 'Archive receipts'] : ['本周五前定稿并提交开发排期', '写完结论页，周一汇报', '选定新站点主题并部署', '归档凭证'];
  state.projects = names.map((name, i) => ({ id: uid(), name, stage: stages[i], next: next[i], blocker: i === 1 ? (english ? 'Channel data lacks June definitions, waiting on the data team' : '渠道数据缺 6 月口径，等数据组回复') : '', status: i === 1 ? 'blocked' : i === 3 ? 'done' : 'active', updatedAt: now - [12, 30, 90, 120][i] * hour, _s: true }));
  const titles = english ? ['Finish the conclusion page of the Q3 growth plan', 'Reply to the supplier quote confirmation email', 'Walk through the homepage redesign with design', 'Turn homepage visual feedback into a checklist', 'Put together a personal learning list for H2', 'Pick a theme for the new blog site', 'Confirm June channel definitions with the data team', 'Book a health check-up', 'Send the weekly meeting deck to the group', 'Archive last month’s invoices', 'Give the new teammate a system walkthrough', 'Export all historical blog posts'] : ['把 Q3 增长方案的结论页写完', '回复供应商的报价确认邮件', '和设计过一遍首页改版稿', '把首页视觉稿的反馈整理成清单', '整理下半年个人学习清单', '挑选博客新站点主题', '找数据组确认 6 月渠道口径', '预约体检', '周会材料发群里', '把上月账单归档', '给新同学做一次系统介绍', '导出博客全部历史文章'];
  state.tasks = titles.map((title, i) => taskDefaults({ title, prio: [1, 3, 1, 2, 2, 3, 1, 4, 1, 2, 3, 2][i], due: shift(today, [-1, -3, 0, 1, 3, 4, 2, 10, -2, -2, -1, -4][i]), pid: [1, -1, 0, 0, -1, 2, 1, -1, -1, 3, -1, 2][i] < 0 ? '' : state.projects[[1, -1, 0, 0, -1, 2, 1, -1, -1, 3, -1, 2][i]].id, createdAt: now - [50, 80, 20, 14, 10, 9, 8, 6, 70, 66, 30, 100][i] * hour, done: i >= 8, doneAt: i >= 8 ? now - [46, 40, 22, 92][i - 8] * hour : null, _s: true }));
  const notes = english ? ['The workbench home page could keep only “Needs attention today” and tuck everything else into the sidebar — less information makes it easier to start.', 'Reading note: task lists usually fail not because too little is written down, but because postponing costs nothing. Count every postponement and you start feeling awkward about it.', 'Adding a blocker summary to the review is more useful than counting how many things got done.'] : ['工作台首页可以只留「今天要处理的」，其他都收进侧边栏——信息越少越容易开始。', '读书笔记：任务清单失效通常不是因为写得少，而是因为没有「顺延成本」。每顺延一次就记一次，自己会不好意思。', '给复盘加一个「卡点汇总」，比统计做了多少件事更有用。'];
  state.notes = notes.map((content, i) => ({ id: uid(), text: content, tags: (english ? [['product', 'ideas'], ['reading', 'method'], ['method']] : [['产品', '灵感'], ['读书', '方法'], ['方法']])[i], createdAt: now - [26, 52, 5][i] * hour, updatedAt: now - [26, 52, 5][i] * hour, _s: true }));
  state.meta.sample = true; return state;
}
export function markdown(state: WorkbenchState, english = false, period?: { start: string; end: string }) {
  const label = (zh: string, en: string) => english ? en : zh, lines: string[] = [];
  const inPeriod = (stamp: number) => !period || (day(new Date(stamp)) >= period.start && day(new Date(stamp)) <= period.end);
  const tasks = period ? state.tasks.filter(task => task.done && !!task.doneAt && inPeriod(task.doneAt)) : state.tasks;
  lines.push(`# ${label(period ? '周期复盘' : '办公工作台', period ? 'Period review' : 'Workbench')}`, '', period ? `${period.start} ~ ${period.end}` : day(), '', `- ${label('完成', 'Completed')}: ${tasks.filter(task => task.done).length}`, `- ${label('新建', 'Created')}: ${state.tasks.filter(task => inPeriod(task.createdAt)).length}`, `- ${label('番茄', 'Pomodoros')}: ${Object.entries(state.meta.pomoLog).filter(([date]) => !period || (date >= period.start && date <= period.end)).reduce((sum, [, count]) => sum + Number(count), 0)}`, '', `## ${label('任务', 'Tasks')}`, '');
  for (const project of [...state.projects, { id: '', name: label('未关联项目', 'Unlinked') }]) {
    const group = tasks.filter(task => task.pid === project.id); if (!group.length) continue;
    lines.push(`### ${project.name}`, '');
    for (const task of group) { lines.push(`- [${task.done ? 'x' : ' '}] ${task.title}${task.due ? ` (${task.start ? task.start + ' ~ ' : ''}${task.due})` : ''}${task.tags.length ? ' #' + task.tags.join(' #') : ''}${task.link ? ` [↗](${task.link})` : ''}`); task.subs.forEach(sub => lines.push(`  - [${sub.d ? 'x' : ' '}] ${sub.t}`)); }
    lines.push('');
  }
  if (!period) { lines.push(`## ${label('灵感', 'Notes')}`, ''); state.notes.forEach(note => lines.push(`- ${note.text}${note.tags.length ? ' #' + note.tags.join(' #') : ''}`)); }
  if (period) {
    lines.push('', `## ${label('本周期新建', 'Created this period')}`, ''); state.tasks.filter(task => inPeriod(task.createdAt)).forEach(task => lines.push(`- ${task.title}`));
    lines.push('', `## ${label('卡点', 'Blockers')}`, ''); state.projects.filter(project => project.status === 'blocked').forEach(project => lines.push(`- **${project.name}**: ${project.blocker} · ${project.next}`));
  }
  lines.push('', `## ${label('每日一记', 'Daily lines')}`, ''); Object.entries(state.diary).filter(([date]) => !period || (date >= period.start && date <= period.end)).sort().forEach(([date, content]) => lines.push(`- **${date}** ${content}`));
  return lines.join(String.fromCharCode(10));
}
