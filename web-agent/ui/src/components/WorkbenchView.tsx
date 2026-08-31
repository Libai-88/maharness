// ui/src/components/WorkbenchView.tsx —— 办公工作台（workbench 插件前端视图）
// 心智模型只有两个：「今天要做的事」与「我手头的项目」——零教程上手。
// 数据经 workbench 插件 REST（/api/plugins/workbench/wb/*）；插件停用 → 端点 404 →
// 本视图展示「未启用」空态，侧边栏 Tab 亦随之消失（App 按插件状态动态挂载）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { subscribeEvents, workbenchApi } from '../api';
import { fadeUp, springTransition, staggerContainer } from '../motion';
import type { WbProject, WbRepeat, WbState, WbTask } from '../types';
import {
  IconCheck, IconChevronLeft, IconClock, IconPlus, IconRefresh, IconTrash, IconWarn, IconWorkbench,
} from './Icon';

// 项目色板：与插件侧 WB_COLORS 保持一致（暖炭手作同源色）
const WB_COLORS = ['#d0856b', '#82a873', '#d9a441', '#e0913f', '#d96856', '#a89673'];
const REPEAT_LABEL: Record<WbRepeat, string> = { daily: '每天', weekdays: '工作日', weekly: '每周' };
const REPEAT_CYCLE: (WbRepeat | undefined)[] = [undefined, 'daily', 'weekdays', 'weekly'];
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// ---- 日期工具（本地时区） ----
function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}
function fmtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function dateLabel(s: string): string {
  const d = parseDate(s);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
}
function deadlineInfo(date: string | undefined, today: string): { text: string; tone: 'ok' | 'warn' | 'over' } | null {
  if (!date) return null;
  const diff = Math.round((parseDate(date).getTime() - parseDate(today).getTime()) / 86_400_000);
  if (diff < 0) return { text: `逾期 ${-diff} 天`, tone: 'over' };
  if (diff === 0) return { text: '今天截止', tone: 'warn' };
  if (diff === 1) return { text: '明天截止', tone: 'warn' };
  return { text: `剩 ${diff} 天`, tone: 'ok' };
}
const byTime = (a: WbTask, b: WbTask) =>
  (a.time ?? '99:99').localeCompare(b.time ?? '99:99') || a.createdAt - b.createdAt;

