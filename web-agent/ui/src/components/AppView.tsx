import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import type { ApprovalItem, ChatMessage, CheckpointInfo, PluginDiagnostic, PluginInfo, PluginNavItem, ProviderInfo, Session, TodoCard, TraceStep } from '../types';
import type { Theme, Brand } from '../App';
import type { MainTab } from './Sidebar';
import { AGENT_ID, AGENT_NAME, APP_VERSION, sys } from '../voice';
import { Toaster } from '@/components/ui/sonner';
import { Bot, MessageCircle, PanelRight, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import Sidebar from './Sidebar';
import ChatView from './ChatView';
import TracePanel from './TracePanel';
import PluginTabView from './PluginTabView';

const FilesView = lazy(() => import('./FilesView'));
const PluginsView = lazy(() => import('./PluginsView'));
const StatsView = lazy(() => import('./StatsView'));
const SettingsView = lazy(() => import('./SettingsView'));

interface Props {
  sessions: Session[];
  activeId: string | null;
  messages: ChatMessage[];
  streaming: boolean;
  models: { id: string; label: string; model: string; provider: string }[];
  sel: { provider: string; model: string } | null;
  plugins: PluginInfo[];
  pluginDiagnostics: PluginDiagnostic[];
  providers: ProviderInfo[];
  activeTab: MainTab;
  settingsOpen: boolean;
  traceSteps: TraceStep[];
  traceStats: { trace: Record<string, number>; cache: Record<string, number>; l1Enabled: boolean } | null;
  traceOpen: boolean;
  plan: import('../types').PlanState | null;
  todos: TodoCard[];
  theme: Theme;
  brand: Brand;
  checkpoint: CheckpointInfo | null;
  resuming: boolean;
  budgetHit: { cost: number; budget: number } | null;
  sessionCost: number;
  streamStatus: string | null;
  liveState: 'open' | 'down';
  squad: Record<string, { total: number; done: number; failed: number; running: Record<string, string> }>;
  approvals: ApprovalItem[];
  providerAuthFailed: { label: string; lastError: string } | null;
  currentSession?: Session;
  groupMembers: unknown[];
  activity: string | null;
  modeLabel: string;
  modelLabel: string;
  modelTag: string;
  pluginRunning: number;
  modeItems: { key: string; label: string; dot?: string; sub?: string }[];
  pluginTabs: { key: string; label: string; icon: React.ReactNode }[];
  activePluginNav: PluginNavItem | null;
  pendingInference: { objective: string; rationale: string; confidence: number } | null;
  onTab: (tab: MainTab) => void;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  onDeleteSession: (id: string) => void;
  onArchiveSession: (id: string, archived: boolean) => void;
  onPinSession: (id: string, pinned: boolean) => void;
  onRenameSession: (id: string, title: string) => void;
  onBatchDelete: (ids: string[]) => void;
  onBatchArchive: (ids: string[]) => void;
  onToggleSettings: () => void;
  onSetSessionMode: (mode: string) => void;
  onSelectModel: (id: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onResume: () => void;
  onApproval: (id: string, approved: boolean) => void;
  onConfirmInference: (objective: string, acceptance: string) => void;
  onRoleReset: () => void;
  onRefreshTrace: () => void;
  onRefreshProviders: () => void;
  onPluginAction: (id: string, action: 'enable' | 'disable' | 'reload' | 'uninstall') => Promise<void> | void;
  onSystemMessage: (content: string) => void;
  onRemoveMessage: (id: string) => void;
  onTraceOpenChange: (open: boolean) => void;
  onThemeChange: (theme: Theme) => void;
  onBrandChange: (brand: Brand) => void;
  onActiveTabChange: (tab: MainTab) => void;
  onSettingsOpenChange: (open: boolean) => void;
}

export default function AppView(props: Props) {
  const {
    sessions, activeId, messages, streaming, models, sel, plugins, pluginDiagnostics, providers,
    activeTab, settingsOpen, traceSteps, traceStats, traceOpen, plan, todos, theme, brand,
    checkpoint, resuming, budgetHit, sessionCost, streamStatus, liveState, squad, approvals,
    providerAuthFailed, currentSession, groupMembers, activity, modeLabel, modelLabel,
    modelTag, pluginRunning, modeItems, pluginTabs, activePluginNav, pendingInference,
  } = props;

  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1100px)').matches);
  const traceToggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1100px)');
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (activeTab !== 'chat' || settingsOpen) props.onTraceOpenChange(false);
  }, [activeTab, settingsOpen, props.onTraceOpenChange]);

  const viewFallback = (
    <div className="flex min-h-32 flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground" aria-busy="true">
      <Spinner />
      <span>加载中…</span>
    </div>
  );

  return (
    <TooltipProvider>
      <SidebarProvider
        defaultOpen
        className="h-[100dvh] w-full min-h-0"
        style={{ '--sidebar-width': '272px', '--sidebar-width-icon': '48px' } as React.CSSProperties}
      >
        <Sidebar
          sessions={sessions}
          activeId={activeId}
          activeTab={activeTab}
          onTab={props.onTab}
          pluginTabs={pluginTabs}
          onSelect={props.onSelectSession}
          onCreate={props.onCreateSession}
          onDelete={props.onDeleteSession}
          onArchive={props.onArchiveSession}
          onPin={props.onPinSession}
          onRename={props.onRenameSession}
          onBatchDelete={props.onBatchDelete}
          onBatchArchive={props.onBatchArchive}
          settingsOpen={settingsOpen}
          onToggleSettings={props.onToggleSettings}
          pluginRunning={pluginRunning}
          streamingId={streaming ? activeId : null}
          version={APP_VERSION}
        />

      <SidebarInset className="min-h-0 overflow-hidden min-w-0">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-background/90 px-4 backdrop-blur-md">
          {settingsOpen ? (
            <div className="flex min-w-0 items-center gap-2 text-[13px]">
              <SidebarTrigger className="size-8 shrink-0" />
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem className="font-mono text-[11px] text-muted-foreground">{AGENT_ID}</BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage>设置</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            </div>
          ) : activeTab === 'chat' ? (
            <div className="flex min-w-0 items-center gap-3">
              <SidebarTrigger className="size-8 shrink-0" />
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Bot size={16} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[14px] font-semibold tracking-[-0.015em]">
                    {currentSession?.title ?? '新会话'}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className={cn('size-1.5 rounded-full', liveState === 'down' ? 'bg-destructive' : 'bg-primary')} />
                  <span className="truncate" data-testid="connection-status" data-state={liveState}>
                    {liveState === 'down'
                      ? sys.offline
                      : streaming
                        ? activity ?? streamStatus ?? sys.started
                        : groupMembers.length
                          ? `${groupMembers.length} 位帮手协作中`
                          : `${AGENT_NAME} · 在线`}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-2 text-[13px]">
              <SidebarTrigger className="size-8 shrink-0" />
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem className="font-mono text-[11px] text-muted-foreground">{AGENT_ID}</BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage>
                      {activeTab === 'files' ? '文件工作区' : activePluginNav ? activePluginNav.pluginName : activeTab === 'plugins' ? '插件管理' : '缓存与成本'}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            </div>
          )}
          <div className="flex shrink-0 items-center gap-1.5">
            {settingsOpen ? (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => props.onSettingsOpenChange(false)}
                title="关闭设置"
                aria-label="关闭设置"
              >
                <X />
              </Button>
            ) : activeTab === 'chat' ? (
              <>
                <Select value={currentSession?.mode ?? 'normal'} onValueChange={(key) => void props.onSetSessionMode(key)}>
                  <SelectTrigger size="sm" className="h-8 max-w-[220px]" aria-label="会话模式" title={modeLabel}>
                    <MessageCircle className="md:hidden" />
                    <SelectValue>{modeLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {modeItems.map((item) => (
                        <SelectItem key={item.key} value={item.key}>
                          {item.label}
                          {item.sub && <span className="ml-auto font-mono text-[10px] text-muted-foreground">{item.sub}</span>}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Button
                  ref={traceToggleRef}
                  variant={traceOpen ? 'secondary' : 'ghost'}
                  size="icon-sm"
                  onClick={() => props.onTraceOpenChange(!traceOpen)}
                  title="运行轨迹面板"
                  aria-label="运行轨迹面板"
                  aria-expanded={traceOpen}
                  aria-controls={traceOpen ? 'chat-trace-panel' : undefined}
                >
                  {traceOpen ? <X /> : <PanelRight />}
                </Button>
              </>
            ) : (
              <Badge variant="outline" title={liveState === 'down' ? sys.offline : '与后端的实时事件通道正常'}>
                <span className={cn('size-1.5 rounded-full', liveState === 'down' ? 'bg-destructive' : 'bg-primary')} />
                {liveState === 'down' ? '重连中' : '实时'}
              </Badge>
            )}
          </div>
        </header>

        <Suspense fallback={viewFallback}>
            <div
              className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
              key={settingsOpen ? 'settings' : activeTab}
            >
              {settingsOpen ? (
                <SettingsView
                  providers={providers}
                  onChanged={props.onRefreshProviders}
                  theme={theme}
                  onThemeChange={props.onThemeChange}
                  brand={brand}
                  onBrandChange={props.onBrandChange}
                />
              ) : activeTab === 'chat' ? (
                <div className="flex min-h-0 flex-1">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <ChatView
                      messages={messages}
                      streaming={streaming}
                      onSend={props.onSend}
                      pendingInference={pendingInference}
                      onConfirmInference={props.onConfirmInference}
                      onStop={props.onStop}
                      hasModels={models.length > 0}
                      approvals={approvals.filter((approval) => !approval.sessionId || approval.sessionId === activeId)}
                      onApproval={props.onApproval}
                      plan={plan}
                      todos={todos.filter((todo) => !todo.sessionId || todo.sessionId === currentSession?.id)}
                      modelLabel={modelLabel}
                      modelTag={modelTag}
                      models={models}
                      onSelectModel={(key) => void props.onSelectModel(key)}
                      selectedModelId={sel ? `${sel.provider}@${sel.model}` : undefined}
                      streamStatus={streamStatus}
                      squad={squad[activeId ?? '']}
                      checkpoint={checkpoint}
                      onResume={props.onResume}
                      resuming={resuming}
                      role={currentSession?.role}
                      onRoleReset={props.onRoleReset}
                      budgetHit={budgetHit}
                      sessionCost={sessionCost}
                      onSystemMsg={props.onSystemMessage}
                      sessionKey={activeId ?? undefined}
                      onRemoveMessage={props.onRemoveMessage}
                      providerAuthFailed={providerAuthFailed}
                      onOpenSettings={() => {
                        props.onActiveTabChange('chat');
                        props.onSettingsOpenChange(true);
                      }}
                    />
                  </div>
                  {!narrow && traceOpen && (
                    <aside id="chat-trace-panel" data-testid="trace-panel" aria-label="运行轨迹" className="flex w-80 shrink-0 flex-col border-l bg-card xl:w-[22rem]">
                      <TracePanel
                        steps={traceSteps}
                        stats={traceStats}
                        onRefresh={props.onRefreshTrace}
                      />
                    </aside>
                  )}
                  {narrow && (
                    <Sheet open={traceOpen} onOpenChange={props.onTraceOpenChange}>
                      <SheetContent id="chat-trace-panel" className="w-[min(92vw,24rem)] gap-0" onCloseAutoFocus={(event) => { event.preventDefault(); traceToggleRef.current?.focus(); }}>
                        <SheetHeader className="pr-12">
                          <SheetTitle>运行轨迹</SheetTitle>
                          <SheetDescription>模型调用、工具执行与缓存使用。</SheetDescription>
                        </SheetHeader>
                        <div data-testid="trace-panel" className="flex min-h-0 flex-1 flex-col">
                          <TracePanel steps={traceSteps} stats={traceStats} onRefresh={props.onRefreshTrace} />
                        </div>
                      </SheetContent>
                    </Sheet>
                  )}
                </div>
              ) : activeTab === 'files' ? (
                <FilesView />
              ) : activeTab === 'plugins' ? (
                <PluginsView plugins={plugins} diagnostics={pluginDiagnostics} onAction={props.onPluginAction} />
              ) : activePluginNav ? (
                <PluginTabView key={activePluginNav.key} item={activePluginNav} />
              ) : (
                <StatsView />
              )}
            </div>
        </Suspense>
      </SidebarInset>

      <Toaster
        theme={theme}
        position="bottom-right"
        gap={8}
        visibleToasts={4}
      />
      </SidebarProvider>
    </TooltipProvider>
  );
}
