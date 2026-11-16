import type { Material, MaterialRef } from '../material-api';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApprovalItem, ChatMessage, CheckpointInfo, PlanState, TodoCard } from '../types';
import { buildChatTimeline } from '../chat/model';
import { useChatComposer } from '../hooks/useChatComposer';
import { AGENT_NAME, approvalHead, money, sys, tidySentence } from '../voice';
import ChatThread from './chat/ChatThread';
import LegacyCheckpoint from './LegacyCheckpoint';
import ChatComposer from './chat/ChatComposer';
import {
  Ban as IconBlock,
  Check as IconCheck,
  Circle as IconCircle,
  Coins as IconCoin,
  LockKeyhole as IconLock,
  Pause as IconPause,
  ListChecks as IconPlan,
  Play as IconPlay,
  ArrowLeftRight as IconSwitch,
} from 'lucide-react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import { Spinner } from '@/components/ui/spinner';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace';

interface Props {
  initialMaterial?: { material: Material; quote?: string };
  onMaterialAttached?: () => void;
  runControls?: import('react').ReactNode;
  messages: ChatMessage[];
  streaming: boolean;
  onSend: (text: string, materials?: MaterialRef[]) => void;
  pendingInference?: { objective: string; rationale: string; confidence: number } | null;
  onConfirmInference?: (objective: string, acceptance: string) => void;
  onStop: () => void;
  hasModels: boolean;
  approvals: ApprovalItem[];
  onApproval: (id: string, approved: boolean) => void;
  plan: PlanState | null;
  todos?: TodoCard[];
  modelLabel?: string;
  modelTag?: string;
  models?: { id: string; label: string; model: string }[];
  onSelectModel?: (id: string) => void;
  selectedModelId?: string;
  streamStatus?: string | null;
  squad?: { total: number; done: number; failed: number; running: Record<string, string> };
  checkpoint?: CheckpointInfo | null;
  onResume?: () => void;
  resuming?: boolean;
  role?: string;
  onRoleReset?: () => void;
  budgetHit?: { cost: number; budget: number } | null;
  sessionCost?: number;
  onSystemMsg?: (content: string) => void;
  sessionKey?: string;
  onRemoveMessage?: (id: string) => void;
  providerAuthFailed?: { label: string; lastError: string } | null;
  onOpenSettings?: () => void;
}