/** 行内可编辑文本（双击改名，Enter/失焦提交）——任务标题与项目名共用 */
function EditableText({ value, className, onCommit }: { value: string; className?: string; onCommit: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const commit = () => {
    setEditing(false);
    const v = draft.trim();
    if (v && v !== value) onCommit(v);
  };
  if (!editing) {
    return (
      <span className={className} onDoubleClick={() => { setDraft(value); setEditing(true); }} title="双击重命名">
        {value}
      </span>
    );
  }
  return (
    <input
      className="wb-edit-input"
      value={draft}
      autoFocus
      maxLength={200}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') setEditing(false);
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

/** 进度条（陶土→松绿按完成度着色） */
function Progress({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="wb-bar">
      <motion.div
        className="wb-bar-fill"
        style={{ background: color }}
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      />
    </div>
  );
}

interface TaskRowProps {
  t: WbTask;
  project?: WbProject;
  showDate?: boolean;
  onToggle: (t: WbTask) => void;
  onDelete: (t: WbTask) => void;
  onRename: (t: WbTask, title: string) => void;
}

function TaskRow({ t, project, showDate, onToggle, onDelete, onRename }: TaskRowProps) {
  return (
    <motion.div variants={fadeUp} className={`wb-task ${t.done ? 'done' : ''}`}>
      <button
        className="wb-check"
        aria-label={t.done ? '标记未完成' : '标记完成'}
        onClick={() => onToggle(t)}
      >
        <AnimatePresence>
          {t.done && (
            <motion.span
              className="wb-check-inner"
              key="check"
              initial={{ scale: 0.4, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.4, opacity: 0, transition: { duration: 0.1 } }}
              transition={springTransition}
            >
              <IconCheck size={11} />
            </motion.span>
          )}
        </AnimatePresence>
      </button>
      {t.time && <span className="wb-time"><IconClock size={11} />{t.time}</span>}
      <EditableText className="wb-title" value={t.title} onCommit={(v) => onRename(t, v)} />
      {t.repeat && <span className="wb-tag tag-repeat">{REPEAT_LABEL[t.repeat]}</span>}
      {project && <span className="wb-tag" style={{ color: project.color, borderColor: project.color }}>{project.name}</span>}
      {showDate && t.date && <span className="wb-tag tag-date">{dateLabel(t.date)}</span>}
      <span className="flex1" />
      <button className="wb-del" aria-label="删除任务" onClick={() => onDelete(t)}><IconTrash size={12} /></button>
    </motion.div>
  );
}

export default function WorkbenchView() {
  const [state, setState] = useState<WbState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<'today' | 'projects'>('today');
  const [selProject, setSelProject] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [showUpcoming, setShowUpcoming] = useState(true);

  // 快速添加（今日 / 项目详情共用一套输入）
  const [draft, setDraft] = useState('');
  const [draftTime, setDraftTime] = useState('');
  const [draftDate, setDraftDate] = useState('');   // 空 = 今天
  const [draftRepeat, setDraftRepeat] = useState<WbRepeat | undefined>(undefined);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [npName, setNpName] = useState('');
  const [npColor, setNpColor] = useState(WB_COLORS[0]);
  const [npDeadline, setNpDeadline] = useState('');
  const draftRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await workbenchApi.state();
      setState(s);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => subscribeEvents((e) => {
    if (e.type === 'workbench.updated') void load();
  }), [load]);

  // ---- 派生数据（一次取回，前端派生） ----
  const d = useMemo(() => {
    if (!state) return null;
    const today = state.today;
    const todayOpen = state.tasks.filter((t) => t.date === today && !t.done).sort(byTime);
    const todayDone = state.tasks.filter((t) => t.date === today && t.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
    const overdue = state.tasks.filter((t) => !t.done && t.date < today).sort((a, b) => a.date.localeCompare(b.date) || byTime(a, b));
    const weekEnd = fmtDate(new Date(parseDate(today).getTime() + 7 * 86_400_000));
    const upcoming = state.tasks
      .filter((t) => !t.done && t.date > today && t.date <= weekEnd)
      .sort((a, b) => a.date.localeCompare(b.date) || byTime(a, b));
    const projOf = (id?: string) => state.projects.find((p) => p.id === id);
    const projects = state.projects.map((p) => {
      const list = state.tasks.filter((t) => t.projectId === p.id);
      const done = list.filter((t) => t.done).length;
      return { p, total: list.length, done, pct: list.length ? Math.round((done / list.length) * 100) : 0 };
    })
      .sort((a, b) => (a.p.status === 'active' ? 0 : 1) - (b.p.status === 'active' ? 0 : 1) || a.p.order - b.p.order);
    return { today, todayOpen, todayDone, overdue, upcoming, projOf, projects };
  }, [state]);

  const applyState = useCallback((s: WbState) => setState(s), []);

  // ---- 操作（全部回传新状态，一轮刷新；失败 toast 不清屏） ----
  const withApi = useCallback(async (fn: () => Promise<{ ok: boolean; state?: WbState }>, okMsg?: string) => {
    try {
      const r = await fn();
      if (r.state) applyState(r.state);
      if (okMsg) toast.success(okMsg);
      setErr(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [applyState]);

  if (err) {
    return (
      <div className="view-scroll">
        <div className="empty-state wb-empty">
          <IconWorkbench size={28} />
          <p>办公工作台未启用或加载失败（{err}）</p>
          <p className="wb-empty-sub">在左侧「插件」页找到 workbench 一键启用即可恢复</p>
        </div>
      </div>
    );
  }
  if (!d) return <div className="view-scroll"><div className="empty-state">工作台加载中…</div></div>;

  const { today, todayOpen, todayDone, overdue, upcoming, projOf, projects } = d;
  const activeProjects = projects.filter((x) => x.p.status === 'active');
  const sel = projects.find((x) => x.p.id === selProject);
  const resetDraft = () => { setDraft(''); setDraftTime(''); setDraftRepeat(undefined); };

  const submitTask = (projectId?: string) => {
    const title = draft.trim();
    if (!title) { draftRef.current?.focus(); return; }
    void withApi(async () => {
      const r = await workbenchApi.addTask({
        title,
        time: draftTime || undefined,
        date: draftDate || today,
        projectId,
        repeat: draftRepeat,
      });
      return r;
    }, '已添加');
    resetDraft();
  };

  const submitProject = () => {
    const name = npName.trim();
    if (!name) return;
    void withApi(() => workbenchApi.addProject({ name, color: npColor, deadline: npDeadline || undefined }), '项目已创建');
    setNpName(''); setNpDeadline(''); setNewProjectOpen(false);
  };

  const kpis = [
    { label: '今日待办', value: todayOpen.length, tone: 'var(--accent)' },
    { label: '已完成', value: todayDone.length, tone: 'var(--teal)' },
    { label: '已过期', value: overdue.length, tone: overdue.length ? 'var(--red)' : 'var(--text-3)' },
    { label: '进行中项目', value: activeProjects.length, tone: 'var(--purple)' },
  ];

  return (
    <div className="view-scroll">
      <motion.div variants={staggerContainer} initial="initial" animate="enter">
        {/* 页头 */}
        <motion.div variants={fadeUp} className="page-head">
          <div className="ph-eyebrow">
            <span className="ph-no">05</span>
            <span className="ph-label">WORKBENCH</span>
            <span className="ph-rule" />
            <span className="ph-cn">办公工作台</span>
          </div>
          <span className="ph-title">{today === state?.today ? '今天' : ''}· {dateLabel(today)}</span>
          <span className="ph-sub">今天要做的事 · 手头的项目——勾掉一条，进度自己涨</span>
        </motion.div>

        {/* KPI 行 */}
        <motion.div variants={fadeUp} className="wb-kpis">
          {kpis.map((k) => (
            <div key={k.label} className="wb-kpi">
              <span className="wb-kpi-val" style={{ color: k.tone }}>{k.value}</span>
              <span className="wb-kpi-label">{k.label}</span>
            </div>
          ))}
          <span className="flex1" />
          <div className="wb-view-switch">
            <button className={view === 'today' ? 'active' : ''} onClick={() => setView('today')}>今日</button>
            <button className={view === 'projects' ? 'active' : ''} onClick={() => { setView('projects'); setSelProject(null); }}>项目</button>
          </div>
        </motion.div>

        <AnimatePresence mode="wait" initial={false}>
          {view === 'today' ? (
            <motion.div key="today" variants={staggerContainer} initial="initial" animate="enter" exit={{ opacity: 0, transition: { duration: 0.1 } }} className="wb-grid">
              {/* 左列：今日任务流 */}
              <div className="wb-col">
                {/* 逾期提醒 */}
                {overdue.length > 0 && (
                  <motion.div variants={fadeUp} className="wb-overdue">
                    <span className="wb-overdue-text"><IconWarn size={13} /> 有 {overdue.length} 条过期未完成</span>
                    <button className="wb-btn ghost" onClick={() => void withApi(() => workbenchApi.rollover(), `已把 ${overdue.length} 条任务移到今天`)}>
                      <IconRefresh size={12} />移到今天
                    </button>
                  </motion.div>
                )}

                {/* 快速添加（日期/时刻/重复三件套，默认今天） */}
                <motion.div variants={fadeUp} className="wb-quick">
                  <button
                    className="wb-repeat-cycle"
                    onClick={() => {
                      const i = REPEAT_CYCLE.indexOf(draftRepeat);
                      setDraftRepeat(REPEAT_CYCLE[(i + 1) % REPEAT_CYCLE.length]);
                    }}
                    title="重复：点击切换（不重复/每天/工作日/每周）"
                  >
                    {draftRepeat ? REPEAT_LABEL[draftRepeat] : '不重复'}
                  </button>
                  <input type="date" className="wb-input wb-input-date" value={draftDate || today} onChange={(e) => setDraftDate(e.target.value)} aria-label="日期" />
                  <input type="time" className="wb-input wb-input-time" value={draftTime} onChange={(e) => setDraftTime(e.target.value)} aria-label="时刻（可选）" />
                  <input
                    ref={draftRef}
                    className="wb-input wb-input-title"
                    placeholder="今天要做什么？回车添加…"
                    value={draft}
                    maxLength={200}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') submitTask(); }}
                  />
                  <button className="wb-btn primary" onClick={() => submitTask()}><IconPlus size={13} />添加</button>
                </motion.div>

                {/* 今日任务列表 */}
                <motion.div variants={fadeUp} className="wb-list">
                  {todayOpen.length === 0 && todayDone.length === 0 && (
                    <div className="wb-none">今天还没有安排——在上方输入一条，从规划开始。</div>
                  )}
                  {todayOpen.length === 0 && todayDone.length > 0 && (
                    <div className="wb-none">今天的安排都完成了，干得漂亮。</div>
                  )}
                  {todayOpen.map((t) => (
                    <TaskRow key={t.id} t={t} project={projOf(t.projectId)} onToggle={(x) => void withApi(() => workbenchApi.updateTask(x.id, { done: true }))}
                      onDelete={(x) => void withApi(() => workbenchApi.removeTask(x.id))} onRename={(x, title) => void withApi(() => workbenchApi.updateTask(x.id, { title }))} />
                  ))}
                </motion.div>

                {/* 未来 7 天 */}
                {upcoming.length > 0 && (
                  <motion.div variants={fadeUp} className="wb-section">
                    <button className="wb-section-head" onClick={() => setShowUpcoming((v) => !v)}>
                      未来 7 天<span className="wb-count">{upcoming.length}</span>
                      <span className="flex1" />
                      <span className="wb-fold">{showUpcoming ? '收起' : '展开'}</span>
                    </button>
                    {showUpcoming && (
                      <div className="wb-list">
                        {upcoming.map((t) => (
                          <TaskRow key={t.id} t={t} project={projOf(t.projectId)} showDate
                            onToggle={(x) => void withApi(() => workbenchApi.updateTask(x.id, { done: true }))}
                            onDelete={(x) => void withApi(() => workbenchApi.removeTask(x.id))}
                            onRename={(x, title) => void withApi(() => workbenchApi.updateTask(x.id, { title }))} />
                        ))}
                      </div>
                    )}
                  </motion.div>
                )}

                {/* 今日已完成（折叠 + 清除） */}
                {todayDone.length > 0 && (
                  <motion.div variants={fadeUp} className="wb-section">
                    <button className="wb-section-head" onClick={() => setShowDone((v) => !v)}>
                      已完成<span className="wb-count">{todayDone.length}</span>
                      <span className="flex1" />
                      <span className="wb-fold">{showDone ? '收起' : '展开'}</span>
                    </button>
                    {showDone && (
                      <>
                        <div className="wb-list">
                          {todayDone.map((t) => (
                            <TaskRow key={t.id} t={t} project={projOf(t.projectId)}
                              onToggle={(x) => void withApi(() => workbenchApi.updateTask(x.id, { done: false }))}
                              onDelete={(x) => void withApi(() => workbenchApi.removeTask(x.id))}
                              onRename={(x, title) => void withApi(() => workbenchApi.updateTask(x.id, { title }))} />
                          ))}
                        </div>
                        <div className="wb-clear-row">
                          <button className="wb-btn ghost" onClick={() => void withApi(() => workbenchApi.clearDone(today), '已清除今日已完成')}>清除已完成</button>
                        </div>
                      </>
                    )}
                  </motion.div>
                )}
              </div>

              {/* 右列：项目进度摘要 */}
              <motion.div variants={fadeUp} className="wb-col wb-side">
                <div className="wb-side-head">
                  <span>项目进度</span>
                  <button className="wb-link" onClick={() => setView('projects')}>管理 →</button>
                </div>
                {activeProjects.length === 0 && <div className="wb-none">还没有进行中的项目。到「项目」页创建一个，把事情拆成任务。</div>}
                {activeProjects.slice(0, 6).map(({ p, done, total, pct }) => (
                  <div key={p.id} className="wb-proj-mini" onClick={() => { setView('projects'); setSelProject(p.id); }}>
                    <div className="wb-proj-mini-head">
                      <span className="wb-dot" style={{ background: p.color }} />
                      <span className="wb-proj-mini-name">{p.name}</span>
                      <span className="wb-proj-mini-num">{done}/{total}</span>
                    </div>
                    <Progress pct={pct} color={p.color} />
                  </div>
                ))}
              </motion.div>
            </motion.div>
          ) : sel ? (
            /* ---- 项目详情 ---- */
            <motion.div key={`proj-${sel.p.id}`} variants={staggerContainer} initial="initial" animate="enter" exit={{ opacity: 0, transition: { duration: 0.1 } }} className="wb-col">
              <motion.div variants={fadeUp} className="wb-proj-detail-head">
                <button className="wb-btn ghost" onClick={() => setSelProject(null)}><IconChevronLeft size={13} />返回</button>
                <span className="wb-dot big" style={{ background: sel.p.color }} />
                <EditableText className="wb-proj-title" value={sel.p.name} onCommit={(v) => void withApi(() => workbenchApi.updateProject(sel.p.id, { name: v }))} />
                <select
                  className="wb-input wb-select"
                  value={sel.p.status}
                  onChange={(e) => void withApi(() => workbenchApi.updateProject(sel.p.id, { status: e.target.value }))}
                  aria-label="项目状态"
                >
                  <option value="active">进行中</option>
                  <option value="paused">已搁置</option>
                  <option value="done">已完成</option>
                </select>
                <input
                  type="date"
                  className="wb-input wb-input-date"
                  value={sel.p.deadline ?? ''}
                  onChange={(e) => void withApi(() => workbenchApi.updateProject(sel.p.id, { deadline: e.target.value || undefined }))}
                  aria-label="截止日期"
                />
                <button className="wb-del" aria-label="删除项目" onClick={() => {
                  if (confirm(`删除项目「${sel.p.name}」？项目下的任务会保留（不再归属任何项目）。`)) {
                    void withApi(() => workbenchApi.removeProject(sel.p.id), '项目已删除');
                    setSelProject(null);
                  }
                }}><IconTrash size={13} /></button>
              </motion.div>

              <motion.div variants={fadeUp} className="wb-proj-stats">
                <Progress pct={sel.pct} color={sel.p.color} />
                <div className="wb-proj-stats-meta">
                  <span>{sel.pct}%</span>
                  <span>{sel.done}/{sel.total} 任务</span>
                  {deadlineInfo(sel.p.deadline, today) && (
                    <span className={`wb-deadline tone-${deadlineInfo(sel.p.deadline, today)!.tone}`}>{deadlineInfo(sel.p.deadline, today)!.text}</span>
                  )}
                  <span className="wb-color-row">
                    {WB_COLORS.map((c) => (
                      <button key={c} className={`wb-dot pick ${sel.p.color === c ? 'on' : ''}`} style={{ background: c }}
                        onClick={() => void withApi(() => workbenchApi.updateProject(sel.p.id, { color: c }))} aria-label={`换色 ${c}`} />
                    ))}
                  </span>
                </div>
              </motion.div>

              {/* 项目内快速添加 */}
              <motion.div variants={fadeUp} className="wb-quick">
                <button
                  className="wb-repeat-cycle"
                  onClick={() => {
                    const i = REPEAT_CYCLE.indexOf(draftRepeat);
                    setDraftRepeat(REPEAT_CYCLE[(i + 1) % REPEAT_CYCLE.length]);
                  }}
                  title="重复：点击切换"
                >
                  {draftRepeat ? REPEAT_LABEL[draftRepeat] : '不重复'}
                </button>
                <input type="date" className="wb-input wb-input-date" value={draftDate || today} onChange={(e) => setDraftDate(e.target.value)} aria-label="日期" />
                <input type="time" className="wb-input wb-input-time" value={draftTime} onChange={(e) => setDraftTime(e.target.value)} aria-label="时刻（可选）" />
                <input
                  ref={draftRef}
                  className="wb-input wb-input-title"
                  placeholder={`给「${sel.p.name}」加一条任务…`}
                  value={draft}
                  maxLength={200}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitTask(sel.p.id); }}
                />
                <button className="wb-btn primary" onClick={() => submitTask(sel.p.id)}><IconPlus size={13} />添加</button>
              </motion.div>

              <motion.div variants={fadeUp} className="wb-list">
                {sel.total === 0 && <div className="wb-none">项目还没有任务——大事拆小，加第一条。</div>}
                {state?.tasks.filter((t) => t.projectId === sel.p.id && !t.done).sort((a, b) => a.date.localeCompare(b.date) || byTime(a, b)).map((t) => (
                  <TaskRow key={t.id} t={t} showDate
                    onToggle={(x) => void withApi(() => workbenchApi.updateTask(x.id, { done: true }))}
                    onDelete={(x) => void withApi(() => workbenchApi.removeTask(x.id))}
                    onRename={(x, title) => void withApi(() => workbenchApi.updateTask(x.id, { title }))} />
                ))}
              </motion.div>
              {state && state.tasks.some((t) => t.projectId === sel.p.id && t.done) && (
                <motion.div variants={fadeUp} className="wb-section">
                  <button className="wb-section-head" onClick={() => setShowDone((v) => !v)}>
                    已完成<span className="wb-count">{sel.done}</span>
                    <span className="flex1" />
                    <span className="wb-fold">{showDone ? '收起' : '展开'}</span>
                  </button>
                  {showDone && (
                    <div className="wb-list">
                      {state.tasks.filter((t) => t.projectId === sel.p.id && t.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)).map((t) => (
                        <TaskRow key={t.id} t={t} showDate
                          onToggle={(x) => void withApi(() => workbenchApi.updateTask(x.id, { done: false }))}
                          onDelete={(x) => void withApi(() => workbenchApi.removeTask(x.id))}
                          onRename={(x, title) => void withApi(() => workbenchApi.updateTask(x.id, { title }))} />
                      ))}
                    </div>
                  )}
                </motion.div>
              )}
            </motion.div>
          ) : (
            /* ---- 项目列表 ---- */
            <motion.div key="projects" variants={staggerContainer} initial="initial" animate="enter" exit={{ opacity: 0, transition: { duration: 0.1 } }} className="wb-col">
              <motion.div variants={fadeUp} className="wb-proj-toolbar">
                <button className="wb-btn primary" onClick={() => setNewProjectOpen((v) => !v)}><IconPlus size={13} />新建项目</button>
                {newProjectOpen && (
                  <div className="wb-quick wb-np">
                    <input className="wb-input wb-input-title" placeholder="项目名称（如：季度汇报）" value={npName} maxLength={100}
                      onChange={(e) => setNpName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submitProject(); }} autoFocus />
                    <span className="wb-color-row">
                      {WB_COLORS.map((c) => (
                        <button key={c} className={`wb-dot pick ${npColor === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setNpColor(c)} aria-label={`颜色 ${c}`} />
                      ))}
                    </span>
                    <input type="date" className="wb-input wb-input-date" value={npDeadline} onChange={(e) => setNpDeadline(e.target.value)} aria-label="截止日期（可选）" />
                    <button className="wb-btn primary" onClick={submitProject}>创建</button>
                  </div>
                )}
              </motion.div>

              {projects.length === 0 && (
                <div className="wb-none big">还没有项目。创建一个（比如「季度汇报」「装修」），把事情拆成任务——勾掉一条，进度条自己涨。</div>
              )}
              <motion.div variants={fadeUp} className="wb-proj-grid">
                {projects.map(({ p, done, total, pct }) => {
                  const dl = deadlineInfo(p.deadline, today);
                  return (
                    <div key={p.id} className={`wb-proj-card st-${p.status}`} onClick={() => setSelProject(p.id)}>
                      <div className="wb-proj-card-head">
                        <span className="wb-dot" style={{ background: p.color }} />
                        <span className="wb-proj-card-name">{p.name}</span>
                        <span className={`wb-status st-${p.status}`}>{p.status === 'active' ? '进行中' : p.status === 'paused' ? '已搁置' : '已完成'}</span>
                      </div>
                      {p.desc && <div className="wb-proj-card-desc">{p.desc}</div>}
                      <Progress pct={pct} color={p.color} />
                      <div className="wb-proj-card-foot">
                        <span>{done}/{total} 任务 · {pct}%</span>
                        {dl && <span className={`wb-deadline tone-${dl.tone}`}>{dl.text}</span>}
                      </div>
                    </div>
                  );
                })}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
