import type { ChatComposerController } from '../../hooks/useChatComposer';
import AttachmentControls from './AttachmentControls';
import { Children, useId, useState, type ReactNode } from 'react';
import { money } from '../../voice';
import {
  Brain as IconBrain,
  Check as IconCheck,
  ChevronDown as IconChevronDown,
  X as IconClose,
  Coins as IconCoin,
  Blocks as IconPlugin,
  CornerUpLeft as IconReturn,
  ArrowUp as IconSend,
  Settings2 as IconSettings,
  Square as IconStop,
} from 'lucide-react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Questionnaire } from '@shadcn/react/questionnaire';
import { cn } from '@/lib/utils';

const EMOJI = ['😊', '😂', '🥳', '👍', '🙏', '🤝', '🎉', '🔥', '💪', '🤔', '😴', '✅', '❤️', '🐑', '✨', '📌', '☕', '🌙', '👋', '🫡'];

interface Props {
  children?: ReactNode;
  composer: ChatComposerController;
  streaming: boolean;
  hasModels: boolean;
  sessionCost: number;
  models: { id: string; label: string; model: string }[];
  modelLabel: string;
  selectedModelId?: string;
  onSelectModel?: (id: string) => void;
  onStop: () => void;
  pendingInference?: { objective: string; rationale: string; confidence: number } | null;
  onConfirmInference?: (objective: string, acceptance: string) => void;
}