export default function ChatView({
  initialMaterial,
  onMaterialAttached,
  runControls,
  messages,
  streaming,
  onSend,
  onStop,
  hasModels,
  approvals,
  onApproval,
  plan,
  todos = [],
  modelLabel = '',
  modelTag = '',
  models = [],
  onSelectModel,
  selectedModelId,
  streamStatus,
  squad,
  checkpoint,
  onResume,
  resuming = false,
  role,
  onRoleReset,
  budgetHit,
  sessionCost = 0,
  onSystemMsg,
  sessionKey,
  onRemoveMessage,
  providerAuthFailed,
  onOpenSettings,
  pendingInference,
  onConfirmInference,
}: Props) {
  const [pendingApprovals, setPendingApprovals] = useState<Record<string, 'approve' | 'reject'>>({});
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [patId, setPatId] = useState<string | null>(null);
  const patTimerRef = useRef(0);

  const composer = useChatComposer({
    onSend,
    onStop,
    streaming,
    sessionKey,
    pendingInference,
  });
  useEffect(() => { if (initialMaterial) { composer.addMaterial(initialMaterial.material, initialMaterial.quote); onMaterialAttached?.(); } }, [initialMaterial, composer.addMaterial, onMaterialAttached]);

  useEffect(() => {
    if (!approvals.length) return;
    setNowTick(Date.now());
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [approvals.length]);

  useEffect(() => () => window.clearTimeout(patTimerRef.current), []);

  const resend = useCallback((text: string) => {
    if (text.trim() && !streaming) onSend(text);
  }, [streaming, onSend]);

  const patAgent = useCallback((id: string) => {
    const lines = [
      '你拍了拍「maharness」的小脑袋，它愉快地摇了摇尾巴',
      '你拍了拍「maharness」，它说：在的在的，随叫随到',
      '你拍了拍「maharness」，它头顶冒出了一个小羊角',
    ];
    onSystemMsg?.(lines[Math.floor(Math.random() * lines.length)]);
    setPatId(id);
    window.clearTimeout(patTimerRef.current);
    patTimerRef.current = window.setTimeout(() => setPatId(null), 1100);
  }, [onSystemMsg]);

  const timeline = useMemo(
    () => buildChatTimeline(messages, streamStatus),
    [messages, streamStatus],
  );

  const hour = new Date().getHours();
  const greet = hour < 5 ? '夜深了' : hour < 9 ? '早上好' : hour < 12 ? '上午好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : hour < 23 ? '晚上好' : '夜深了';

  const planLineStatus = (status: string): 'running' | 'error' | 'pending' | undefined => {
    if (status === 'in_progress' || status === 'doing') return 'running';
    if (status === 'blocked') return 'error';
    if (status === 'todo') return 'pending';
    return undefined;
  };

  return (
    <section aria-label="聊天" className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {(providerAuthFailed || role || (checkpoint?.exists && !streaming) || budgetHit) && (
        <div className="mx-auto flex w-full max-w-3xl min-w-0 max-h-[min(18dvh,10rem)] shrink-0 flex-col gap-2 overflow-y-auto px-4 pt-3 sm:px-6">
          {providerAuthFailed && (
            <Alert title={providerAuthFailed.lastError}>
              <IconLock />
              <AlertTitle>线路凭据失效</AlertTitle>
              <AlertDescription>
                {AGENT_NAME}的一条线路钥匙过期了（{providerAuthFailed.label}），请在模型设置中检查。
              </AlertDescription>
              <AlertAction>
                <Button variant="outline" size="xs" onClick={onOpenSettings}>去换钥匙</Button>
              </AlertAction>
            </Alert>
          )}
          {checkpoint?.exists && !streaming && !resuming && (
            <Marker variant="border" data-testid="resume-banner">
              <MarkerIcon><IconPause size={13} /></MarkerIcon>
              <MarkerContent>上次做到第 {checkpoint.turn + 1} 轮停下了，之前做完的都还在。</MarkerContent>
              <Button variant="outline" size="xs" onClick={onResume} disabled={resuming}>接着说</Button>
            </Marker>
          )}
          {resuming && (
            <Marker role="status">
              <MarkerIcon><Spinner /></MarkerIcon>
              <MarkerContent className="shimmer">{sys.resumed}</MarkerContent>
            </Marker>
          )}
          {role && (
            <Alert data-testid="role-banner">
              <IconSwitch />
              <AlertTitle>角色接管</AlertTitle>
              <AlertDescription>这件事现在由「{role}」接手。</AlertDescription>
              <AlertAction>
                <Button variant="outline" size="xs" onClick={onRoleReset}>换回{AGENT_NAME}</Button>
              </AlertAction>
            </Alert>
          )}
          {budgetHit && (
            <Alert data-testid="budget-banner">
              <IconCoin />
              <AlertTitle>预算用完了</AlertTitle>
              <AlertDescription>
                已用 {money(budgetHit.cost)} / 预算 {money(budgetHit.budget)}，做完的事都留在上面了。
              </AlertDescription>
              <AlertAction>
                <Button variant="outline" size="xs" onClick={onOpenSettings}>去调预算</Button>
              </AlertAction>
            </Alert>
          )}
        </div>
      )}

      <ChatThread
        key={sessionKey}
        timeline={timeline}
        hasModels={hasModels}
        onSend={onSend}
        onDraft={composer.setInput}
        canResend={!streaming}
        onResend={resend}
        modelTag={modelTag}
        squad={squad}
        pattedId={patId}
        onPat={patAgent}
        onQuote={composer.quoteMessage}
        onRemove={onRemoveMessage}
        greet={greet}
        streaming={streaming}
        onOpenSettings={onOpenSettings}
      />

      <ChatComposer
        composer={composer}
        streaming={streaming}
        hasModels={hasModels}
        sessionCost={sessionCost}
        models={models}
        modelLabel={modelLabel}
        selectedModelId={selectedModelId}
        onSelectModel={onSelectModel}
        onStop={onStop}
        pendingInference={pendingInference}
        onConfirmInference={onConfirmInference}
      >
      <LegacyCheckpoint sessionId={sessionKey} disabled={streaming} onSend={onSend} />
      {runControls}
      {approvals.length > 0 && (
        <ItemGroup className="gap-2">
          {approvals.map((approval) => (
            <Item key={approval.id} variant="outline" data-testid="approval-card">
              <ItemMedia variant="icon">
                <IconLock />
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle className="flex-wrap">
                  {approvalHead(approval.name).title} · {approvalHead(approval.name).sub}
                  {typeof approval.createdAt === 'number' && (
                    <Badge variant="secondary" className="font-normal">
                      {nowTick - approval.createdAt < 60_000
                        ? `等了 ${Math.max(1, Math.round((nowTick - approval.createdAt) / 1000))} 秒`
                        : `等了 ${Math.floor((nowTick - approval.createdAt) / 60_000)} 分钟`}
                      {typeof approval.expiresAt === 'number' && approval.expiresAt > nowTick
                        ? ` · 还剩 ${Math.max(1, Math.ceil((approval.expiresAt - nowTick) / 60_000))} 分钟`
                        : ''}
                    </Badge>
                  )}
                </ItemTitle>
                <ItemDescription className="font-mono text-xs">{tidySentence(approval.summary, 200)}</ItemDescription>
              </ItemContent>
              <ItemActions className="ml-auto">
                <Button
                  size="sm"
                  disabled={!!pendingApprovals[approval.id]}
                  onClick={() => {
                    setPendingApprovals((current) => ({ ...current, [approval.id]: 'approve' }));
                    onApproval(approval.id, true);
                  }}
                >
                  {pendingApprovals[approval.id] === 'approve' && <Spinner data-icon="inline-start" />}
                  可以，去做吧
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!!pendingApprovals[approval.id]}
                  onClick={() => {
                    setPendingApprovals((current) => ({ ...current, [approval.id]: 'reject' }));
                    onApproval(approval.id, false);
                  }}
                >
                  {pendingApprovals[approval.id] === 'reject' && <Spinner data-icon="inline-start" />}
                  先别
                </Button>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}

      {(plan || todos.length > 0) && (
        <div className="min-w-0">
          <Trace data-testid="goal-plan">
            <TraceCollapsible>
              <TraceCollapsibleTrigger className="py-2">
                <TraceLine status={plan && !plan.completed ? 'running' : undefined}>
                <TraceIcon><IconPlan size={13} /></TraceIcon>
                <TraceTitle>
                  {plan
                    ? `${plan.completed ? '目标已完成' : '目标进行中'}：${tidySentence(plan.objective, 40)}`
                    : `待办 ${todos.filter((todo) => todo.status === 'done').length}/${todos.length}`}
                </TraceTitle>
                <TraceDescription>
                  {plan
                    ? `${plan.steps.filter((step) => step.status === 'done').length}/${plan.steps.length}`
                    : `${todos.filter((todo) => todo.status === 'done').length}/${todos.length}`}
                </TraceDescription>
                </TraceLine>
              </TraceCollapsibleTrigger>
              <TraceCollapsibleContent className="pb-2">
                <Trace>
                {plan?.steps.map((step, index) => (
                  <TraceLine key={`${step.title}-${index}`} status={planLineStatus(step.status)}>
                    <TraceIcon>
                      {step.status === 'done' ? <IconCheck size={13} /> : step.status === 'in_progress' ? <IconPlay size={13} /> : step.status === 'blocked' ? <IconBlock size={13} /> : <IconCircle size={13} />}
                    </TraceIcon>
                    <TraceTitle>{index + 1}. {step.title}</TraceTitle>
                  </TraceLine>
                ))}
                {todos.map((todo) => (
                  <TraceLine key={todo.id} status={planLineStatus(todo.status)}>
                    <TraceIcon>
                      {todo.status === 'done' ? <IconCheck size={13} /> : todo.status === 'doing' ? <IconPlay size={13} /> : todo.status === 'blocked' ? <IconBlock size={13} /> : <IconCircle size={13} />}
                    </TraceIcon>
                    <TraceTitle>{todo.title}</TraceTitle>
                    {todo.desc && <TraceDescription className="max-w-[280px] truncate">{todo.desc}</TraceDescription>}
                  </TraceLine>
                ))}
                </Trace>
              </TraceCollapsibleContent>
            </TraceCollapsible>
          </Trace>
        </div>
      )}

      </ChatComposer>
    </section>
  );
}
