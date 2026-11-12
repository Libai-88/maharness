import { memo, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ChatMessage, ToolStep } from '../../types';
import { isSubagentTool, subagentLabel } from '../../types';
import {
  AGENT_ID,
  AGENT_NAME,
  describeToolOutcome,
  money,
  stepLine,
  sys,
  tidySentence,
  toolDisplayName,
  toolOutcomeText,
} from '../../voice';
import type { ChatPart, ChatRun } from '../../chat/model';
import Markdown from '../Markdown';
import {
  Zap as IconBolt,
  Brain as IconBrain,
  Check as IconCheck,
  Coins as IconCoin,
  Copy as IconCopy,
  Eye as IconEye,
  UsersRound as IconParallel,
  Paperclip as IconPaperclip,
  RefreshCw as IconRefresh,
  CornerUpLeft as IconReturn,
  Bot as IconRobot,
  Trash2 as IconTrash,
  TriangleAlert as IconWarn,
} from 'lucide-react';
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { CodeBlock, CodeBlockContent } from '@/components/ui/code-block';
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader } from '@/components/ui/message';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Marker, MarkerContent } from '@/components/ui/marker';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { ScrollArea } from '@/components/ui/scroll-area';
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
import { cn } from '@/lib/utils';

function fmtMs(ms?: number): string {
  if (ms === undefined) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function argsSummary(args: unknown): string {
  if (args && typeof args === 'object') {
    const values = args as Record<string, unknown>;
    for (const key of ['path', 'command', 'query', 'url', 'pattern', 'objective', 'target']) {
      const value = values[key];
      if (typeof value === 'string' && value.trim()) {
        const text = value.replace(/\s+/g, ' ').trim();
        return text.length > 82 ? `${text.slice(0, 82)}…` : text;
      }
    }
  }
  try {
    const value = JSON.stringify(args) ?? '';
    return value.length > 90 ? `${value.slice(0, 90)}…` : value;
  } catch {
    return String(args);
  }
}

function MessageMenu({
  message,
  children,
  canResend,
  onResend,
  onQuote,
  onRemove,
}: {
  message: ChatMessage;
  children: React.ReactNode;
  canResend: boolean;
  onResend: (text: string) => void;
  onQuote?: (message: ChatMessage) => void;
  onRemove?: (id: string) => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild data-slot="bubble-content" className="select-text" onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || (event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
        }
      }}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent data-testid="bubble-menu" aria-label="消息操作">
        <ContextMenuGroup>
        <ContextMenuItem data-testid="menu-copy" onSelect={() => { void navigator.clipboard.writeText(message.content).catch(() => toast.error('复制失败，请重试')); }}>
          <IconCopy />复制
        </ContextMenuItem>
        {message.role === 'user' ? (
          canResend && (
            <ContextMenuItem data-testid="menu-resend" onSelect={() => onResend(message.content)}>
              <IconRefresh />重新发送
            </ContextMenuItem>
          )
        ) : (
          <ContextMenuItem data-testid="menu-quote" onSelect={() => onQuote?.(message)}>
            <IconReturn />引用
          </ContextMenuItem>
        )}
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
        <ContextMenuItem
          variant="destructive"
          data-testid="menu-remove"
          title="仅从当前视图移除（服务端记录保留）"
          onSelect={() => onRemove?.(message.id)}
        >
          <IconTrash size={13} />
          删除
        </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      title={copied ? '已复制' : '复制回复'}
      aria-label={copied ? '已复制' : '复制回复'}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1200);
        } catch {
          toast.error('复制失败，请重试');
        }
      }}
    >
      {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
    </Button>
  );
}

function MessageContentText({ text }: { text: string }) {
  return <Markdown text={text} />;
}

