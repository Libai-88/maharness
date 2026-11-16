import { useEffect, useState } from 'react';
import type { ChatMessage } from '../../types';
import type { ChatTimelineItem } from '../../chat/model';
import { AGENT_NAME } from '../../voice';
import HeroSticker from '../HeroSticker';
import { UsersRound as IconParallel } from 'lucide-react';
import BrandMark from '@/brand/BrandMark';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { materialApi, type MaterialCapabilities } from '../../material-api';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { cn } from '@/lib/utils';
import { AssistantRun, UserMessage } from './message';

interface Props {
  timeline: ChatTimelineItem[];
  hasModels: boolean;
  onSend: (text: string) => void;
  onDraft?: (text: string) => void;
  canResend: boolean;
  onResend: (text: string) => void;
  modelTag: string;
  squad?: { total: number; done: number; failed: number; running: Record<string, string> };
  pattedId?: string | null;
  onPat: (id: string) => void;
  onQuote: (message: ChatMessage) => void;
  onRemove?: (id: string) => void;
  greet: string;
  streaming: boolean;
  onOpenSettings?: () => void;
}

export default function ChatThread({
  timeline,
  hasModels,
  onSend,
  onDraft,
  canResend,
  onResend,
  modelTag,
  squad,
  pattedId,
  onPat,
  onQuote,
  onRemove,
  greet,
  streaming,
  onOpenSettings,
}: Props) {
  const [capabilities, setCapabilities] = useState<MaterialCapabilities | null>(null);
  useEffect(() => {
    let alive = true;
    void materialApi.capabilities().then(value => { if (alive) setCapabilities(value); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  return (
    <MessageScrollerProvider defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport aria-label="对话消息">
          <MessageScrollerContent aria-busy={streaming} className="mx-auto w-full max-w-3xl min-w-0 gap-6 px-4 py-6 sm:px-6">
            {timeline.length === 0 && (
              <MessageScrollerItem messageId="hero">
                <div data-testid="chat-welcome" className="flex min-h-[min(54dvh,30rem)] flex-col items-center justify-center gap-6 py-4 sm:flex-row sm:gap-8 sm:py-8">
                  <Empty className="min-w-0 flex-1 px-0">
                    <EmptyHeader>
                      <EmptyMedia variant="icon"><BrandMark size={52} /></EmptyMedia>
                      <EmptyTitle>{greet}，我是 {AGENT_NAME}</EmptyTitle>
                      <EmptyDescription>
                        导入文件，说出你想完成的办公或学习任务。
                        <br />
                        查看资料、整理表格、制作文档，也能运行轻量自动化。
                      </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>
                      <div className="mb-2 flex flex-wrap justify-center gap-1.5">
                        {[
                          ['模型', hasModels],
                          ['文件处理', capabilities?.document ?? false],
                          ['联网', capabilities?.search ?? false],
                          ['OCR', Boolean(capabilities?.ocr?.status && capabilities.ocr.status !== 'disabled')],
                        ].map(([label, available]) => <Badge key={String(label)} variant={available ? 'secondary' : 'outline'}>{String(label)} · {available ? '可用' : '未配置'}</Badge>)}
                      </div>
                      {hasModels ? (
                        <div className="flex flex-wrap justify-center gap-2">
                          {['总结文件并标注来源', '整理表格并生成汇总', '把资料制作成汇报演示', '读懂并对比论文', '批量整理工作区文件'].map((suggestion) => (
                            <Button key={suggestion} variant="outline" size="sm" onClick={() => (onDraft ?? onSend)(suggestion)}>{suggestion}</Button>
                          ))}
                        </div>
                      ) : (
                        <>
                          <p className="text-sm text-muted-foreground">还没给我配模型——在「设置」里加上就能开始。</p>
                          <Button onClick={onOpenSettings}>配置模型</Button>
                        </>
                      )}
                    </EmptyContent>
                  </Empty>
                  <HeroSticker />
                </div>
              </MessageScrollerItem>
            )}

            {timeline.flatMap((item) => {
              if (item.kind === 'marker') {
                return [(
                  <MessageScrollerItem key={item.id} messageId={item.id}>
                    <Marker
                      variant={item.marker === 'time' ? 'separator' : 'default'}
                      className={cn(item.marker === 'time' && 'my-1')}
                      data-testid={item.marker === 'system' ? 'system-message' : undefined}
                      role={item.marker === 'join' ? 'status' : undefined}
                    >
                      {item.marker === 'join' && <MarkerIcon><IconParallel size={13} /></MarkerIcon>}
                      <MarkerContent>
                        {item.marker === 'join' ? <><b>{item.member}</b> 加入了协作</> : item.content}
                      </MarkerContent>
                    </Marker>
                  </MessageScrollerItem>
                )];
              }

              return [
                  item.user && (
                    <MessageScrollerItem key={`user:${item.user.id}`} messageId={item.user.id} scrollAnchor>
                      <UserMessage
                        message={item.user}
                        canResend={canResend}
                        onResend={onResend}
                        onQuote={onQuote}
                        onRemove={onRemove}
                      />
                    </MessageScrollerItem>
                  ),
                  ...item.runs.map((run) => (
                    <MessageScrollerItem key={run.id} messageId={run.id}>
                      <AssistantRun
                        run={run}
                        retryText={item.user?.content}
                        canResend={canResend}
                        onResend={onResend}
                        modelTag={modelTag}
                        squad={squad}
                        patted={pattedId === run.message.id}
                        onPat={() => onPat(run.message.id)}
                        onQuote={onQuote}
                        onRemove={onRemove}
                      />
                    </MessageScrollerItem>
                  )),
              ];
            })}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton aria-label="回到底部" />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
