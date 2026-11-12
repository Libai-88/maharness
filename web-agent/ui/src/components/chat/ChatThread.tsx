import type { ChatMessage } from '../../types';
import type { ChatTimelineItem } from '../../chat/model';
import HeroSticker from '../HeroSticker';
import { Bot, UsersRound as IconParallel } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
                      <EmptyMedia variant="icon"><Bot /></EmptyMedia>
                      <EmptyTitle>{greet}，我是小鲸</EmptyTitle>
                      <EmptyDescription>
                        想聊什么、想让我做什么，直接说就行。
                        <br />
                        要找文件、跑命令、上网查资料，喊我一声。
                      </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>
                      {hasModels ? (
                        <div className="flex flex-wrap justify-center gap-2">
                          {['起草一份技术方案', '追踪插件重载信号', '整理本周代码审查'].map((suggestion) => (
                            <Button key={suggestion} variant="outline" size="sm" onClick={() => onSend(suggestion)}>{suggestion}</Button>
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
