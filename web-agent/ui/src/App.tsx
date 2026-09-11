// ui/src/App.tsx —— 主布局（Screen 1–8 导航枢纽）
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { approvalsApi, commandsApi, modelsApi, navApi, planApi, pluginsApi, providersApi, sessionApi, streamChat, subscribeEvents, traceApi } from './api';
import type { ErrorKind } from './api';
import type { ApprovalItem, BusEvent, ChatMessage, CheckpointInfo, ModelInfo, PlanState, PluginInfo, PluginNavItem, ProviderInfo, Session, TodoCard, TraceStep } from './types';
import { toolActivityLabel } from './types';
// 演出重建：DB 行 → 界面消息（刷新前后同一形态）；文案中心：所有系统话术统一出口
import { collectMembers, replayMessages } from './replay';
import { AGENT_ID, AGENT_NAME, APP_VERSION, humanizeError, sys } from './voice';

/** 切到后台时的消息提醒：标题角标 + 一声轻响（像微信的消息音） */
let audioCtxRef: AudioContext | null = null;
function dingOnce() {
  try {
    const AC = window.AudioContext;
    if (!AC) return;
    if (!audioCtxRef) audioCtxRef = new AC();
    const ctx = audioCtxRef;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    o.type = 'sine';
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.35);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
    o.start();
    o.stop(ctx.currentTime + 0.5);
  } catch { /* 音频不可用时静默 */ }
}
import Sidebar from './components/Sidebar';
import type { MainTab } from './components/Sidebar';
import ChatView from './components/ChatView';
import TracePanel from './components/TracePanel';
import Menu from './components/Menu';
import { AnimatePresence, motion } from 'motion/react';
import { pageVariants } from './motion';
import { IconChevronDown, IconClose, IconPanel, IconPlugin, IconTodo, IconWorkbench } from './components/Icon';
import { Toaster, toast } from 'sonner';
import { applyFavicon } from './brand/favicon';

// 次要视图路由级代码分割：首屏只需 Chat 视图，文件/插件/统计/设置
// 按需加载（首屏 JS 体积显著下降），挂载后 idle 时预取保证首次点击无感。
// 注意：插件页面【不在】此列表——它们由插件在 plugin.json 声明 nav，
// 前端遍历 /api/nav 生成标签页，内容由 PluginTabView 通用渲染（前端不认识任何插件）。
const FilesView = lazy(() => import('./components/FilesView'));
const PluginsView = lazy(() => import('./components/PluginsView'));
const StatsView = lazy(() => import('./components/StatsView'));
const SettingsView = lazy(() => import('./components/SettingsView'));
import PluginTabView from './components/PluginTabView';

function preloadSecondaryViews() {
  void import('./components/FilesView');
  void import('./components/PluginsView');
  void import('./components/StatsView');
  void import('./components/SettingsView');
}

/**
 * 插件图标解析：nav.icon 是插件声明的图标名，这里是前端内置图标表。
 * 未知名回落到通用插件图标——插件写错图标名不该导致它的页面无法使用。
 */
function pluginIcon(name: string | null): React.ReactNode {
  switch (name) {
    case 'workbench': return <IconWorkbench size={14} />;
    case 'todo': return <IconTodo size={14} />;
    default: return <IconPlugin size={14} />;
  }
}

/** 模型条目 id = provider@model（服务端 /api/models 约定） */
function splitModelId(id: string): { provider: string; model: string } {
  const i = id.lastIndexOf('@');
  return i > 0 ? { provider: id.slice(0, i), model: id.slice(i + 1) } : { provider: id, model: '' };
}

export type Theme = 'dark' | 'light';
export type Brand = 'doodle' | 'ink' | 'moss';