export default function ChatComposer({
  children,
  composer,
  streaming,
  hasModels,
  sessionCost,
  models,
  modelLabel,
  selectedModelId,
  onSelectModel,
  onStop,
  pendingInference,
  onConfirmInference,
}: Props) {
  const commandListId = useId();
  const [modelOpen, setModelOpen] = useState(false);
  const commandsVisible = composer.cmdOpen && composer.matched.length > 0;
  const context = Children.toArray(children);
  return (
    <div data-testid="chat-composer" className="mx-auto flex w-full max-w-3xl min-w-0 shrink-0 flex-col gap-2 px-4 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
      {(context.length > 0 || pendingInference) && (
        <ScrollArea data-testid="chat-context" role="region" aria-label="任务状态与审批" className="max-h-[min(22dvh,10rem)] [&_[data-slot=scroll-area-viewport]]:max-h-[min(22dvh,10rem)] [&_[data-slot=scroll-area-viewport]]:overscroll-contain">
          <div className="flex min-w-0 flex-col gap-2 pr-3">
          {pendingInference && (
            <Sheet key={pendingInference.objective}>
              <Item variant="outline" data-testid="task-confirm-card">
                <ItemContent className="min-w-0">
                  <ItemTitle>待补充验收条件</ItemTitle>
                  <ItemDescription>{pendingInference.objective}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <SheetTrigger asChild><Button variant="secondary" size="sm">补充验收条件</Button></SheetTrigger>
                </ItemActions>
              </Item>
              <SheetContent data-testid="task-confirm-sheet" className="gap-0 sm:max-w-md">
                <SheetHeader className="pr-12">
                  <SheetTitle>补充任务验收条件</SheetTitle>
                  <SheetDescription>{pendingInference.objective}</SheetDescription>
                </SheetHeader>
                <Questionnaire.Root
                  items={[{ name: 'acceptance', required: true }]}
                  defaultItem="acceptance"
                  className="flex min-h-0 flex-1 flex-col"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!streaming && composer.inferenceAcceptance.trim()) onConfirmInference?.(pendingInference.objective, composer.inferenceAcceptance);
                  }}
                >
                  <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
                    <Questionnaire.Progress className="sr-only" />
                    <p className="text-sm text-muted-foreground">
                      {pendingInference.rationale} · 置信度 {Math.round(pendingInference.confidence * 100)}%
                    </p>
                    <Questionnaire.Item name="acceptance" required className="flex flex-col gap-2">
                      <Questionnaire.Title className="text-sm font-medium">验收条件</Questionnaire.Title>
                      <Questionnaire.Description className="text-sm text-muted-foreground">
                        写清产物、必须包含的内容或其他可检查的完成标准。
                      </Questionnaire.Description>
                      <Questionnaire.Input
                        aria-label="验收条件"
                        value={composer.inferenceAcceptance}
                        onChange={(event) => composer.setInferenceAcceptance(event.target.value)}
                        placeholder="例如：生成 report.md，并在文件中包含结论"
                        disabled={streaming}
                        className="h-10 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                      />
                      <Questionnaire.Error className="text-xs text-destructive" />
                    </Questionnaire.Item>
                  </div>
                  <SheetFooter>
                    <Questionnaire.Submit
                      data-testid="task-confirm-submit"
                      disabled={!composer.inferenceAcceptance.trim() || streaming}
                      render={<Button />}
                    >
                      确认并执行
                    </Questionnaire.Submit>
                  </SheetFooter>
                </Questionnaire.Root>
              </SheetContent>
            </Sheet>
          )}
          {context}
          </div>
        </ScrollArea>
      )}

      {composer.quote && (
        <Alert data-testid="quote-bar">
          <IconReturn />
          <AlertTitle>引用 {composer.quote.author}</AlertTitle>
          <AlertDescription className="line-clamp-2">{composer.quote.text}</AlertDescription>
          <AlertAction>
            <Button data-testid="quote-cancel" variant="ghost" size="icon-xs" aria-label="取消引用" onClick={() => composer.setQuote(null)}>
              <IconClose />
            </Button>
          </AlertAction>
        </Alert>
      )}

      <div className="min-w-0">
        <Popover open={commandsVisible} onOpenChange={composer.setCmdOpen}>
        <PopoverAnchor asChild>
        <form className="w-full" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); void composer.uploadFiles(Array.from(event.dataTransfer.files)); } }} onSubmit={(event) => { event.preventDefault(); if (hasModels) composer.submit(); }}>
        <AttachmentControls composer={composer} />
        <InputGroup>
          <InputGroupTextarea
            ref={composer.inputRef}
            value={composer.input}
            placeholder={hasModels ? '跟 maharness 说点什么…（按 / 看命令）' : '先去左下角「设置」里配一个模型吧'}
            rows={2}
            aria-label="消息"
            aria-controls={commandsVisible ? commandListId : undefined}
            aria-activedescendant={commandsVisible ? `${commandListId}-${composer.matched[composer.cmdIdx]?.name}` : undefined}
            onChange={(event) => {
              composer.setInput(event.target.value);
              composer.setCmdOpen(event.target.value.startsWith('/'));
              composer.setCmdIdx(0);
            }}
            onKeyDown={composer.onKeyDown}
            disabled={!hasModels}
            className="max-h-[min(24dvh,12rem)] min-h-16"
          />
          <InputGroupAddon align="block-end" className="justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Popover open={modelOpen} onOpenChange={setModelOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    role="combobox"
                    aria-expanded={modelOpen}
                    aria-label={`切换模型，当前${modelLabel || '未选择模型'}`}
                    title="切换模型"
                    disabled={!hasModels || models.length === 0}
                    className="max-w-[min(50vw,16rem)]"
                  >
                    <IconBrain data-icon="inline-start" />
                    <span className="truncate">{modelLabel || '未选择模型'}</span>
                    <IconChevronDown data-icon="inline-end" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" side="top" className="w-72 p-0">
                  <Command>
                    <CommandInput placeholder="搜索模型…" />
                    <CommandList>
                      <CommandEmpty>没有匹配模型</CommandEmpty>
                      <CommandGroup heading="模型">
                        {models.map((model) => (
                          <CommandItem
                            key={model.id}
                            value={`${model.label} ${model.model}`}
                            onSelect={() => {
                              onSelectModel?.(model.id);
                              setModelOpen(false);
                            }}
                          >
                            <IconCheck className={cn('size-4', selectedModelId === model.id ? 'opacity-100' : 'opacity-0')} />
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate font-medium">{model.label}</span>
                              <span className="truncate font-mono text-[10px] text-muted-foreground">{model.model}</span>
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              {sessionCost > 0 && (
                <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex" title={`本会话累计花费 ${money(sessionCost)}`}>
                  <IconCoin size={11} />{money(sessionCost)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <Popover open={composer.emojiOpen} onOpenChange={composer.setEmojiOpen}>
                <PopoverTrigger asChild>
                  <InputGroupButton type="button" data-testid="emoji-btn" variant="ghost" size="icon-sm" aria-label="表情" title="表情">
                    😊
                  </InputGroupButton>
                </PopoverTrigger>
                <PopoverContent data-testid="emoji-panel" align="end" side="top" className="w-auto p-2" role="dialog" aria-label="表情">
                  <div className="grid grid-cols-7 gap-1">
                    {EMOJI.map((emoji) => (
                      <Button
                        key={emoji}
                        variant="ghost"
                        type="button"
                        size="icon-sm"
                        onClick={() => composer.setInput((value) => value + emoji)}
                        title={emoji}
                        aria-label={emoji}
                      >
                        {emoji}
                      </Button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
              {streaming ? (
                <InputGroupButton type="button" variant="destructive" size="icon-sm" onClick={onStop} aria-label="停止">
                  <IconStop />
                </InputGroupButton>
              ) : (
                <InputGroupButton
                  type="submit"
                  variant="default"
                  data-testid="send-btn"
                  size="icon-sm"
                  disabled={!composer.canSubmit || !hasModels}
                  aria-label="发送"
                >
                  <IconSend />
                </InputGroupButton>
              )}
            </div>
          </InputGroupAddon>
        </InputGroup>
        </form>
        </PopoverAnchor>
        <PopoverContent align="start" side="top" className="w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] p-0" onOpenAutoFocus={(event) => event.preventDefault()} onCloseAutoFocus={(event) => event.preventDefault()} onInteractOutside={(event) => { if (event.target instanceof Node && composer.inputRef.current?.contains(event.target)) event.preventDefault(); }}>
          <Command shouldFilter={false} value={composer.matched[composer.cmdIdx]?.name ?? ''} onValueChange={(name) => composer.setCmdIdx(Math.max(0, composer.matched.findIndex((command) => command.name === name)))}>
            <CommandList id={commandListId}>
              <CommandGroup heading="斜杠命令">
                {composer.matched.map((command) => (
                  <CommandItem id={`${commandListId}-${command.name}`} key={command.name} value={command.name} onSelect={() => composer.applyCommand(command)}>
                    {command.source === 'builtin' ? <IconSettings /> : <IconPlugin />}
                    <span>/{command.name}{command.usage ? ` ${command.usage}` : ''}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{command.description}</span>
                    <Badge variant="secondary">{command.source === 'builtin' ? '内置' : '插件'}</Badge>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
        </Popover>
      </div>
      <div className="mx-auto hidden text-center text-xs text-muted-foreground sm:block">
        <span className="font-mono">Enter</span> 发送 · <span className="font-mono">Shift+Enter</span> 换行 · <span className="font-mono">/</span> 命令 · <span className="font-mono">Esc</span> 让它停下
      </div>
    </div>
  );
}