const ToolTrace = memo(function ToolTrace({ tool }: { tool: ToolStep }) {
  const running = tool.status === 'running';
  const failed = tool.status === 'error' || tool.ok === false;
  const statusText = toolOutcomeText(tool);
  const output = tool.summary ? describeToolOutcome(tool.name, tool.summary, !failed) : '';
  const line = (
    <TraceLine status={running ? 'running' : failed ? 'error' : undefined}>
      <TraceIcon>
        {running ? <Spinner /> : failed ? <IconWarn /> : <IconCheck />}
      </TraceIcon>
      <TraceTitle title={tool.name}>{toolDisplayName(tool.name)}</TraceTitle>
      {tool.args ? (
        <TraceDescription className="hidden max-w-48 truncate sm:block" title={argsSummary(tool.args)}>
          {argsSummary(tool.args)}
        </TraceDescription>
      ) : null}
      <TraceDescription>
        {statusText}{tool.durationMs !== undefined ? ` · ${fmtMs(tool.durationMs)}` : ''}
      </TraceDescription>
    </TraceLine>
  );

  if (!output && !tool.stored && !tool.evidence?.length && !tool.warnings?.length) {
    return (
      <div data-testid="tool-step" data-status={running ? 'running' : failed ? 'error' : 'done'}>
        {line}
      </div>
    );
  }

  return (
    <TraceCollapsible data-testid="tool-step" data-status={running ? 'running' : failed ? 'error' : 'done'} defaultOpen={running || failed}>
        <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="flex flex-col gap-2">
          {output && <CodeBlock size="sm" variant={failed ? 'destructive' : 'default'}><CodeBlockContent wrap className="max-h-64">{output}</CodeBlockContent></CodeBlock>}
          {tool.stored && (
            <Badge variant="secondary" className="w-fit">
              <IconPaperclip />
              完整结果已存入结果存储，可无副作用重读
            </Badge>
          )}
          {tool.evidence?.length ? (
            <div className="flex flex-wrap gap-2" data-testid="tool-evidence">
              {tool.evidence.map((item, index) => (
                <Badge key={`${item.kind}-${item.ref ?? item.label}-${index}`} variant="outline" className="max-w-full gap-1">
                  <IconPaperclip />
                  <span className="truncate" title={item.ref ?? item.label}>{item.label}</span>
                  {item.ref && item.ref !== item.label ? <span className="truncate font-mono text-muted-foreground" title={item.ref}>{item.ref}</span> : null}
                </Badge>
              ))}
            </div>
          ) : null}
          {tool.warnings?.length ? (
            <div className="flex flex-col gap-1" data-testid="tool-warnings">
              {tool.warnings.map((warning, index) => (
                <div key={`${warning.kind}-${warning.label}-${index}`} className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
                  <IconWarn className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    {warning.kind === 'prompt-injection' ? '提示注入风险' : '敏感信息'}：{warning.label}
                    <code className="ml-1 text-muted-foreground">{warning.preview}</code>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </TraceCollapsibleContent>
    </TraceCollapsible>
  );
});

const MemberSpeech = memo(function MemberSpeech({
  tool,
  progress,
}: {
  tool: ToolStep;
  progress?: { total: number; done: number; failed: number; running: string[] };
}) {
  const [userOpen, setUserOpen] = useState<boolean | undefined>();
  const label = subagentLabel(tool.name, tool.args) ?? tool.name;
  const running = tool.status === 'running';
  const objective = (() => {
    try {
      const args = (tool.args ?? {}) as { objective?: string; target?: string };
      const text = String(args.objective ?? args.target ?? '').trim();
      return text.length > 120 ? `${text.slice(0, 120)}…` : text;
    } catch {
      return '';
    }
  })();
  const detail = argsSummary(tool.args);
  const bubble = running
    ? objective || '正在忙…'
    : tool.summary
      ? stepLine(tool)
      : objective || (tool.ok === false ? '这事儿我没办成' : '办好了');

  return (
    <TraceCollapsible data-testid="subagent-step" data-status={running ? 'running' : tool.ok === false ? 'error' : 'done'} open={userOpen ?? (running || tool.ok === false)} onOpenChange={setUserOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine status={running ? 'running' : tool.ok === false ? 'error' : undefined}>
            <TraceIcon>
              {tool.name === 'run_review' ? <IconEye size={13} /> : tool.name === 'run_parallel' ? <IconParallel size={13} /> : <IconRobot size={13} />}
            </TraceIcon>
            <TraceTitle>{label}</TraceTitle>
            <TraceDescription>
              {running ? '正在做' : tool.ok === false ? '没办成' : '已完成'}
              {tool.durationMs !== undefined ? ` · ${fmtMs(tool.durationMs)}` : ''}
            </TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="flex flex-col gap-2 whitespace-pre-wrap">
          <p>{bubble}</p>
          {running && progress && progress.total > 0 && (
            <div className="flex max-w-[260px] flex-col gap-1.5">
              <Progress value={Math.round(((progress.done + progress.failed) / progress.total) * 100)} />
              <span className="text-[11px] text-muted-foreground">
                {progress.done + progress.failed}/{progress.total} 交回
                {progress.failed > 0 ? ` · ${progress.failed} 没成` : ''}
                {progress.running[0] ? ` · 正在做：${tidySentence(progress.running[0], 18)}` : ''}
              </span>
            </div>
          )}
          {!running && tool.ok === false && (
            <span className="inline-flex items-center gap-1 text-destructive">
              <IconWarn size={11} />没办成
            </span>
          )}
          {!running && detail && <CodeBlock size="sm"><CodeBlockContent wrap className="max-h-64">{detail}</CodeBlockContent></CodeBlock>}
        </TraceCollapsibleContent>
    </TraceCollapsible>
  );
});

function ReasoningTrace({
  part,
}: {
  part: Extract<ChatPart, { kind: 'reasoning' }>;
}) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? part.streaming;

  return (
    <TraceCollapsible open={open} onOpenChange={setUserOpen}>
      <TraceCollapsibleTrigger>
        <TraceLine status={part.streaming ? 'running' : undefined}>
          <TraceIcon>
            {part.streaming ? <Spinner className="size-3.5" /> : <IconBrain />}
          </TraceIcon>
          <TraceTitle>{part.streaming ? '正在思考' : '思考过程'}</TraceTitle>
          {!part.streaming && <TraceDescription>{open ? '收起' : '展开'}</TraceDescription>}
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <ScrollArea role="region" aria-label="思考详情" className="max-h-48 [&_[data-slot=scroll-area-viewport]]:max-h-48">
          <div className="pr-4 whitespace-pre-wrap">{part.text}</div>
        </ScrollArea>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function NarrationTrace({ part }: { part: Extract<ChatPart, { kind: 'narration' }> }) {
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine status={part.streaming ? 'running' : undefined}>
          <TraceIcon><IconBrain size={13} /></TraceIcon>
          <TraceTitle>{part.streaming ? `${AGENT_NAME}边想边做` : `${AGENT_NAME}当时在想`}</TraceTitle>
          <TraceDescription>{part.paragraphs.length} 段</TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex flex-col gap-2">
        {part.paragraphs.map((paragraph, index) => <p key={index} className="text-xs leading-relaxed">{paragraph}</p>)}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function VerificationPart({ part }: { part: Extract<ChatPart, { kind: 'verification' }> }) {
  const verification = part.verification;
  return (
    <Trace data-testid="verification">
      <TraceCollapsible defaultOpen={verification.status !== 'verified'}>
        <TraceCollapsibleTrigger>
          <TraceLine status={verification.status === 'verified' ? undefined : 'error'}>
            <TraceIcon>{verification.status === 'verified' ? <IconCheck /> : <IconWarn />}</TraceIcon>
            <TraceTitle>{verification.status === 'verified' ? '验收通过' : verification.status === 'partial' ? '部分完成' : '验收未通过'}</TraceTitle>
            <TraceDescription>{verification.checks.filter((check) => check.ok).length}/{verification.checks.length}</TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent><Trace>
        {verification.checks.map((check, index) => (
          <TraceLine key={index} status={check.ok ? undefined : 'error'}>
            <TraceIcon>{check.ok ? <IconCheck size={13} /> : <IconWarn size={13} />}</TraceIcon>
            <TraceTitle>{check.reason ?? '验收条件'}</TraceTitle>
            {verification.evidence[index]?.traceStepId && (
              <TraceDescription className="font-mono">
                <code title="对应 Trace 步骤">#{verification.evidence[index]!.traceStepId!.slice(0, 8)}</code>
              </TraceDescription>
            )}
          </TraceLine>
        ))}
        </Trace></TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

function FailurePart({
  part,
  retryText,
  canResend,
  onResend,
}: {
  part: Extract<ChatPart, { kind: 'failure' }>;
  retryText?: string;
  canResend: boolean;
  onResend: (text: string) => void;
}) {
  return (
    <Alert variant="destructive" role="status" data-testid="message-failure" title={part.raw}>
      <IconWarn />
      <AlertTitle>{part.text}</AlertTitle>
      {canResend && part.retryable && retryText?.trim() && (
        <AlertAction>
          <Button variant="outline" size="xs" onClick={() => onResend(retryText)}>
            再试一次
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}

function ActivityTrace({
  parts,
  squad,
}: {
  parts: ChatPart[];
  squad?: { total: number; done: number; failed: number; running: Record<string, string> };
}) {
  const traceParts = parts.filter((part) => part.kind === 'narration' || part.kind === 'reasoning' || part.kind === 'tool');
  return (
    <>
      {traceParts.length > 0 && (
        <Trace>
          {traceParts.map((part) => {
            if (part.kind === 'narration') return <NarrationTrace key={part.id} part={part} />;
            if (part.kind === 'reasoning') return <ReasoningTrace key={part.id} part={part} />;
            if (part.kind === 'tool' && isSubagentTool(part.tool.name)) return (
              <MemberSpeech
                key={part.id}
                tool={part.tool}
                progress={part.tool.name === 'run_parallel' && squad && squad.total > 0
                  ? { total: squad.total, done: squad.done, failed: squad.failed, running: Object.values(squad.running) }
                  : undefined}
              />
            );
            if (part.kind === 'tool') return <ToolTrace key={part.id} tool={part.tool} />;
            return null;
          })}
        </Trace>
      )}
    </>
  );
}

export function UserMessage({
  message,
  canResend,
  onResend,
  onQuote,
  onRemove,
}: {
  message: ChatMessage;
  canResend: boolean;
  onResend: (text: string) => void;
  onQuote?: (message: ChatMessage) => void;
  onRemove?: (id: string) => void;
}) {
  return (
    <>
      <Message align="end">
        <MessageContent className="min-w-0 items-end">
          <Bubble align="end" variant="muted" className="max-w-[86%]">
            <MessageMenu message={message} canResend={canResend} onResend={onResend} onQuote={onQuote} onRemove={onRemove}>
            <BubbleContent
              data-testid="msg-bubble-user"
              tabIndex={0}
              aria-label="你发送的消息，按 Enter 打开操作菜单"
            >
              <span className="whitespace-pre-wrap">{message.content}</span>
            </BubbleContent>
            </MessageMenu>
          </Bubble>
          {canResend && (
            <MessageFooter className="justify-end opacity-100 transition-opacity sm:opacity-0 sm:group-hover/message:opacity-100 sm:group-focus-within/message:opacity-100 motion-reduce:transition-none">
              <Button variant="ghost" size="icon-xs" title="重试这条消息" aria-label="重试这条消息" onClick={() => onResend(message.content)}>
                <IconRefresh size={12} />
              </Button>
            </MessageFooter>
          )}
        </MessageContent>
      </Message>
    </>
  );
}

export const AssistantRun = memo(function AssistantRun({
  run,
  retryText,
  canResend,
  onResend,
  modelTag,
  squad,
  patted,
  onPat,
  onQuote,
  onRemove,
}: {
  run: ChatRun;
  retryText?: string;
  canResend: boolean;
  onResend: (text: string) => void;
  modelTag: string;
  squad?: { total: number; done: number; failed: number; running: Record<string, string> };
  patted?: boolean;
  onPat?: () => void;
  onQuote?: (message: ChatMessage) => void;
  onRemove?: (id: string) => void;
}) {
  const text = run.parts.find((part): part is Extract<ChatPart, { kind: 'text' }> => part.kind === 'text');
  const status = run.parts.find((part): part is Extract<ChatPart, { kind: 'status' }> => part.kind === 'status');
  const hasTraceActivity = run.parts.some((part) => part.kind === 'reasoning' || part.kind === 'narration' || part.kind === 'tool');
  const stopped = run.parts.find((part): part is Extract<ChatPart, { kind: 'stopped' }> => part.kind === 'stopped');
  const failure = run.parts.find((part): part is Extract<ChatPart, { kind: 'failure' }> => part.kind === 'failure');
  const verification = run.parts.find((part): part is Extract<ChatPart, { kind: 'verification' }> => part.kind === 'verification');

  return (
    <>
      <Message
        align="start"
        className={cn(
          'min-w-0',
        )}
      >
        <MessageAvatar
          className={cn('mt-0.5 self-start transition-transform group-has-data-[slot=message-footer]/message:translate-y-0', patted && 'animate-bounce')}
          onDoubleClick={onPat}
          title="双击拍一拍"
        >
          <Avatar size="sm">
            <AvatarFallback><IconRobot size={14} /></AvatarFallback>
          </Avatar>
        </MessageAvatar>
        <MessageContent className="min-w-0">
          <MessageHeader className="gap-2">
            <span>{AGENT_ID}</span>
            <Badge variant="outline">
              {modelTag || 'AI'}
            </Badge>
            {!run.streaming && run.cached && (
              <Badge variant="secondary"><IconBolt />秒回</Badge>
            )}
          </MessageHeader>

          <ActivityTrace
            parts={run.parts}
            squad={squad}
          />

          {verification && <VerificationPart part={verification} />}

          {text ? (
            <Bubble variant="ghost" className="w-full">
            <MessageMenu message={run.message} canResend={canResend} onResend={onResend} onQuote={onQuote} onRemove={onRemove}>
            <BubbleContent
              data-testid="msg-bubble-assistant"
              tabIndex={0}
              aria-label={`${AGENT_NAME}的消息，按 Enter 打开操作菜单`}
              className="w-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <MessageContentText text={text.text} />
            </BubbleContent>
            </MessageMenu>
            </Bubble>
          ) : status && !hasTraceActivity ? (
            <Trace role="status"><TraceLine status="running"><TraceIcon><Spinner /></TraceIcon><TraceTitle>{status.text}</TraceTitle></TraceLine></Trace>
          ) : null}

          {stopped && (
            <Marker data-testid="message-stopped" role="status">
              <MarkerContent>{sys.stopped}</MarkerContent>
            </Marker>
          )}

          {failure && (
            <FailurePart
              part={failure}
              retryText={retryText}
              canResend={canResend}
              onResend={onResend}
            />
          )}

          {!run.streaming && (text || run.message.usage) && (
            <MessageFooter className="gap-2 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/message:opacity-100 sm:group-focus-within/message:opacity-100 motion-reduce:transition-none">
              {run.message.usage && (
                <span className="inline-flex items-center gap-1" title={`输入 ${run.message.usage.input} tokens · 输出 ${run.message.usage.output} tokens · 花费 ${money(run.message.cost ?? 0)}`}>
                  <IconCoin size={11} />{money(run.message.cost ?? 0)}
                </span>
              )}
              {text && <CopyButton text={text.text} />}
            </MessageFooter>
          )}
        </MessageContent>
      </Message>
    </>
  );
});

export { MemberSpeech };