function readTheme(): Theme {
  try {
    const saved = localStorage.getItem('maharness-theme');
    if (saved === 'dark' || saved === 'light') return saved;
  } catch { /* 隐私模式等场景读不到 */ }
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readBrand(): Brand {
  try {
    const b = localStorage.getItem('maharness-brand');
    if (b === 'ink' || b === 'moss' || b === 'doodle') return b;
  } catch { /* 忽略 */ }
  return 'doodle';
}

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [sel, setSel] = useState<{ provider: string; model: string } | null>(null);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [activeTab, setActiveTab] = useState<MainTab>('chat');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [traceSteps, setTraceSteps] = useState<TraceStep[]>([]);
  const [traceStats, setTraceStats] = useState<{ trace: Record<string, number>; cache: Record<string, number>; l1Enabled: boolean } | null>(null);
  const [traceOpen, setTraceOpen] = useState(true);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [todos, setTodos] = useState<TodoCard[]>([]); // todo 插件：待办看板/模型 to do list（全量，按会话过滤展示）
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [brand, setBrand] = useState<Brand>(readBrand);
  // 会话状态感知（agent harness 前端特征）：断点可恢复 / 角色接管 / 成本熔断
  const [checkpoint, setCheckpoint] = useState<CheckpointInfo | null>(null);
  const [resuming, setResuming] = useState(false);
  const [budgetHit, setBudgetHit] = useState<{ cost: number; budget: number } | null>(null);
  // 会话累计成本（composer 区域实时显示：harness 管理认知资源的可见性）
  const [sessionCost, setSessionCost] = useState(0);
  // provider 重试的截断边界现在挂在消息自身（ChatMessage.retryFrom）——
  // 旧的并行 Record 会随会话数无限增长，且与消息生命周期不同步。
  // 前置重活（历史压缩等）的播报文本：让"开口前的十几秒"有话说，而不是干等
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  // 与后端的常驻事件连接状态：断了要看得见（旧版"实时"灯常亮，数据其实早就不动了）
  const [liveState, setLiveState] = useState<'open' | 'down'>('open');
  // 并行小队进度（parallel.progress 广播）：按会话归集，渲染成"小队"气泡上的进度行。
  // 旧版这个事件根本没进 SSE 白名单——用户只能干等 4 分钟超时后的汇总，全程没有回声。
  const [squad, setSquad] = useState<Record<string, { total: number; done: number; failed: number; running: Record<string, string> }>>({});
  // provider 健康提示去重（60s 窗口：同一 provider 连续失败不刷屏）
  const providerToastAtRef = useRef(new Map<string, number>());

  const abortRef = useRef<AbortController | null>(null);
  // 消息镜像 ref：retry 时刻同步读取（state 提交前也能拿到当前值）
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  // 会话镜像 ref：全局事件回调里判断"这条是不是当前会话的"（避免闭包捕获旧 activeId）
  const activeIdRef = useRef<string | null>(activeId);
  activeIdRef.current = activeId;
  // 本会话经历过的 traceId：轨迹面板据此只显示"这场对话"的步骤（旧版把别的会话的
  // trace.step 也混进来，你在 A 会话里看到 B 会话正在干什么）
  const traceIdsRef = useRef(new Set<string>());
  // 已提示过"审批超时作废"的审批 id（避免每秒重复插系统消息）
  const expiredNotifiedRef = useRef(new Set<string>());

  // ---- 流式文本 rAF 合帧缓冲 ----
  // SSE 每 chunk 一次 setState 会让 App 整树以 chunk 频率全量重渲染（长会话下明显卡顿）。
  // 增量先累积进缓冲，requestAnimationFrame 每帧只提交一次——渲染频率 ≤ 显示器刷新率，
  // 输入法/滚动等交互不再被流式输出抢占主线程。
  const pendingStreamRef = useRef<{ id: string; content: string; reasoning: string } | null>(null);
  const streamRafRef = useRef(0);

  const flushStreamBuffer = useCallback(() => {
    if (streamRafRef.current) { cancelAnimationFrame(streamRafRef.current); streamRafRef.current = 0; }
    const p = pendingStreamRef.current;
    if (!p) return;
    pendingStreamRef.current = null;
    setMessages((prev) => prev.map((m) => m.id === p.id
      ? { ...m, content: m.content + p.content, reasoning: (m.reasoning ?? '') + p.reasoning }
      : m));
  }, []);

  const queueStreamText = useCallback((id: string, patch: { content?: string; reasoning?: string }) => {
    const p = pendingStreamRef.current;
    if (p && p.id === id) {
      if (patch.content) p.content += patch.content;
      if (patch.reasoning) p.reasoning += patch.reasoning;
    } else {
      if (p) flushStreamBuffer(); // 换消息前冲刷旧缓冲（正常时序下不会发生）
      pendingStreamRef.current = { id, content: patch.content ?? '', reasoning: patch.reasoning ?? '' };
    }
    if (!streamRafRef.current) {
      streamRafRef.current = requestAnimationFrame(() => { streamRafRef.current = 0; flushStreamBuffer(); });
    }
  }, [flushStreamBuffer]);

  // 主题：写 dataset + localStorage + Sonner 主题同步（首帧由 main.tsx 预置，避免闪烁）
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.setAttribute('data-sonner-theme', theme);
    // 浏览器窗口 chrome（标题栏/状态栏）跟随明暗主题
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#161411' : '#f5eee0');
    applyFavicon(theme);
    try { localStorage.setItem('maharness-theme', theme); } catch { /* 忽略 */ }
  }, [theme]);

  // 品牌色板预设（与明暗正交）：写 dataset + localStorage，并让 favicon 取新主色
  useEffect(() => {
    document.documentElement.dataset.brand = brand;
    try { localStorage.setItem('maharness-brand', brand); } catch { /* 忽略 */ }
    applyFavicon(theme);
  }, [brand, theme]);

  // 供应商被删除后清理当前选择（防止已删除的 provider 残留在模型下拉/会话里）
  useEffect(() => {
    if (sel?.provider && !providers.some((p) => p.id === sel.provider)) {
      setSel(models.length ? splitModelId(models[0].id) : null);
    }
    // 仅在 providers 变化时校正；sel 变化不触发，避免抖动
  }, [providers]);

  // 初始加载
  useEffect(() => { void loadAll(); }, []);

  // 全局事件订阅：trace.step 仅在轨迹面板打开时入库——面板关闭时逐事件 setState
  // 会让整个 App 树空转重渲染（流式运行时每秒可达数十次）
  const traceOpenRef = useRef(traceOpen);
  traceOpenRef.current = traceOpen;
  useEffect(() => {
    const off = subscribeEvents((e: BusEvent) => {
      if (e.type === 'trace.step') {
        // 只收本会话的：/api/events 是全局广播，不过滤就会在 A 会话面板里看到 B 会话的步骤
        const step = e.data as TraceStep;
        if (!traceOpenRef.current || !traceIdsRef.current.has(step.traceId)) return;
        // upsert：同一 step 先来 running 帧、后来 settle 帧，原地覆盖而不是堆两条
        setTraceSteps((prev) => {
          const i = prev.findIndex((s) => s.id === step.id);
          if (i === -1) return [...prev.slice(-199), step];
          const next = prev.slice();
          next[i] = step;
          return next;
        });
      }
      else if (e.type === 'plan.updated') {
        // 计划同样按会话归属过滤：全局广播里别的会话的目标不该顶到你的窗口上
        const d = e.data as (PlanState & { sessionId?: string }) | null;
        if (d?.sessionId && activeIdRef.current && d.sessionId !== activeIdRef.current) return;
        setPlan(d);
      }
      else if (e.type === 'todo.updated') setTodos((e.data as { cards: TodoCard[] } | null)?.cards ?? []);
      else if (e.type === 'parallel.progress') {
        // 并行小队分头干活的进度：phase=start/done/fail + taskId/objective/total/sessionId
        const d = e.data as { phase: 'start' | 'done' | 'fail'; taskId: string; objective: string; sessionId?: string; total?: number };
        if (!d?.taskId) return;
        const sid = d.sessionId ?? activeIdRef.current ?? '';
        setSquad((prev) => {
          const cur = prev[sid] ?? { total: 0, done: 0, failed: 0, running: {} };
          const running = { ...cur.running };
          if (d.phase === 'start') running[d.taskId] = d.objective;
          else delete running[d.taskId];
          return {
            ...prev,
            [sid]: {
              total: d.total ?? cur.total,
              done: cur.done + (d.phase === 'done' ? 1 : 0),
              failed: cur.failed + (d.phase === 'fail' ? 1 : 0),
              running,
            },
          };
        });
      }
      else if (e.type === 'approval.requested') {
        // 子代理/并行任务的审批经全局事件广播（主执行器阻塞在子任务 handler 内，
        // 审批事件无法从其 SSE 流到达）；按 id 去重合并进统一审批列表。
        // sessionId/expiresAt 一并收下：刷新后卡片能回原位，也能显示"还剩几分钟"。
        const d = e.data as { approvalId: string; name: string; summary: string; sessionId?: string; createdAt?: number; expiresAt?: number };
        if (d?.approvalId) {
          setApprovals((prev) => (prev.some((a) => a.id === d.approvalId)
            ? prev
            : [...prev, { id: d.approvalId, name: d.name, summary: d.summary, sessionId: d.sessionId, createdAt: d.createdAt ?? Date.now(), expiresAt: d.expiresAt }]));
        }
      }
      else if (e.type === 'provider.error') {
        // Provider 健康回报（agent failover 链真实调用失败）：刷新健康标记 + 即时提示，
        // 不等整条链耗尽才发现。同类提示 60s 内去重（连续消息失败不刷屏）
        const d = e.data as { providerId: string; providerLabel: string; authFailed: boolean; error: string };
        if (!d?.providerId) return;
        const now = Date.now();
        const last = providerToastAtRef.current.get(d.providerId) ?? 0;
        if (now - last < 60_000) return;
        providerToastAtRef.current.set(d.providerId, now);
        void providersApi.list().then(setProviders).catch(() => undefined);
        if (d.authFailed) {
          toast.error(`这条线路的钥匙好像过期了（${d.providerLabel}），我已经换了一条接着陪你聊`);
          toast.warning('有空在「设置」里换一下新钥匙', { duration: 5000 });
        } else {
          toast.warning(`${d.providerLabel} 刚才没接上，我换了条线路再说一遍`);
        }
      }
      else if (e.type === 'provider.ok') {
        // Provider 恢复（key 换好后首次成功）：清除红标
        void providersApi.list().then(setProviders).catch(() => undefined);
      }
    }, setLiveState);
    return () => { off(); };
  }, []);

  // trace 统计轮询：只在轨迹面板可见时进行（关面板 = 零后台请求）
  useEffect(() => {
    if (!traceOpen || activeTab !== 'chat') return;
    void traceApi.stats().then(setTraceStats).catch(() => undefined);
    const t = setInterval(() => { void traceApi.stats().then(setTraceStats).catch(() => undefined); }, 2000);
    return () => clearInterval(t);
  }, [traceOpen, activeTab]);

  // ---- 审批：刷新后原位复原 + 到点自动撤卡 ----
  // 服务端共享 ApprovalBoard 才是权威：首屏与切会话都拉一次挂起清单，按 id 与本地合并
  // （本地没有的补上，服务端已不认的——已批/已撤/超时——本地也清掉）。
  // 旧版没有这个端点：刷新一次审批卡就消失，而服务端还在等，10 分钟后回填"用户拒绝了该操作"
  // ——用户看到的是"agent 卡了很久，然后说我拒绝了它"。
  const seedApprovals = useCallback(async () => {
    try {
      const r = await approvalsApi.list();
      const alive = new Set(r.pending.map((p) => p.id));
      setApprovals((prev) => {
        const merged = new Map(prev.filter((a) => alive.has(a.id)).map((a) => [a.id, a]));
        for (const p of r.pending) {
          if (!merged.has(p.id)) merged.set(p.id, { id: p.id, name: p.name, summary: p.summary, sessionId: p.sessionId, createdAt: p.createdAt, expiresAt: p.expiresAt });
        }
        return [...merged.values()];
      });
    } catch { /* 对话服务未就绪时忽略 */ }
  }, []);
  useEffect(() => { void seedApprovals(); }, [seedApprovals, activeId]);

  // 超时撤卡：服务端 10 分钟后自动拒绝，本地到点把卡撤掉并留一句人话
  // （不让用户对着一个已经作废的卡片继续点，然后纳闷为什么没反应）
  useEffect(() => {
    if (!approvals.length) return;
    const t = setInterval(() => {
      const now = Date.now();
      const expired = approvals.filter((a) => a.expiresAt && a.expiresAt <= now);
      if (!expired.length) return;
      setApprovals((prev) => prev.filter((a) => !(a.expiresAt && a.expiresAt <= now)));
      for (const a of expired) {
        if (expiredNotifiedRef.current.has(a.id)) continue;
        expiredNotifiedRef.current.add(a.id);
        if (!a.sessionId || a.sessionId === activeIdRef.current) {
          setMessages((m) => [...m, { id: `ap-exp-${a.id}`, role: 'system', content: sys.approvalExpired(a.name), ts: Date.now() }]);
        }
      }
    }, 1000);
    return () => clearInterval(t);
  }, [approvals]);

  // 次要视图 chunk 预取：首屏渲染完成后 idle 时拉取，首次切 Tab 无加载等待
  useEffect(() => {
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(preloadSecondaryViews, { timeout: 2500 });
      return () => window.cancelIdleCallback(id);
    }
    const t = window.setTimeout(preloadSecondaryViews, 1500);
    return () => window.clearTimeout(t);
  }, []);

  async function loadAll() {
    try {
      const [ss, ms, pl, pvs] = await Promise.all([sessionApi.list(), modelsApi.list(), pluginsApi.list(), providersApi.list()]);
      setSessions(ss);
      setModels(ms);
      setPlugins(pl);
      setProviders(pvs);
      if (ms.length) setSel((prev) => {
        if (prev) return prev;
        // 优先用第一个会话保存的 provider + model（如果该 provider 存在且该模型属于它）
        const firstSession = ss[0];
        if (firstSession?.provider && firstSession.model) {
          const m = ms.find((x) => x.provider === firstSession.provider && x.model === firstSession.model);
          if (m) return { provider: m.provider, model: m.model };
          const any = ms.find((x) => x.provider === firstSession.provider);
          if (any) return { provider: any.provider, model: any.model };
        }
        return splitModelId(ms[0].id);
      });
      let initialId: string | null = null;
      if (!ss.length) {
        const created = await sessionApi.create(ms[0]?.model ?? '');
        setSessions([created]);
        initialId = created.id;
      } else {
        initialId = ss[0].id;
      }
      // 初始会话：同步加载历史消息，避免首屏空白
      setActiveId(initialId);
      if (initialId) {
        try {
          const [msgs, pl] = await Promise.all([sessionApi.messages(initialId), planApi.get(initialId).catch(() => null)]);
          setMessages(replayMessages(msgs));
          setPlan(pl?.plan ?? null);
          setSessionCost(msgs.reduce((s, m) => s + (m.cost ?? 0), 0));
        } catch { /* 忽略 */ }
      }
    } catch (err) {
      console.error('[maharness] 初始加载失败:', err);
      toast.error(`初始加载失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const selectSession = useCallback(async (id: string) => {
    setActiveId(id);
    setMessages([]);
    setTraceSteps([]);
    traceIdsRef.current = new Set();   // 换会话 = 换 trace 域：旧会话的步骤不再串进面板
    setStreamStatus(null);
    setPlan(null);
    setCheckpoint(null);
    setBudgetHit(null);
    setSessionCost(0);
    try {
      const [msgs, cp, pl] = await Promise.all([
        sessionApi.messages(id),
        sessionApi.checkpoint(id).catch(() => null),
        // 计划活在插件内存里、只经事件推送：刷新/切会话时主动拉一次，卡片立刻回来
        planApi.get(id).catch(() => null),
      ]);
      setMessages(replayMessages(msgs));
      setCheckpoint(cp);
      setPlan(pl?.plan ?? null);
      setSessionCost(msgs.reduce((s, m) => s + (m.cost ?? 0), 0));
    } catch (err) {
      toast.error(`这段聊天没能打开：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [toast]);

  const createSession = useCallback(async () => {
    try {
      const s = await sessionApi.create(sel?.model ?? '');
      setSessions((prev) => [s, ...prev]);
      setActiveId(s.id);
      setMessages([]);
      setTraceSteps([]);
      setPlan(null);
      setCheckpoint(null);
      setBudgetHit(null);
      setSessionCost(0);
      toast.success('已创建新会话');
    } catch (err) {
      toast.error(`新建会话失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [sel, toast]);

  const deleteSession = useCallback(async (id: string) => {
    try {
      await sessionApi.remove(id);
    } catch (err) {
      toast.error(`删除会话失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    toast.success('会话已删除');
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (activeId === id) {
        if (next.length) void selectSession(next[0].id);
        else { setActiveId(null); setMessages([]); }
      }
      return next;
    });
  }, [activeId, selectSession, toast]);

  const archiveSession = useCallback(async (id: string, archived: boolean) => {
    try {
      await sessionApi.update(id, { archived });
      setSessions(await sessionApi.list());
      toast.success(archived ? '会话已归档' : '会话已取消归档');
    } catch (err) {
      toast.error(`归档操作失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [toast]);

  const pinSession = useCallback(async (id: string, pinned: boolean) => {
    try {
      await sessionApi.update(id, { pinned });
      setSessions(await sessionApi.list());
      toast.success(pinned ? '会话已置顶' : '会话已取消置顶');
    } catch (err) {
      toast.error(`置顶操作失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [toast]);

  /** 批量删除（后端事务原子批量接口） */
  const batchDelete = useCallback(async (ids: string[]) => {
    if (!ids.length) return;
    try {
      const r = await sessionApi.batchRemove(ids);
      setSessions(await sessionApi.list());
      if (activeId && ids.includes(activeId)) {
        const next = sessions.filter((s) => !ids.includes(s.id));
        if (next.length) void selectSession(next[0].id);
        else { setActiveId(null); setMessages([]); setTraceSteps([]); setPlan(null); }
      }
      toast.success(`已删除 ${r.removed ?? ids.length} 个会话`);
    } catch (err) {
      toast.error(`批量删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [activeId, sessions, selectSession, toast]);

  /** 批量归档（未归档的标记归档） */
  const batchArchive = useCallback(async (ids: string[]) => {
    if (!ids.length) return;
    try {
      for (const id of ids) await sessionApi.update(id, { archived: true });
      setSessions(await sessionApi.list());
      toast.success(`已归档 ${ids.length} 个会话`);
    } catch (err) {
      toast.error(`批量归档失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [toast]);

  const renameSession = useCallback(async (id: string, title: string) => {
    const t = title.trim();
    if (!t) return;
    try {
      await sessionApi.rename(id, t);
      setSessions(await sessionApi.list());
      toast.success('会话已重命名');
    } catch (err) {
      toast.error(`重命名失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [toast]);

  const setSessionMode = useCallback(async (mode: string) => {
    if (!activeId) return;
    try {
      await sessionApi.update(activeId, { mode });
      setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, mode } : s));
      const label = mode === 'plan' ? '计划模式' : mode === 'goal' ? '目标模式' : '普通模式';
      toast.success(`已切换到${label}`);
    } catch (err) {
      toast.error(`切换模式失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [activeId, toast]);

  const selectModel = useCallback(async (id: string) => {
    // 兼容两种 key：新格式 `provider@model`；旧格式纯 provider id（浏览器缓存旧 UI 时）
    let x = splitModelId(id);
    if (!x.model) {
      const first = models.find((m) => m.provider === id || m.id === id);
      if (!first) return;
      x = { provider: first.provider, model: first.model };
    }
    setSel(x);
    if (activeId) {
      try {
        await sessionApi.update(activeId, { model: x.model, provider: x.provider });
      }
      catch (err) { toast.error(`模型切换失败：${err instanceof Error ? err.message : String(err)}`); }
    }
  }, [models, activeId, toast]);

  const pluginAction = useCallback(async (id: string, action: 'enable' | 'disable' | 'reload' | 'uninstall') => {
    try {
      const r = await pluginsApi.action(id, action);
      setPlugins(await pluginsApi.list());
      const label = action === 'enable' ? '已启用' : action === 'disable' ? '已停用' : action === 'uninstall' ? '已卸载' : '已重载';
      toast.success(`${label}（${id} · ${r.state}）`);
    } catch (err) {
      const label = action === 'enable' ? '启用' : action === 'disable' ? '停用' : action === 'uninstall' ? '卸载' : '重载';
      toast.error(`插件${label}失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [toast]);

  const refreshProviders = useCallback(async () => {
    try {
      setProviders(await providersApi.list());
      setModels(await modelsApi.list());
    } catch (err) {
      toast.error(`刷新 Provider 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [toast]);

  /** 流式回复处理器（send 与断点续跑共用；文本增量经 rAF 合帧批量提交）
   *  实时路径刻意产出与 replayMessages() 完全相同的形状：开始办事的那几轮文本挪进
   *  narration（旁白）、工具卡带 tool_call_id、「加入了群聊」交给渲染期派生——
   *  于是「刷新一次还是这场对话」，而不是换副面孔（旧的空气泡就是这么来的）。 */
  const makeStreamHandlers = useCallback((assistantId: string) => ({
    onStart: (traceId: string) => {
      if (traceId) traceIdsRef.current.add(traceId);
      // 新一轮开始：清掉上一轮的小队进度（否则"2/4"会挂在新对话上）
      const sid = activeIdRef.current ?? '';
      setSquad((prev) => ({ ...prev, [sid]: { total: 0, done: 0, failed: 0, running: {} } }));
    },
    onDelta: (t: string) => queueStreamText(assistantId, { content: t }),
    onReasoning: (t: string) => queueStreamText(assistantId, { reasoning: t }),
    onStatus: (text: string) => setStreamStatus(text),
    onToolStart: (id: string | undefined, name: string, args: unknown) => {
      flushStreamBuffer();
      setStreamStatus(null);
      setMessages((prev) => prev.map((m) => {
        if (m.id !== assistantId) return m;
        // 这一轮转去办事了：此前流出的文本是说给它自己听的旁白，从正文挪走
        // （旧行为是让它留在正文里、最后被 done 的全文整体替换——
        //  用户会看见对方先冒出一串英文工作日志、说完又被抽走）
        const said = m.content.slice(m.retryFrom ?? 0).trim();
        return {
          ...m,
          narration: said ? [...(m.narration ?? []), said] : m.narration,
          content: '',
          retryFrom: undefined,
          tools: [...(m.tools ?? []), { id, name, args, status: 'running' as const, startedAt: Date.now() }],
        };
      }));
    },
    onToolResult: (id: string | undefined, name: string, summary: string, ok: boolean, stored?: boolean) => {
      flushStreamBuffer();
      setMessages((prev) => prev.map((m) => m.id === assistantId ? {
        ...m, tools: (m.tools ?? []).map((t) => t.status === 'running' && (t.id ? t.id === id : t.name === name) ? {
          ...t, summary, ok, stored, status: ok ? 'done' as const : 'error' as const, durationMs: Date.now() - (t.startedAt ?? Date.now()),
        } : t),
      } : m));
    },
    onApprovalRequired: (id: string, name: string, summary: string) => setApprovals((prev) => prev.some((a) => a.id === id) ? prev : [...prev, { id, name, summary }]),
    onHandoff: (role: string, objective: string) => {
      // 角色移交：消息流插入系统通知；会话角色由后端持久化（刷新列表同步）
      flushStreamBuffer();
      setMessages((prev) => [...prev, { id: `ho-${Date.now()}`, role: 'system', content: sys.handoff(role, objective), ts: Date.now() }]);
      void sessionApi.list().then(setSessions).catch(() => undefined);
    },
    onBudgetHit: (cost: number, budget: number) => {
      // 成本熔断：横幅展示（harness 硬边界）
      setBudgetHit({ cost, budget });
    },
    onRetry: (reason: 'attempt' | 'failover' | 'narration', detail?: string) => {
      // provider 重试/换线路：截断边界记在消息上（含未冲刷增量），从该边界重新累积。
      // 同时把"刚才那次作废了"说出来——否则用户看到的是说过的话被一口气擦掉。
      const p = pendingStreamRef.current;
      const base = messagesRef.current.find((m) => m.id === assistantId);
      const pending = p?.id === assistantId ? p : null;
      const cutContent = (base?.content.length ?? 0) + (pending?.content.length ?? 0);
      const cutReasoning = (base?.reasoning?.length ?? 0) + (pending?.reasoning.length ?? 0);
      setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, retryFrom: cutContent, retryFromReasoning: cutReasoning } : m));
      setStreamStatus(detail || (reason === 'failover' ? '这条线路没接通，换一个再说一遍…' : '刚才那下没接上，我再说一遍…'));
    },
    onDone: (d: { content: string; reasoning?: string; usage: { input: number; output: number }; cost: number; cached?: boolean }) => {
      flushStreamBuffer();
      setStreamStatus(null);
      setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, content: d.content, reasoning: d.reasoning ?? m.reasoning, streaming: false, usage: d.usage, cost: d.cost, cached: d.cached } : m));
      setSessionCost((prev) => prev + (d.cost ?? 0));
    },
    onError: (e: string, kind?: ErrorKind) => {
      flushStreamBuffer(); // 失败前已生成的部分内容保留可见
      setStreamStatus(null);
      const gentle = kind === 'aborted' || kind === 'busy';
      const he = humanizeError(e, kind);
      setMessages((prev) => prev.map((m) => m.id === assistantId ? {
        ...m,
        streaming: false,
        // 用户自己按的停止：留一条温和的话，而不是把取消说成故障
        stopped: kind === 'aborted' ? true : m.stopped,
        error: gentle ? (kind === 'busy' ? he.text : undefined) : (he.text || e),
        errorRaw: gentle ? undefined : e,
        // 停止时正在说的那半句已经流出去了——归位到旁白，别让它凭空消失
        ...(kind === 'aborted' ? { narration: (m.content.trim() ? [...(m.narration ?? []), m.content.trim()] : m.narration), content: '' } : {}),
      } : m));
      if (!gentle && he.severe) toast.error(he.text);
      if (!gentle && he.hint) toast.warning(he.hint);
      // 错误结束（如超轮数/熔断/连接中断）→ 同步断点：未完成任务保留「继续任务」入口；
      // 同时复位全局 streaming——错误路径可能没有后续 'end' 事件（传输层断开），
      // 不复位则输入区与停止按钮锁死在 streaming 状态
      setStreaming(false);
      if (activeId) void sessionApi.checkpoint(activeId).then(setCheckpoint).catch(() => undefined);
    },
    onEnd: () => {
      flushStreamBuffer();
      setStreamStatus(null);
      setStreaming(false);
      // 任务正常完成 → 后端已清除断点
      setCheckpoint(null);
      setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, updatedAt: Date.now() } : s));
    },
  }), [activeId, queueStreamText, flushStreamBuffer, toast]);

  const send = useCallback(async (text: string) => {
    if (!activeId || !text.trim() || streaming) return;

    if (text.trim().startsWith('/')) {
      const systemMsg = (content: string) => setMessages((prev) => [...prev, { id: `cmd-${Date.now()}`, role: 'system', content, ts: Date.now() }]);
      try {
        const r = await commandsApi.exec(text.trim(), activeId);
        if (r.type === 'message') {
          systemMsg(r.data?.text ?? '');
        } else if (r.type === 'action') {
          const a = r.data?.action;
          if (a === 'new_session') await createSession();
          else if (a === 'clear') { setMessages([]); systemMsg(sys.cleared); }
          else if (a === 'set_mode') {
            const mode = r.data?.mode ?? 'normal';
            setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, mode } : s));
            systemMsg(sys.modeSet(mode === 'plan' ? '计划模式' : mode === 'goal' ? '目标模式' : '普通聊天'));
          } else if (a === 'set_model') {
            setSel({ provider: r.data?.provider ?? '', model: r.data?.model ?? '' });
            systemMsg(sys.modelSet(r.data?.model ?? ''));
          }
        } else if (!r.ok) {
          systemMsg(sys.commandFailed(r.error ?? '说不清为什么'));
        }
      } catch (err) {
        systemMsg(sys.commandFailed(err instanceof Error ? err.message : String(err)));
      }
      return;
    }

    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: 'user', content: text, ts: Date.now() };
    const assistantMsg: ChatMessage = { id: `a-${Date.now()}`, role: 'assistant', content: '', streaming: true, tools: [], narration: [], ts: Date.now() };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStreaming(true);
    const ac = new AbortController();
    abortRef.current = ac;

    // provider 一并上送：两个 provider 有同名模型时，服务端按 provider 优先解析才不会答错人
    await streamChat(activeId, { message: text, model: sel?.model ?? '', provider: sel?.provider ?? '' }, makeStreamHandlers(assistantMsg.id), ac.signal);

    try { setSessions(await sessionApi.list()); } catch { /* 会话列表刷新失败不影响本次回复 */ }
  }, [activeId, sel, streaming, createSession, makeStreamHandlers]);

  /** 断点续跑（checkpoint）：从上次中断的轮次继续，复用完整对话流程 */
  const resumeTask = useCallback(async () => {
    if (!activeId || streaming || resuming) return;
    const cp = checkpoint;
    if (!cp?.exists) return;
    setResuming(true);
    // 恢复期间置全局 streaming：输入区防重入（可再点发送会撞服务端 409）与
    // 停止按钮可用——恢复任务同样可被用户中断
    setStreaming(true);
    const assistantMsg: ChatMessage = { id: `a-${Date.now()}`, role: 'assistant', content: '', streaming: true, tools: [], narration: [], ts: Date.now() };
    setMessages((prev) => [...prev, { id: `cp-${Date.now()}`, role: 'system', content: sys.resumed, ts: Date.now() }, assistantMsg]);
    setCheckpoint(null);
    const ac = new AbortController();
    abortRef.current = ac;
    await streamChat(activeId, { resume: true, model: sel?.model ?? '', provider: sel?.provider }, makeStreamHandlers(assistantMsg.id), ac.signal);
    setResuming(false);
    try {
      const cp2 = await sessionApi.checkpoint(activeId).catch(() => null);
      setCheckpoint(cp2); // 恢复后若再次中断（如熔断），断点仍可继续
      setSessions(await sessionApi.list());
    } catch { /* 忽略 */ }
  }, [activeId, streaming, resuming, checkpoint, sel, makeStreamHandlers]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    // 立刻就地留话：不等服务端的 error 事件（连接已断，事件多半到不了）。
    // 旧行为是留下一个空白气泡 + 一句红字「连接中断」——明明是自己按的停止。
    setMessages((prev) => prev.map((m) => m.streaming
      ? {
        ...m,
        streaming: false,
        stopped: true,
        error: undefined,
        narration: (m.content.trim() ? [...(m.narration ?? []), m.content.trim()] : m.narration),
        content: '',
      }
      : m));
    setStreamStatus(null);
    setStreaming(false);
    // 中断后同步断点状态：任务未完成 → 立即显示「继续任务」横幅（无需刷新页面）
    if (activeId) void sessionApi.checkpoint(activeId).then(setCheckpoint).catch(() => undefined);
  }, [activeId]);

  const respondApproval = useCallback(async (id: string, approved: boolean) => {
    try {
      await approvalsApi.respond(id, approved);
      toast.success(approved ? '已批准执行' : '已拒绝');
    } catch {
      toast.error('审批已过期或无效');
    }
    setApprovals((prev) => prev.filter((a) => a.id !== id));
  }, [toast]);

  // 稳定引用回调：配合 memo 化的 Sidebar/TracePanel，流式渲染期间跳过无关子树 reconcile
  const handleRoleReset = useCallback(async () => {
    if (!activeId) return;
    try {
      await sessionApi.update(activeId, { role: '' });
      setSessions(await sessionApi.list());
      toast.success('会话已交回主代理');
    } catch (err) {
      toast.error(`移交失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [activeId, toast]);

  const refreshTraceStats = useCallback(() => {
    void traceApi.stats().then(setTraceStats).catch(() => undefined);
  }, []);

  const toggleSettings = useCallback(() => setSettingsOpen((v) => !v), []);

  const currentSession = sessions.find((s) => s.id === activeId);
  // 微信群聊隐喻：会话头显示成员数（maharness + 你 + 已入群的子代理）
  const groupMembers = useMemo(() => collectMembers(messages), [messages]);
  // 活的状态：会话头实时显示 agent 正在忙什么（像朋友的微信签名）
  const runningTool = useMemo(() => {
    for (const m of messages) {
      for (const t of m.tools ?? []) if (t.status === 'running') return t;
    }
    return null;
  }, [messages]);
  const activity = runningTool ? toolActivityLabel(runningTool.name) : null;

  // 切到后台：新消息提醒（标题角标 + 轻响，回前台恢复）
  const baseTitleRef = useRef(document.title);
  const notifiedRef = useRef(false);
  useEffect(() => {
    if (streaming && document.hidden && !notifiedRef.current) {
      document.title = `【新消息】${baseTitleRef.current}`;
      notifiedRef.current = true;
      dingOnce();
    }
  }, [streaming, messages.length]);
  useEffect(() => {
    const onVis = () => {
      if (!document.hidden) {
        document.title = baseTitleRef.current;
        notifiedRef.current = false;
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // 拍一拍（双击头像）：前端彩蛋，不耗 LLM—— warmth 来自被回应的感觉
  const pushSystem = useCallback((content: string) => {
    setMessages((prev) => [...prev, { id: `sys-${Date.now()}`, role: 'system', content, ts: Date.now() }]);
  }, []);

  // 气泡长按菜单「删除」：仅从当前视图移除（服务端记录保留，重进会话即还原）
  const removeMessage = useCallback((id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);
  const pluginRunning = plugins.filter((p) => p.state === 'started' || p.state === 'loaded').length;
  const modeLabel = currentSession?.mode === 'plan' ? '计划模式' : currentSession?.mode === 'goal' ? '目标模式' : '普通模式';
  const modeColor = currentSession?.mode === 'plan' ? 'var(--purple)' : currentSession?.mode === 'goal' ? 'var(--orange)' : 'var(--text-3)';
  const selModel = sel ? models.find((m) => m.id === `${sel.provider}@${sel.model}`) : undefined;
  const modelLabel = selModel ? `${selModel.label} · ${selModel.model}` : (sel?.model ? `${sel.provider} · ${sel.model}` : '');
  const modelTag = selModel?.model ?? sel?.model ?? '';
  // 当前 provider 密钥失效（健康回报）：会话横幅即时提示，不等 failover 链耗尽
  const activeProvider = sel?.provider ? providers.find((p) => p.id === sel.provider) : undefined;
  const providerAuthFailed = activeProvider?.health?.authFailed
    ? { label: activeProvider.label, lastError: activeProvider.health.lastError }
    : null;
  const modeItems = [
    { key: 'normal', label: '普通模式', sub: '自由对话', dot: 'var(--text-3)' },
    { key: 'plan', label: '计划模式', sub: '先出计划再执行', dot: 'var(--purple)' },
    { key: 'goal', label: '目标模式', sub: '以目标驱动多轮', dot: 'var(--orange)' },
  ];

  // ---- 插件贡献的标签页（声明式）：遍历 /api/nav 生成导航 ----
  // 插件在 plugin.json 声明 nav 即在前端拥有自己的一页；插件停用/热重载中，
  // 服务端不再列出它（navContributions 只列 started 插件）→ 标签自动消失，
  // 正停留在该页时回落到会话页。前端不认识任何插件，新增插件页面无需改前端。
  const [pluginNav, setPluginNav] = useState<PluginNavItem[]>([]);
  // 是否已成功取过一次导航：只有成功过，才能把「列表里没有」解读为「插件真的下线了」。
  // 否则瞬时失败（后端重启/热重载中）会把 activeTab 误判为失效而打回会话页。
  const navLoaded = useRef(false);
  const refreshNav = useCallback(() => {
    navApi.list()
      .then((r) => {
        navLoaded.current = true;
        setPluginNav([...r.items].sort((a, b) => b.order - a.order));
      })
      // 失败时保留上一次已知的导航：宁可让标签短暂陈旧，也不能因一次失败把用户
      // 从插件页踢回会话页（「插件页闪一下就没」的根因就是这里清空列表）
      .catch(() => undefined);
  }, []);
  useEffect(() => { refreshNav(); }, [refreshNav, plugins]);
  const pluginTabs = useMemo(
    () => pluginNav.map((n) => ({ key: n.key, label: n.label, icon: pluginIcon(n.icon) })),
    [pluginNav],
  );
  useEffect(() => {
    // 当前标签页的贡献者确实不在了（插件被停用/卸载）→ 回落到会话页，不留死页面。
    // 必须等成功取过一次导航才判定，避免把「还没加载/取失败」误当「插件没了」。
    if (!navLoaded.current) return;
    if (typeof activeTab === 'string' && activeTab.startsWith('plugin:')
      && !pluginNav.some((n) => n.key === activeTab)) {
      setActiveTab('chat');
    }
  }, [pluginNav, activeTab]);
  const activePluginNav = pluginNav.find((n) => n.key === activeTab) ?? null;

  const onTab = useCallback((t: MainTab) => {
    setActiveTab(t);
    setSettingsOpen(false);
  }, []);

  // Suspense 兜底（lazy 视图 chunk 加载间隙）：与设计系统一致的极简加载态。
  // 注意：边界必须包在 AnimatePresence 外面——mode="wait" 不支持会挂起的新子树
  // （挂起会卡住交换，旧视图停留在透明退出态，内容"消失"）
  const viewFallback = (
    <div className="view-loading" aria-busy="true">
      <span className="spin" style={{ color: 'var(--accent)' }} />
      <span>加载中…</span>
    </div>
  );

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        activeTab={activeTab}
        onTab={onTab}
        pluginTabs={pluginTabs}
        onSelect={selectSession}
        onCreate={createSession}
        onDelete={deleteSession}
        onArchive={archiveSession}
        onPin={pinSession}
        onRename={renameSession}
        onBatchDelete={batchDelete}
        onBatchArchive={batchArchive}
        settingsOpen={settingsOpen}
        onToggleSettings={toggleSettings}
        pluginRunning={pluginRunning}
        streamingId={streaming ? activeId : null}
        version={APP_VERSION}
      />

      <main className="main">
        <header className={`topbar ${activeTab === 'chat' ? 'wx-chat-header' : ''}`}>
          {activeTab === 'chat' ? (
            <div className="wx-header-center" key="wx-center">
              <span className="wx-header-title">{currentSession?.title ?? '新会话'}</span>
              {/* 会话头只有一处状态字（气泡里不再重复"正在输入"）；断线时优先报断线 */}
              {liveState === 'down' ? (
                <span className="wx-header-sub off"><span className="wx-offline-dot" />{sys.offline}</span>
              ) : streaming ? (
                <span className="wx-header-sub run">{activity ?? streamStatus ?? sys.started}</span>
              ) : groupMembers.length ? (
                <span className="wx-header-sub"><span className="wx-online-dot" />群聊 · {groupMembers.length} 位帮手在群里</span>
              ) : (
                <span className="wx-header-sub"><span className="wx-online-dot" />{AGENT_NAME} · 在线</span>
              )}
            </div>
          ) : (
            <div className="topbar-left">
              <div className="crumb">
                <span className="prev">{AGENT_ID}</span>
                <span className="sep">/</span>
                <span className="cur">{activeTab === 'files' ? '文件工作区' : activePluginNav ? activePluginNav.pluginName : activeTab === 'plugins' ? '插件管理' : '缓存与成本'}</span>
              </div>
            </div>
          )}
          <div className="topbar-right">
            {activeTab === 'chat' && (
              <>
                <Menu
                  trigger={<><span className="mode-dot" style={{ background: modeColor }} />{modeLabel}<IconChevronDown size={11} /></>}
                  items={modeItems}
                  selectedKey={currentSession?.mode ?? 'normal'}
                  onSelect={(k) => void setSessionMode(k)}
                  title="会话模式"
                  width={220}
                  triggerTitle="会话模式"
                />
                <Menu
                  trigger={<>{modelLabel || '未选择模型'}<IconChevronDown size={11} /></>}
                  items={models.map((m) => ({ key: m.id, label: m.label, sub: m.model }))}
                  selectedKey={sel ? `${sel.provider}@${sel.model}` : undefined}
                  onSelect={(k) => void selectModel(k)}
                  title="切换模型"
                  width={280}
                  triggerTitle="切换模型"
                  disabled={models.length === 0}
                />
                <button
                  className={`tb-icon-btn ${traceOpen ? 'active' : ''}`}
                  onClick={() => setTraceOpen((v) => !v)}
                  title="运行轨迹面板"
                  aria-label="运行轨迹面板"
                >
                  {traceOpen ? <IconClose size={14} /> : <IconPanel size={15} />}
                </button>
              </>
            )}
            {activeTab !== 'chat' && (
              <span className={`tb-live ${liveState === 'down' ? 'off' : ''}`} title={liveState === 'down' ? sys.offline : '与后端的实时事件通道正常'}>
                <span className="live-dot" />{liveState === 'down' ? '重连中' : '实时'}
              </span>
            )}
          </div>
        </header>

        <Suspense fallback={viewFallback}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            className="tab-content"
            key={settingsOpen ? 'settings' : activeTab}
            variants={pageVariants}
            initial="initial"
            animate="enter"
            exit="exit"
          >
          {settingsOpen ? (
            <SettingsView providers={providers} onChanged={refreshProviders} theme={theme} onThemeChange={setTheme} brand={brand} onBrandChange={setBrand} />
          ) : activeTab === 'chat' ? (
            <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <ChatView
                  messages={messages}
                  streaming={streaming}
                  onSend={send}
                  onStop={stop}
                  hasModels={models.length > 0}
                  approvals={approvals.filter((a) => !a.sessionId || a.sessionId === activeId)}
                  onApproval={respondApproval}
                  plan={plan}
                  todos={todos.filter((t) => !t.sessionId || t.sessionId === currentSession?.id)}
                  modelLabel={modelLabel}
                  modelTag={modelTag}
                  models={models}
                  onSelectModel={(k) => void selectModel(k)}
                  selectedModelId={sel ? `${sel.provider}@${sel.model}` : undefined}
                  // 前置重活（历史压缩/换线路）的播报：气泡里显示"它正在做什么"
                  streamStatus={streamStatus}
                  // 并行小队进度（parallel.progress）：挂在"小队"成员气泡上
                  squad={squad[activeId ?? '']}
                  // 会话状态感知（agent harness 前端特征）：断点恢复 / 角色接管 / 成本熔断 / 会话成本
                  checkpoint={checkpoint}
                  onResume={() => void resumeTask()}
                  resuming={resuming}
                  role={currentSession?.role}
                  onRoleReset={handleRoleReset}
                  budgetHit={budgetHit}
                  sessionCost={sessionCost}
                  onSystemMsg={pushSystem}
                  sessionKey={activeId ?? undefined}
                  onRemoveMessage={removeMessage}
                  providerAuthFailed={providerAuthFailed}
                  onOpenSettings={() => { setActiveTab('chat'); setSettingsOpen(true); }}
                />
              </div>
              {traceOpen && (
                <aside className="trail-panel">
                  <TracePanel
                    steps={traceSteps}
                    stats={traceStats}
                    onRefresh={refreshTraceStats}
                  />
                </aside>
              )}
            </div>
          ) : activeTab === 'files' ? (
            <FilesView />
          ) : activeTab === 'plugins' ? (
            <PluginsView plugins={plugins} onAction={pluginAction} />
          ) : activePluginNav ? (
            /* 插件贡献的页面：通用容器渲染（iframe 完整页 / panel 片段），前端零插件知识。
               key 绑定插件 id：切换插件标签时强制重建容器与 iframe（否则 React 复用同一
               iframe 节点、浏览器保留旧 src，出现「标签已切、页面还是上一个插件」） */
            <PluginTabView key={activePluginNav.key} item={activePluginNav} />
          ) : (
            <StatsView />
          )}
          </motion.div>
        </AnimatePresence>
        </Suspense>
      </main>

      <Toaster
        theme={theme}
        richColors
        position="bottom-right"
        gap={8}
        visibleToasts={4}
        toastOptions={{
          style: {
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            color: 'var(--text-1)',
            fontFamily: 'var(--font-sans)',
            fontSize: '12.5px',
            boxShadow: 'var(--shadow-pop)',
          },
          classNames: {
            success: 'sonner-toast-success',
            error: 'sonner-toast-error',
            info: 'sonner-toast-info',
          },
        }}
      />
    </div>
  );
}
