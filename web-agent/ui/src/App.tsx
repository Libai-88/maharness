// ui/src/App.tsx —— 主布局（Screen 1–8 导航枢纽）
import { useCallback, useEffect, useRef, useState } from 'react';
import { approvalsApi, commandsApi, modelsApi, pluginsApi, providersApi, sessionApi, streamChat, subscribeEvents, traceApi } from './api';
import type { ApprovalItem, BusEvent, ChatMessage, CheckpointInfo, ModelInfo, PlanState, PluginInfo, ProviderInfo, Session, TodoCard, TraceStep } from './types';
import Sidebar from './components/Sidebar';
import type { MainTab } from './components/Sidebar';
import ChatView from './components/ChatView';
import TracePanel from './components/TracePanel';
import FilesView from './components/FilesView';
import PluginsView from './components/PluginsView';
import StatsView from './components/StatsView';
import SettingsView from './components/SettingsView';
import Menu from './components/Menu';
import { IconChevronDown, IconClose, IconPanel } from './components/Icon';
import { useToast } from './components/Toast';

export type Theme = 'dark' | 'light';

function readTheme(): Theme {
  try { return localStorage.getItem('maharness-theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
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
  // 会话状态感知（agent harness 前端特征）：断点可恢复 / 角色接管 / 成本熔断
  const [checkpoint, setCheckpoint] = useState<CheckpointInfo | null>(null);
  const [resuming, setResuming] = useState(false);
  const [budgetHit, setBudgetHit] = useState<{ cost: number; budget: number } | null>(null);
  // 会话累计成本（composer 区域实时显示：harness 管理认知资源的可见性）
  const [sessionCost, setSessionCost] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const toast = useToast();

  // 主题：写 dataset + localStorage（首帧由 main.tsx 预置，避免闪烁）
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('maharness-theme', theme); } catch { /* 忽略 */ }
  }, [theme]);

  // 初始加载
  useEffect(() => { void loadAll(); }, []);
  useEffect(() => {
    const off = subscribeEvents((e: BusEvent) => {
      if (e.type === 'trace.step') setTraceSteps((prev) => [...prev.slice(-199), e.data as TraceStep]);
      else if (e.type === 'plan.updated') setPlan(e.data as PlanState | null);
      else if (e.type === 'todo.updated') setTodos((e.data as { cards: TodoCard[] } | null)?.cards ?? []);
    });
    const t = setInterval(() => { void traceApi.stats().then(setTraceStats).catch(() => undefined); }, 2000);
    return () => { off(); clearInterval(t); };
  }, []);

  async function loadAll() {
    try {
      const [ss, ms, pl, pvs] = await Promise.all([sessionApi.list(), modelsApi.list(), pluginsApi.list(), providersApi.list()]);
      setSessions(ss);
      setModels(ms);
      setPlugins(pl);
      setProviders(pvs);
      if (ms.length) setSel((prev) => prev ?? { provider: ms[0].id, model: ms[0].model });
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
          const msgs = await sessionApi.messages(initialId);
          setMessages(msgs.map((m) => ({ id: m.id, role: m.role === 'user' ? 'user' : 'assistant', content: m.content ?? '', reasoning: m.reasoning })));
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
    setPlan(null);
    setCheckpoint(null);
    setBudgetHit(null);
    setSessionCost(0);
    try {
      const [msgs, cp] = await Promise.all([sessionApi.messages(id), sessionApi.checkpoint(id).catch(() => null)]);
      setMessages(msgs.map((m) => ({ id: m.id, role: m.role === 'user' ? 'user' : 'assistant', content: m.content ?? '', reasoning: m.reasoning })));
      setCheckpoint(cp);
      setSessionCost(msgs.reduce((s, m) => s + (m.cost ?? 0), 0));
    } catch (err) {
      toast.error(`加载会话失败：${err instanceof Error ? err.message : String(err)}`);
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
    const m = models.find((x) => x.id === id);
    if (!m) return;
    setSel({ provider: m.id, model: m.model });
    if (activeId) {
      try { await sessionApi.update(activeId, { model: m.model }); }
      catch (err) { toast.error(`模型切换失败：${err instanceof Error ? err.message : String(err)}`); }
    }
  }, [models, activeId, toast]);

  const pluginAction = useCallback(async (id: string, action: 'enable' | 'disable' | 'reload') => {
    try {
      const r = await pluginsApi.action(id, action);
      setPlugins(await pluginsApi.list());
      const label = action === 'enable' ? '已启用' : action === 'disable' ? '已停用' : '已重载';
      toast.success(`${label}（${id} · ${r.state}）`);
    } catch (err) {
      toast.error(`插件${action === 'enable' ? '启用' : action === 'disable' ? '停用' : '重载'}失败：${err instanceof Error ? err.message : String(err)}`);
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

  const send = useCallback(async (text: string) => {
    if (!activeId || !text.trim() || streaming) return;

    if (text.trim().startsWith('/')) {
      const systemMsg = (content: string) => setMessages((prev) => [...prev, { id: `cmd-${Date.now()}`, role: 'system', content }]);
      try {
        const r = await commandsApi.exec(text.trim(), activeId);
        if (r.type === 'message') {
          systemMsg(r.data?.text ?? '');
        } else if (r.type === 'action') {
          const a = r.data?.action;
          if (a === 'new_session') await createSession();
          else if (a === 'clear') setMessages([]);
          else if (a === 'set_mode') {
            const mode = r.data?.mode ?? 'normal';
            setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, mode } : s));
            systemMsg(`已切换到${mode === 'plan' ? '计划模式' : mode === 'goal' ? '目标模式' : '普通模式'}（影响后续对话）`);
          } else if (a === 'set_model') {
            setSel({ provider: r.data?.provider ?? '', model: r.data?.model ?? '' });
            systemMsg(`模型已切换：${r.data?.model ?? ''}`);
          }
        } else if (!r.ok) {
          systemMsg(`⚠ ${r.error ?? '命令执行失败'}`);
        }
      } catch (err) {
        systemMsg(`⚠ ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: 'user', content: text };
    const assistantMsg: ChatMessage = { id: `a-${Date.now()}`, role: 'assistant', content: '', streaming: true, tools: [] };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStreaming(true);
    const ac = new AbortController();
    abortRef.current = ac;

    await streamChat(activeId, { message: text, model: sel?.model ?? '', provider: sel?.provider }, {
      onStart: () => {},
      onDelta: (t) => setMessages((prev) => prev.map((m) => m.id === assistantMsg.id ? { ...m, content: m.content + t } : m)),
      onReasoning: (t) => setMessages((prev) => prev.map((m) => m.id === assistantMsg.id ? { ...m, reasoning: (m.reasoning ?? '') + t } : m)),
      onToolStart: (name, args) => setMessages((prev) => prev.map((m) => m.id === assistantMsg.id ? { ...m, tools: [...(m.tools ?? []), { name, args, status: 'running' as const, startedAt: Date.now() }] } : m)),
      onToolResult: (name, summary, ok, stored) => setMessages((prev) => prev.map((m) => m.id === assistantMsg.id ? {
        ...m, tools: (m.tools ?? []).map((t) => t.name === name && t.status === 'running' ? {
          ...t, summary, ok, stored, status: ok ? 'done' as const : 'error' as const, durationMs: Date.now() - (t.startedAt ?? Date.now()),
        } : t),
      } : m)),
      onApprovalRequired: (id, name, summary) => setApprovals((prev) => [...prev, { id, name, summary }]),
      onHandoff: (role, objective) => {
        // 角色移交：消息流插入系统通知；会话角色由后端持久化（刷新列表同步）
        setMessages((prev) => [...prev, { id: `ho-${Date.now()}`, role: 'system', content: `已移交给「${role}」角色：${objective.slice(0, 120)}` }]);
        void sessionApi.list().then(setSessions).catch(() => undefined);
      },
      onBudgetHit: (cost, budget) => {
        // 成本熔断：横幅展示（harness 硬边界）
        setBudgetHit({ cost, budget });
      },
      onDone: (d) => {
        setMessages((prev) => prev.map((m) => m.id === assistantMsg.id ? { ...m, content: d.content, reasoning: d.reasoning ?? m.reasoning, streaming: false, usage: d.usage, cost: d.cost, cached: d.cached } : m));
        setSessionCost((prev) => prev + (d.cost ?? 0));
      },
      onError: (e) => {
        setMessages((prev) => prev.map((m) => m.id === assistantMsg.id ? { ...m, streaming: false, error: e } : m));
        // 错误结束（如超轮数/熔断）→ 同步断点：未完成任务保留「继续任务」入口
        if (activeId) void sessionApi.checkpoint(activeId).then(setCheckpoint).catch(() => undefined);
      },
      onEnd: () => {
        setStreaming(false);
        // 任务正常完成 → 后端已清除断点
        setCheckpoint(null);
        setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, updatedAt: Date.now() } : s));
      },
    }, ac.signal);

    try { setSessions(await sessionApi.list()); } catch { /* 会话列表刷新失败不影响本次回复 */ }
  }, [activeId, sel, streaming, createSession]);

  /** 断点续跑（checkpoint）：从上次中断的轮次继续，复用完整对话流程 */
  const resumeTask = useCallback(async () => {
    if (!activeId || streaming || resuming) return;
    const cp = checkpoint;
    if (!cp?.exists) return;
    setResuming(true);
    const assistantMsg: ChatMessage = { id: `a-${Date.now()}`, role: 'assistant', content: '', streaming: true, tools: [] };
    setMessages((prev) => [...prev, { id: `cp-${Date.now()}`, role: 'system', content: `任务曾中断于第 ${cp.turn + 1} 轮——正在从断点继续…` }, assistantMsg]);
    setCheckpoint(null);
    const ac = new AbortController();
    abortRef.current = ac;
    await streamChat(activeId, { resume: true, model: sel?.model ?? '', provider: sel?.provider }, {
      onStart: () => {},
      onDelta: (t) => setMessages((prev) => prev.map((m) => m.id === assistantMsg.id ? { ...m, content: m.content + t } : m)),
      onReasoning: (t) => setMessages((prev) => prev.map((m) => m.id === assistantMsg.id ? { ...m, reasoning: (m.reasoning ?? '') + t } : m)),
      onToolStart: (name, args) => setMessages((prev) => prev.map((m) => m.id === assistantMsg.id ? { ...m, tools: [...(m.tools ?? []), { name, args, status: 'running' as const, startedAt: Date.now() }] } : m)),
      onToolResult: (name, summary, ok, stored) => setMessages((prev) => prev.map((m) => m.id === assistantMsg.id ? {
        ...m, tools: (m.tools ?? []).map((t) => t.name === name && t.status === 'running' ? {
          ...t, summary, ok, stored, status: ok ? 'done' as const : 'error' as const, durationMs: Date.now() - (t.startedAt ?? Date.now()),
        } : t),
      } : m)),
      onApprovalRequired: (id, name, summary) => setApprovals((prev) => [...prev, { id, name, summary }]),
      onHandoff: (role, objective) => {
        setMessages((prev) => [...prev, { id: `ho-${Date.now()}`, role: 'system', content: `已移交给「${role}」角色：${objective.slice(0, 120)}` }]);
      },
      onBudgetHit: (cost, budget) => setBudgetHit({ cost, budget }),
      onDone: (d) => {
        setMessages((prev) => prev.map((m) => m.id === assistantMsg.id ? { ...m, content: d.content, reasoning: d.reasoning ?? m.reasoning, streaming: false, usage: d.usage, cost: d.cost, cached: d.cached } : m));
        setSessionCost((prev) => prev + (d.cost ?? 0));
      },
      onError: (e) => {
        setMessages((prev) => prev.map((m) => m.id === assistantMsg.id ? { ...m, streaming: false, error: e } : m));
        if (activeId) void sessionApi.checkpoint(activeId).then(setCheckpoint).catch(() => undefined);
      },
      onEnd: () => {
        setStreaming(false);
        setCheckpoint(null);
      },
    }, ac.signal);
    setResuming(false);
    try {
      const cp2 = await sessionApi.checkpoint(activeId).catch(() => null);
      setCheckpoint(cp2); // 恢复后若再次中断（如熔断），断点仍可继续
      setSessions(await sessionApi.list());
    } catch { /* 忽略 */ }
  }, [activeId, streaming, resuming, checkpoint, sel]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setMessages((prev) => prev.map((m) => m.streaming ? { ...m, streaming: false } : m));
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

  const currentSession = sessions.find((s) => s.id === activeId);
  const pluginRunning = plugins.filter((p) => p.state === 'started' || p.state === 'loaded').length;
  const modeLabel = currentSession?.mode === 'plan' ? '计划模式' : currentSession?.mode === 'goal' ? '目标模式' : '普通模式';
  const modeColor = currentSession?.mode === 'plan' ? 'var(--purple)' : currentSession?.mode === 'goal' ? 'var(--orange)' : 'var(--text-3)';
  const selModel = models.find((m) => m.id === sel?.provider);
  const modelLabel = selModel ? `${selModel.label} · ${selModel.model}` : (sel ? `${sel.provider} · ${sel.model}` : '');
  const modelTag = selModel?.model ?? sel?.model ?? '';
  const modeItems = [
    { key: 'normal', label: '普通模式', sub: '自由对话', dot: 'var(--text-3)' },
    { key: 'plan', label: '计划模式', sub: '先出计划再执行', dot: 'var(--purple)' },
    { key: 'goal', label: '目标模式', sub: '以目标驱动多轮', dot: 'var(--orange)' },
  ];

  const onTab = (t: MainTab) => {
    setActiveTab(t);
    setSettingsOpen(false);
  };

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        activeTab={activeTab}
        onTab={onTab}
        onSelect={selectSession}
        onCreate={createSession}
        onDelete={deleteSession}
        onArchive={archiveSession}
        onPin={pinSession}
        onRename={renameSession}
        onBatchDelete={batchDelete}
        onBatchArchive={batchArchive}
        settingsOpen={settingsOpen}
        onToggleSettings={() => setSettingsOpen((v) => !v)}
        pluginRunning={pluginRunning}
      />

      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            <div className="crumb">
              <span className="prev">DEEPSEEK</span>
              <span className="sep">/</span>
              <span className="cur">{activeTab === 'chat' ? (currentSession?.title ?? '新会话') : activeTab === 'files' ? '文件工作区' : activeTab === 'plugins' ? '插件管理' : '缓存与成本'}</span>
            </div>
          </div>
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
                  selectedKey={sel?.provider}
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
            {activeTab !== 'chat' && <span className="tb-live"><span className="live-dot" />实时</span>}
          </div>
        </header>

        {settingsOpen ? (
          <SettingsView providers={providers} onChanged={refreshProviders} theme={theme} onThemeChange={setTheme} />
        ) : activeTab === 'chat' ? (
          <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <ChatView
                messages={messages}
                streaming={streaming}
                onSend={send}
                onStop={stop}
                hasModels={models.length > 0}
                approvals={approvals}
                onApproval={respondApproval}
                plan={plan}
                todos={todos.filter((t) => !t.sessionId || t.sessionId === currentSession?.id)}
                modelLabel={modelLabel}
                modelTag={modelTag}
                // 会话状态感知（agent harness 前端特征）：断点恢复 / 角色接管 / 成本熔断 / 会话成本
                checkpoint={checkpoint}
                onResume={() => void resumeTask()}
                resuming={resuming}
                role={currentSession?.role}
                onRoleReset={async () => {
                  if (!activeId) return;
                  try {
                    await sessionApi.update(activeId, { role: '' });
                    setSessions(await sessionApi.list());
                    toast.success('会话已交回主代理');
                  } catch (err) {
                    toast.error(`移交失败：${err instanceof Error ? err.message : String(err)}`);
                  }
                }}
                budgetHit={budgetHit}
                sessionCost={sessionCost}
              />
            </div>
            {traceOpen && (
              <aside className="trail-panel">
                <TracePanel
                  steps={traceSteps}
                  stats={traceStats}
                  onRefresh={() => void traceApi.stats().then(setTraceStats).catch(() => undefined)}
                />
              </aside>
            )}
          </div>
        ) : activeTab === 'files' ? (
          <FilesView />
        ) : activeTab === 'plugins' ? (
          <PluginsView plugins={plugins} onAction={pluginAction} />
        ) : (
          <StatsView />
        )}
      </main>
    </div>
  );
}
