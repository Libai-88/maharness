// ui/src/App.tsx —— 主布局（Screen 1–8 导航枢纽）
import { useCallback, useEffect, useRef, useState } from 'react';
import { approvalsApi, commandsApi, modelsApi, pluginsApi, providersApi, sessionApi, streamChat, subscribeEvents, traceApi } from './api';
import type { ApprovalItem, BusEvent, ChatMessage, ModelInfo, PlanState, PluginInfo, ProviderInfo, Session, TraceStep } from './types';
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
  const [theme, setTheme] = useState<Theme>(readTheme);

  const abortRef = useRef<AbortController | null>(null);

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
    }
  }

  const selectSession = useCallback(async (id: string) => {
    setActiveId(id);
    setMessages([]);
    setTraceSteps([]);
    setPlan(null);
    try {
      const msgs = await sessionApi.messages(id);
      setMessages(msgs.map((m) => ({ id: m.id, role: m.role === 'user' ? 'user' : 'assistant', content: m.content ?? '', reasoning: m.reasoning })));
    } catch { /* 忽略 */ }
  }, []);

  const createSession = useCallback(async () => {
    try {
      const s = await sessionApi.create(sel?.model ?? '');
      setSessions((prev) => [s, ...prev]);
      setActiveId(s.id);
      setMessages([]);
      setTraceSteps([]);
      setPlan(null);
    } catch (err) { console.error('[maharness] 新建会话失败:', err); }
  }, [sel]);

  const deleteSession = useCallback(async (id: string) => {
    try {
      await sessionApi.remove(id);
    } catch (err) { console.error('[maharness] 删除会话失败:', err); return; }
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (activeId === id) {
        if (next.length) void selectSession(next[0].id);
        else { setActiveId(null); setMessages([]); }
      }
      return next;
    });
  }, [activeId, selectSession]);

  const archiveSession = useCallback(async (id: string, archived: boolean) => {
    try {
      await sessionApi.update(id, { archived });
      setSessions(await sessionApi.list());
    } catch (err) { console.error('[maharness] 归档会话失败:', err); }
  }, []);

  const pinSession = useCallback(async (id: string, pinned: boolean) => {
    try {
      await sessionApi.update(id, { pinned });
      setSessions(await sessionApi.list());
    } catch (err) { console.error('[maharness] 置顶会话失败:', err); }
  }, []);

  const renameSession = useCallback(async (id: string, title: string) => {
    const t = title.trim();
    if (!t) return;
    try {
      await sessionApi.rename(id, t);
      setSessions(await sessionApi.list());
    } catch { /* 忽略 */ }
  }, []);

  const setSessionMode = useCallback(async (mode: string) => {
    if (!activeId) return;
    try {
      await sessionApi.update(activeId, { mode });
      setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, mode } : s));
    } catch { /* 忽略 */ }
  }, [activeId]);

  const selectModel = useCallback(async (id: string) => {
    const m = models.find((x) => x.id === id);
    if (!m) return;
    setSel({ provider: m.id, model: m.model });
    if (activeId) {
      try { await sessionApi.update(activeId, { model: m.model }); } catch { /* 忽略 */ }
    }
  }, [models, activeId]);

  const pluginAction = useCallback(async (id: string, action: 'enable' | 'disable' | 'reload') => {
    try {
      await pluginsApi.action(id, action);
      setPlugins(await pluginsApi.list());
    } catch (err) { console.error(`[maharness] 插件操作失败（${action}）:`, err); }
  }, []);

  const refreshProviders = useCallback(async () => {
    try {
      setProviders(await providersApi.list());
      setModels(await modelsApi.list());
    } catch (err) { console.error('[maharness] 刷新 Provider 失败:', err); }
  }, []);

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
      onToolResult: (name, summary, ok) => setMessages((prev) => prev.map((m) => m.id === assistantMsg.id ? {
        ...m, tools: (m.tools ?? []).map((t) => t.name === name && t.status === 'running' ? {
          ...t, summary, ok, status: ok ? 'done' as const : 'error' as const, durationMs: Date.now() - (t.startedAt ?? Date.now()),
        } : t),
      } : m)),
      onApprovalRequired: (id, name, summary) => setApprovals((prev) => [...prev, { id, name, summary }]),
      onDone: (d) => setMessages((prev) => prev.map((m) => m.id === assistantMsg.id ? { ...m, content: d.content, reasoning: d.reasoning ?? m.reasoning, streaming: false, usage: d.usage, cost: d.cost, cached: d.cached } : m)),
      onError: (e) => setMessages((prev) => prev.map((m) => m.id === assistantMsg.id ? { ...m, streaming: false, error: e } : m)),
      onEnd: () => {
        setStreaming(false);
        setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, updatedAt: Date.now() } : s));
      },
    }, ac.signal);

    try { setSessions(await sessionApi.list()); } catch { /* 会话列表刷新失败不影响本次回复 */ }
  }, [activeId, sel, streaming, createSession]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setMessages((prev) => prev.map((m) => m.streaming ? { ...m, streaming: false } : m));
    setStreaming(false);
  }, []);

  const respondApproval = useCallback(async (id: string, approved: boolean) => {
    try { await approvalsApi.respond(id, approved); } catch { /* 审批已过期 */ }
    setApprovals((prev) => prev.filter((a) => a.id !== id));
  }, []);

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
                modelLabel={modelLabel}
                modelTag={modelTag}
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
