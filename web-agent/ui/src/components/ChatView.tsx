// ui/src/components/ChatView.tsx —— 主对话（Screen 1）：消息流 + 思考块 + 工具卡片 + 代码块 + 输入区 + 斜杠命令面板
// 性能设计：流式 token 只重渲染当前流式行——历史消息行由 memo(MessageRow) 跳过 reconcile，
// 文本增量由 App 侧 rAF 合帧后提交，渲染频率不超过显示器刷新率
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { commandsApi } from '../api';
import type { ApprovalItem, ChatMessage, CheckpointInfo, CommandInfo, PlanState, TodoCard, ToolStep } from '../types';
import { hueFrom, isSubagentTool, subagentLabel } from '../types';
import { shouldShowDivider, withJoins } from '../replay';
import { AGENT_ID, AGENT_NAME, approvalHead, chatTime, describeToolOutcome, money, stepLine, sys, tidySentence, toolDisplayName, toolOutcomeText } from '../voice';
import Markdown from './Markdown';
import BrandLogo from './BrandLogo';
import HeroSticker from './HeroSticker';
import Menu from './Menu';
import { fadeUp, msgRow, popIn, springTransition, staggerContainer, toolCardIn, userMsg } from '../motion';
import { IconBlock, IconBrain, IconBolt, IconCheck, IconChevronDown, IconChevronRight, IconCircle, IconClose, IconCoin, IconCopy, IconEye, IconLock, IconParallel, IconPaperclip, IconPause, IconPlan, IconPlay, IconPlugin, IconRefresh, IconReturn, IconRobot, IconSettings, IconSheep, IconStop, IconSwitch, IconTrash, IconUser, IconWarn } from './Icon';

interface Props {
  messages: ChatMessage[];
  streaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  hasModels: boolean;
  approvals: ApprovalItem[];
  onApproval: (id: string, approved: boolean) => void;
  plan: PlanState | null;
  /** todo 插件：当前会话的 to do list（模型执行任务时维护，实时更新） */
  todos?: TodoCard[];
  modelLabel?: string;
  modelTag?: string;
  /** 输入栏模型 pill 的可选项与切换回调（与顶栏共用同一数据源，保证两端一致） */
  models?: { id: string; label: string; model: string }[];
  onSelectModel?: (id: string) => void;
  selectedModelId?: string;
  /** 前置重活播报（历史压缩 / 换线路）：流式气泡里的"它正在做什么" */
  streamStatus?: string | null;
  /** 并行小队进度（parallel.progress 广播）：显示在"小队"成员气泡上 */
  squad?: { total: number; done: number; failed: number; running: Record<string, string> };
  /** 断点续跑（checkpoint）：任务中断后「继续任务」入口 */
  checkpoint?: CheckpointInfo | null;
  onResume?: () => void;
  resuming?: boolean;
  /** 角色接管（handoff）：当前会话由哪个角色处理（空 = 主代理） */
  role?: string;
  onRoleReset?: () => void;
  /** 成本熔断横幅（budget_hit） */
  budgetHit?: { cost: number; budget: number } | null;
  /** 会话累计成本（composer 实时显示） */
  sessionCost?: number;
  /** 拍一拍等前端彩蛋的系统消息出口（App 侧插入消息流） */
  onSystemMsg?: (content: string) => void;
  /** 会话切换键：切换会话时清理引用条等瞬态 */
  sessionKey?: string;
  /** 气泡长按菜单「删除」：仅从当前视图移除消息 */
  onRemoveMessage?: (id: string) => void;
  /** 当前 provider 密钥失效（健康回报）：横幅即时提示 */
  providerAuthFailed?: { label: string; lastError: string } | null;
  /** 横幅「更新密钥」入口 */
  onOpenSettings?: () => void;
}

function fmtMs(ms?: number): string {
  if (ms === undefined) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** 拍一拍彩蛋短语（随机一条，像被回应的感觉） */
const PAT_LINES = [
  '你拍了拍「maharness」的小脑袋，它愉快地摇了摇尾巴',
  '你拍了拍「maharness」，它说：在的在的，随叫随到',
  '你拍了拍「maharness」，它头顶冒出了一个小羊角',
  '你拍了拍「maharness」，它翻开手账本写了点什么',
];

/** 手账表情贴纸（表情面板） */
const EMOJI = ['😊', '😂', '🥳', '👍', '🙏', '🤝', '🎉', '🔥', '💪', '🤔', '😴', '✅', '❤️', '🐑', '✨', '📌', '☕', '🌙', '👋', '🫡'];

/** 气泡长按菜单（微信式：长按 / 右键 / 键盘 Shift+F10 或 Enter 呼出，按压有反馈）。
 *  自动化友好：菜单开合由确定性的 pointer 事件与键盘事件驱动——
 *  Playwright 用 mouse.down()+延时+mouse.up()、click({button:'right'}) 或 focus()+press() 均可稳定触发 */
function useBubbleMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [pressing, setPressing] = useState(false);
  const timerRef = useRef(0);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const clear = useCallback(() => {
    window.clearTimeout(timerRef.current);
    timerRef.current = 0;
    setPressing(false);
  }, []);
  const openAt = useCallback((x: number, y: number) => setMenu({ x, y }), []);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  const handlers = useMemo(() => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      originRef.current = { x: e.clientX, y: e.clientY };
      setPressing(true);
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        setPressing(false);
        setMenu(originRef.current ? { ...originRef.current } : null);
      }, 480);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const o = originRef.current;
      if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > 10) { clear(); originRef.current = null; }
    },
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      clear();
      setMenu({ x: e.clientX, y: e.clientY });
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      // 键盘等价操作（a11y + 自动化）：Enter 或 ContextMenu 键 / Shift+F10（Windows 上下文菜单标准键）
      if ((e.key === 'Enter' && !e.shiftKey) || (e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
        e.preventDefault();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setMenu({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      }
    },
  }), [clear]);
  const close = useCallback(() => setMenu(null), []);
  return { menu, pressing, handlers, close, openAt };
}

function argsSummary(args: unknown): string {
  try {
    const s = JSON.stringify(args);
    return s.length > 90 ? `${s.slice(0, 90)}…` : s;
  } catch { return String(args); }
}

/** 工具调用卡片（Warp 命令块风格；stored=大结果已入结果存储，recall_tool_result 可重读）
 *  memo 化：流式期间行内重渲染时，状态未变的工具卡跳过 reconcile */
const ToolCard = memo(function ToolCard({ t }: { t: ToolStep }) {
  const [open, setOpen] = useState(false);
  const running = t.status === 'running';
  const show = open || running;
  const statusCls = t.status === 'done' ? 'ok' : t.status === 'error' ? 'err' : 'run';
  const statusTxt = toolOutcomeText(t);
  const said = t.summary ? describeToolOutcome(t.name, t.summary, t.status !== 'error' && t.ok !== false) : '';
  return (
    <motion.div
      className={`tool-card ${running ? 'running' : t.status === 'done' ? 'done' : 'err'} ${show ? 'expanded' : ''}`}
      variants={toolCardIn}
      initial="initial"
      animate="enter"
      exit="exit"
      onClick={() => { if (!running) setOpen((v) => !v); }}
      style={{ cursor: running ? 'default' : 'pointer' }}
      role="button"
      tabIndex={running ? -1 : 0}
      aria-expanded={show}
      aria-label={`${toolDisplayName(t.name)}（${statusTxt}）——点击${show ? '收起' : '展开'}详情`}
      onKeyDown={(e) => { if (!running && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen((v) => !v); } }}
    >
      <div className="tool-head">
        <div className="tool-head-left">
          <motion.span
            className={`tool-icon ${statusCls}`}
            key={t.status}
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={springTransition}
          >
            {t.status === 'done' ? <IconCheck size={12} /> : t.status === 'error' ? <IconWarn size={12} /> : <IconRefresh size={12} />}
          </motion.span>
          {/* 给人看的中文动作，原始函数名留在 tooltip 里可查 */}
          <span className="tool-name" title={t.name}>{toolDisplayName(t.name)}</span>
          <span className="tool-path">{t.args ? argsSummary(t.args) : ''}</span>
          {t.stored && <span className="tool-stored" title="大结果已存入结果存储——Agent 可用 recall_tool_result 零副作用重读全文"><IconPaperclip size={10} /> 已存</span>}
        </div>
        <div className="tool-head-right">
          <span className={`tool-status ${statusCls}`}><span className="sd" />{statusTxt}</span>
          <span className="tool-dur">{fmtMs(t.durationMs)}</span>
          <span style={{ color: 'var(--text-4)', display: 'inline-flex', transform: show ? 'none' : 'rotate(-90deg)', transition: 'transform .15s' }}><IconChevronDown size={11} /></span>
        </div>
      </div>
      {said && (
        <div className="tool-body">
          <span className="t-out">{said}</span>
          {t.stored && <span className="tool-stored-note">完整结果已存入结果存储（本会话内 recall_tool_result 可重读，零副作用）</span>}
        </div>
      )}
    </motion.div>
  );
});

/** 群成员发言卡（微信群聊隐喻）：子代理类工具调用渲染为成员头像 + 昵称 + 气泡，
 *  运行中显示「正在忙碌」气泡（目标即发言内容），完成后气泡切换为结果摘要 */
const MemberSpeech = memo(function MemberSpeech({ t, progress }: { t: ToolStep; progress?: { total: number; done: number; failed: number; running: string[] } }) {
  const [open, setOpen] = useState(false);
  const label = subagentLabel(t.name, t.args) ?? t.name;
  const hue = hueFrom(label);
  const running = t.status === 'running';
  const objective = (() => {
    try {
      const a = (t.args ?? {}) as { objective?: string; target?: string };
      const s = String(a.objective ?? a.target ?? '').trim();
      return s.length > 120 ? `${s.slice(0, 120)}…` : s;
    } catch { return ''; }
  })();
  const detail = argsSummary(t.args);
  // 群成员开口说人话：子代理的返回是 {"ok":true,"data":{"answer":"…"}} 这种信封，
  // 直接当气泡内容就是在念 JSON（旧版实测原文：{"ok":false,"error":"子代理失败…"）
  const bubble = running
    ? (objective || '正在忙…')
    : (t.summary ? stepLine(t) : (objective || (t.ok === false ? '这事儿我没办成' : '办好了')));
  return (
    <motion.div
      className={`wx-member-speech ${running ? 'running' : t.ok ? 'ok' : 'err'}`}
      variants={toolCardIn}
      initial="initial"
      animate="enter"
      exit="exit"
    >
      <span
        className="wx-avatar wx-avatar-speech"
        style={{ '--h': hue } as React.CSSProperties}
        aria-hidden
      >
        {t.name === 'run_review' ? <IconEye size={14} /> : t.name === 'run_parallel' ? <IconParallel size={14} /> : <IconRobot size={14} />}
      </span>
      <div className="wx-member-col">
        <span className="wx-member-name">{label}</span>
        <div
          className={`wx-bubble them wx-member-bubble ${open ? 'expanded' : ''}`}
          onClick={() => { if (!running) setOpen((v) => !v); }}
          role="button"
          tabIndex={running ? -1 : 0}
          aria-expanded={open}
          aria-label={`群成员 ${label}（${running ? '在做' : t.ok === false ? '没成' : '办好'}）${open ? '收起' : '展开'}详情`}
          onKeyDown={(e) => { if (!running && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen((v) => !v); } }}
        >
          <span className="wx-member-text">{bubble}</span>
          {running && <span className="wx-busy-dots"><i /><i /><i /></span>}
          {/* 小队分头干活的进度：几路交回、正在做哪一路（没有它就只能干等 4 分钟超时） */}
          {running && progress && progress.total > 0 && (
            <span className="wx-member-progress">
              <span className="wmp-track"><i style={{ width: `${Math.round(((progress.done + progress.failed) / progress.total) * 100)}%` }} /></span>
              <span className="wmp-text">
                {progress.done + progress.failed}/{progress.total} 交回
                {progress.failed > 0 ? ` · ${progress.failed} 没成` : ''}
                {progress.running[0] ? ` · 正在做：${tidySentence(progress.running[0], 18)}` : ''}
              </span>
            </span>
          )}
          {t.ok === false && <span className="wx-member-err"><IconWarn size={11} /> 没办成</span>}
          {!running && t.durationMs !== undefined && <span className="wx-member-meta">{fmtMs(t.durationMs)}</span>}
        </div>
        {!running && detail && open && (
          <pre className="wx-member-detail">{detail}</pre>
        )}
      </div>
    </motion.div>
  );
});

/** 复制按钮（带瞬时 ✓ 反馈，hover 浮现于消息操作区） */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="ma-btn"
      title={copied ? '已复制' : '复制回复'}
      aria-label={copied ? '已复制' : '复制回复'}
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => undefined);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
    </button>
  );
}

/** 单行代码高亮：先转义 HTML 特殊字符再着色。模型输出为不可信输入——
 *  未转义文本直接注入会形成 XSS 面（<img onerror>、</span><script> 逃逸）；
 *  着色 span 完全由本函数生成，原始文本只以纯文本形式进入 DOM。 */
export function highlightLine(line: string): string {
  const esc = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc
    .replace(/(\/\/.*$)/, (m) => `<span class="cm">${m}</span>`)
    .replace(/('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g, (m) => `<span class="st">${m}</span>`)
    .replace(/\b(import|from|export|default|const|let|var|function|return|async|await|new|class|this|interface|type)\b/g, (m) => `<span class="kw">${m}</span>`);
}

/** 代码块：简化语言高亮（关键字/字符串/注释）；memo + useMemo——同一代码块不因流式渲染反复重新着色 */
const CodeBlock = memo(function CodeBlock({ code, lang = '' }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const hl = useMemo(() => code.split('\n').map(highlightLine).join('\n'), [code]);
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang"><span className="cl-dot" />{lang || 'code'}</span>
        <div className="code-actions">
          <button className="code-copy" onClick={() => { navigator.clipboard?.writeText(code).catch(() => undefined); setCopied(true); setTimeout(() => setCopied(false), 1200); }} title="复制代码" aria-label="复制代码">{copied ? <IconCheck size={12} /> : <IconCopy size={13} />}</button>
        </div>
      </div>
      <pre className="code-body" dangerouslySetInnerHTML={{ __html: hl }} />
    </div>
  );
});

/** 渲染 assistant 消息内容：含代码块的轻量 markdown 分段 */
function renderContent(text: string) {
  const parts: React.ReactNode[] = [];
  const blocks = text.split(/```(\w*)\n([\s\S]*?)```/g);
  for (let i = 0; i < blocks.length; i++) {
    if (i % 3 === 0) {
      if (blocks[i].trim()) parts.push(<div key={i} className="assistant-text"><Markdown text={blocks[i]} /></div>);
    } else if (i % 3 === 1) {
      parts.push(<CodeBlock key={i} code={blocks[i + 1] ?? ''} lang={blocks[i]} />);
      i++;
    }
  }
  return parts;
}

/** 单条消息行。memo 化是流式渲染性能的关键：App 每帧提交一次文本增量时，
 *  只有 content 变化的流式行重渲染，历史行（含 Markdown/代码块）整体跳过 reconcile。 */
const MessageRow = memo(function MessageRow({ m, canResend, expanded, onToggleExpand, onResend, modelTag, showTime, patted, onPat, onQuote, onRemove, statusText, squad }: {
  m: ChatMessage;
  canResend: boolean;
  expanded: boolean;
  onToggleExpand: (id: string) => void;
  onResend: (text: string) => void;
  modelTag: string;
  /** 流式期间的活动播报（压缩历史 / 换线路…）：气泡里"它正在做什么" */
  statusText?: string | null;
  /** 并行小队进度（挂在"小队"成员气泡上） */
  squad?: { total: number; done: number; failed: number; running: Record<string, string> };
  /** 微信式时间分隔线（与上一条消息间隔 > 5 分钟时由父级计算） */
  showTime?: boolean;
  /** 拍一拍：头像摇晃反馈 */
  patted?: boolean;
  onPat?: () => void;
  /** 气泡长按菜单：引用 / 删除 */
  onQuote?: (m: ChatMessage) => void;
  onRemove?: (id: string) => void;
}) {
  // 用户主动打断：留一条温和的系统条（谁按了停止是事实，不该装成故障）
  // hook 必须在 early return 之前调用（system 行不挂菜单，但 hook 无条件调用）
  const { menu, pressing, handlers, close } = useBubbleMenu();
  const bubbleMenu = menu && (
    <>
      <div className="wx-menu-overlay" data-testid="bubble-menu-overlay" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
      <div
        className="wx-bubble-menu"
        data-testid="bubble-menu"
        style={{
          left: Math.max(96, Math.min(menu.x, window.innerWidth - 96)),
          top: Math.max(120, Math.min(menu.y - 6, window.innerHeight - 40)),
        }}
        role="menu"
        aria-label="消息操作"
      >
        <button role="menuitem" data-testid="menu-copy" onClick={() => { navigator.clipboard?.writeText(m.content).catch(() => undefined); close(); }}>
          <IconCopy size={13} />复制
        </button>
        {m.role === 'user' ? (
          canResend && (
            <button role="menuitem" data-testid="menu-resend" onClick={() => { onResend(m.content); close(); }}>
              <IconRefresh size={13} />重新发送
            </button>
          )
        ) : (
          <button role="menuitem" data-testid="menu-quote" onClick={() => { onQuote?.(m); close(); }}>
            <IconReturn size={13} />引用
          </button>
        )}
        <button role="menuitem" data-testid="menu-remove" className="wm-danger" title="仅从当前视图移除（服务端记录保留）" onClick={() => { onRemove?.(m.id); close(); }}>
          <IconTrash size={13} />删除
        </button>
      </div>
    </>
  );
  const divider = showTime && m.ts ? (
    <div className="wx-time-divider" key={`${m.id}-t`}>{chatTime(m.ts)}</div>
  ) : null;
  const content = m.retryFrom ? m.content.slice(m.retryFrom) : m.content;
  const reasoning = m.retryFromReasoning ? (m.reasoning ?? '').slice(m.retryFromReasoning) : m.reasoning;
  // 旁白：模型"决定调工具"那几轮说的话（多半是英文工作日志）。它不是答复，
  // 所以不进正文气泡；但它确实发生过，所以留在演出里，可折叠查看。
  const narration = (m.narration ?? []).filter((s) => s.trim());
  // 微信式系统消息（子代理入群 / 斜杠命令反馈）：居中灰色系统条
  if (m.role === 'system') {
    return (
      <Fragment>
        {divider}
        <motion.div className="msg-row sys" variants={msgRow} initial="initial" animate="enter" exit="exit">
          <div className={`wx-sys-msg ${m.sysKind === 'join' ? 'join' : ''}`}>
            {m.sysKind === 'join' ? (<><IconParallel size={12} /> <b>{m.member}</b> 加入了群聊</>) : m.content}
          </div>
        </motion.div>
      </Fragment>
    );
  }
  return (
    <Fragment>
      {divider}
      <motion.div
        className={`msg-row ${m.role === 'user' ? 'me' : 'them'} ${m.streaming ? 'streaming' : ''} ${m.cached && !m.streaming ? 'cached' : ''}`}
        variants={m.role === 'user' ? userMsg : msgRow}
        initial="initial"
        animate="enter"
        exit="exit"
      >
      {m.role !== 'user' ? (
        <>
          <span
            className={`wx-avatar wx-avatar-agent ${patted ? 'wx-patted' : ''}`}
            aria-hidden
            onDoubleClick={onPat}
            title="双击拍一拍"
          ><IconSheep size={16} /></span>
          <div className="msg-col">
            <div className="msg-meta">
              <span className="msg-author">{AGENT_ID}</span>
              <span className="msg-tag">{modelTag || 'AI'}</span>
              {/* 会话头已经在说"正在输入"，这里不再重复第二遍；只保留缓存徽标这种好消息 */}
              {!m.streaming && m.cached && <span className="msg-extra"><IconBolt size={11} /> 秒回（缓存）</span>}
              {!m.streaming && (content || m.usage) && (
                <span className="msg-actions">
                  {m.usage && (
                    // 账单不糊在脸上：平时只有一个 ⓘ，鼠标停上去才看这条花了多少
                    <span className="ma-cost" title={`输入 ${m.usage.input} tokens · 输出 ${m.usage.output} tokens · 花费 ${money(m.cost ?? 0)}`}>
                      <IconCoin size={11} />{money(m.cost ?? 0)}
                    </span>
                  )}
                  {content && <CopyButton text={content} />}
                </span>
              )}
            </div>
            {/* 旁白：它转去干活之前自己嘟囔的那几句（默认收起，点开可见） */}
            {narration.length > 0 && (
              <details className="wx-narration">
                <summary>
                  <IconBrain size={11} />
                  <span>{m.streaming ? `${AGENT_NAME}边想边做…` : `${AGENT_NAME}当时在想`}</span>
                  <span className="wn-count">{narration.length} 段</span>
                </summary>
                <div className="wn-body">
                  {narration.map((s, i) => <p key={i}>{s}</p>)}
                </div>
              </details>
            )}
            {m.tools && m.tools.length > 0 && m.tools.map((t, i) => (
              isSubagentTool(t.name)
                ? (
                  <MemberSpeech
                    key={t.id ?? `${t.name}-${i}`}
                    t={t}
                    progress={t.name === 'run_parallel' && squad && squad.total > 0
                      ? { total: squad.total, done: squad.done, failed: squad.failed, running: Object.values(squad.running) }
                      : undefined}
                  />
                )
                : <ToolCard key={t.id ?? `${t.name}-${i}`} t={t} />
            ))}
            {reasoning && reasoning.length > 0 && (
              <div className={`think-card ${expanded ? 'expanded' : ''} ${m.streaming ? 'streaming' : ''}`}>
                <div className="think-head">
                  <span className="think-dot"><IconBrain size={12} /></span>
                  <span className="think-label">{m.streaming ? '动脑筋中' : '当时的思考'}</span>
                  <span className="think-dur">{m.streaming ? '' : expanded ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}</span>
                  <button
                    style={{ marginLeft: 'auto', color: 'var(--text-4)', fontSize: 11 }}
                    onClick={() => onToggleExpand(m.id)}
                    aria-expanded={expanded}
                  >
                    {m.streaming ? '进行中' : expanded ? '收起' : '展开'}
                  </button>
                </div>
                <div className="think-body">{reasoning}{m.streaming && <span className="stream-cursor" />}</div>
              </div>
            )}
            {content ? (
              m.streaming ? (
                <div className={`wx-bubble them assistant-text ${pressing ? 'press-dim' : ''}`} data-testid="msg-bubble-assistant" {...handlers}>{content}<span className="stream-cursor" /></div>
              ) : (
                <div className={`wx-bubble them ${pressing ? 'press-dim' : ''}`} data-testid="msg-bubble-assistant" tabIndex={0} aria-label={`${AGENT_NAME}的消息，按 Enter 打开操作菜单`} {...handlers}>{renderContent(content)}</div>
              )
            ) : m.streaming ? (
              // 开口前也有话说：压缩历史/换线路这类前置重活会经 streamStatus 播报
              <div className={`wx-bubble them assistant-text ${pressing ? 'press-dim' : ''}`} style={{ color: 'var(--text-3)' }} {...handlers}>
                {statusText || '在想…'}<span className="stream-cursor" />
              </div>
            ) : null}
            {/* 用户自己按的停止：一句温和的话，而不是红色报错 */}
            {m.stopped && !content && (
              <div className="wx-stopped">{sys.stopped}</div>
            )}
            {m.error && (
              <div className="wx-failure" title={m.errorRaw ?? undefined}>
                <IconWarn size={12} />
                <span>{m.error}</span>
                {canResend && (
                  <button className="wf-retry" onClick={() => onResend(content || m.content)}>再试一次</button>
                )}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="msg-col me">
            {canResend && (
              <div className="msg-meta me-meta">
                <span className="msg-actions">
                  <button className="ma-btn" title="重新发送（重试）" aria-label="重新发送" onClick={() => onResend(m.content)}><IconRefresh size={12} /></button>
                </span>
              </div>
            )}
            <div
              className={`user-bubble ${pressing ? 'press-dim' : ''}`}
              data-testid="msg-bubble-user"
              tabIndex={0}
              aria-label="你发送的消息，按 Enter 打开操作菜单"
              {...handlers}
            >{m.content}</div>
          </div>
          <span className="wx-avatar wx-avatar-me" aria-hidden><IconUser size={15} /></span>
        </>
      )}
      </motion.div>
      {bubbleMenu}
    </Fragment>
  );
});

export default function ChatView({ messages, streaming, onSend, onStop, hasModels, approvals, onApproval, plan, todos = [], modelLabel = '', modelTag = '', models = [], onSelectModel, selectedModelId, streamStatus, squad, checkpoint, onResume, resuming = false, role, onRoleReset, budgetHit, sessionCost = 0, onSystemMsg, sessionKey, onRemoveMessage, providerAuthFailed, onOpenSettings }: Props) {
  const [input, setInput] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pendingApprovals, setPendingApprovals] = useState<Record<string, 'approve' | 'reject'>>({});
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdIdx, setCmdIdx] = useState(0);
  // 审批卡的"等了多久 / 还剩多久"：有卡时才起 1s 心跳（空闲零开销）
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!approvals.length) return;
    setNowTick(Date.now());
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [approvals.length]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 输入历史（↑/↓ 回放，终端习惯——快速高效响应）
  const [inputHist, setInputHist] = useState<string[]>([]);
  const histIdxRef = useRef(-1);

  // ---- 智能滚动跟随 ----
  // 贴底才跟随：用户上滚阅读时流式输出不抢屏（不再每个 token 触发 smooth scrollIntoView
  // 反复重启动画）；脱离底部出现「回到底部」按钮。开关 maharness-auto-scroll 可关自动跟随。
  const scrollBoxRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  const scrollRafRef = useRef(0);
  const [autoFollow] = useState(() => { try { return localStorage.getItem('maharness-auto-scroll') !== 'off'; } catch { return true; } });

  const handleScroll = useCallback(() => {
    if (scrollRafRef.current) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0;
      const el = scrollBoxRef.current;
      if (!el) return;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      if (atBottom !== pinnedRef.current) { pinnedRef.current = atBottom; setPinned(atBottom); }
    });
  }, []);

  useEffect(() => {
    if (messages.length === 0) { pinnedRef.current = true; setPinned(true); return; }
    if (!autoFollow || !pinnedRef.current) return;
    const el = scrollBoxRef.current;
    // 即时跟滚（scrollTop 直赋）：流式期间 smooth 动画会被下一次更新打断重启，抖动且费帧
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, autoFollow]);

  const jumpToBottom = useCallback(() => {
    const el = scrollBoxRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    pinnedRef.current = true;
    setPinned(true);
  }, []);

  // 输入框随内容增高（CSS 上限 200px 内部滚动），发送/清空后回落
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  useEffect(() => { commandsApi.list().then((r) => setCommands(r.commands)).catch(() => undefined); }, []);

  const submit = (textOverride?: string) => {
    const text = (textOverride ?? input).trim();
    if (!text || streaming) return;
    // 引用回复：引用块随消息一起上送（LLM 能看到引用的上下文）
    const full = quote ? `【引用 ${quote.author}】\n${quote.text}\n\n${text}` : text;
    if (textOverride === undefined && text) {
      setInputHist((prev) => [text, ...prev].slice(0, 30));
      histIdxRef.current = -1;
    }
    setInput('');
    setQuote(null);
    setCmdOpen(false);
    setEmojiOpen(false);
    onSend(full);
  };

  // 稳定引用回调（配合 memo(MessageRow)：打字/流式期间历史消息行不因回调身份变化重渲染）
  const toggleExpand = useCallback((id: string) => setExpanded((e) => ({ ...e, [id]: !e[id] })), []);
  // 重发不走输入历史（终端语义：历史回放只记录手动输入）
  const resend = useCallback((text: string) => { if (text.trim() && !streaming) onSend(text); }, [streaming, onSend]);

  // 拍一拍：双击 agent 头像 → 系统条彩蛋 + 头像摇晃
  const [patId, setPatId] = useState<string | null>(null);
  const patTimerRef = useRef(0);
  const patAgent = useCallback((id: string) => {
    const line = PAT_LINES[Math.floor(Math.random() * PAT_LINES.length)];
    onSystemMsg?.(line);
    setPatId(id);
    window.clearTimeout(patTimerRef.current);
    patTimerRef.current = window.setTimeout(() => setPatId(null), 1100);
  }, [onSystemMsg]);
  useEffect(() => () => window.clearTimeout(patTimerRef.current), []);

  // 渲染节点：消息 + 从工具卡派生的「XX 加入了群聊」。
  // 派生而非存储——所以「群成员」在实时与刷新后必然一致（旧版把它塞进 messages，
  // 刷新一次群聊就散伙、顶栏从「群聊」退回「私聊」）。
  const nodes = useMemo(() => withJoins(messages), [messages]);
  // 微信式时间分隔线：与上一条间隔 > 5 分钟（或首条有时间戳）
  const timeFlags = useMemo(() => {
    let prevTs: number | undefined;
    return nodes.map((n) => {
      const ts = n.kind === 'msg' ? n.msg.ts : n.ts;
      const show = shouldShowDivider(prevTs, ts);
      if (ts) prevTs = ts;
      return show;
    });
  }, [nodes]);

  // 开场问候按时间段变化（有温度的第一句）
  const hour = new Date().getHours();
  const greet = hour < 5 ? '夜深了' : hour < 9 ? '早上好' : hour < 12 ? '上午好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : hour < 23 ? '晚上好' : '夜深了';

  // ---- 输入区活感：引用回复 / 表情面板 ----
  const [quote, setQuote] = useState<{ author: string; text: string } | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const quoteMsg = useCallback((m: ChatMessage) => {
    setQuote({ author: m.role === 'user' ? '你' : AGENT_NAME, text: m.content.slice(0, 400) });
    inputRef.current?.focus();
  }, []);
  // 切换会话清理瞬态（引用条 / 表情面板）
  useEffect(() => { setQuote(null); setEmojiOpen(false); }, [sessionKey]);

  const matched = input.startsWith('/')
    ? commands.filter((c) => {
        const q = input.slice(1).toLowerCase();
        return !q || c.name.startsWith(q) || q.startsWith(c.name);
      })
    : [];

  const applyCommand = (cmd: CommandInfo, execute = true) => {
    if (cmd.usage) {
      setInput(`/${cmd.name} `);
      inputRef.current?.focus();
      setCmdOpen(false);
    } else if (execute) {
      setInput(`/${cmd.name}`);
      submit(`/${cmd.name}`);
    } else {
      setInput(`/${cmd.name} `);
      inputRef.current?.focus();
      setCmdOpen(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (cmdOpen && matched.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCmdIdx((i) => (i + 1) % matched.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCmdIdx((i) => (i - 1 + matched.length) % matched.length); return; }
      if (e.key === 'Escape') { e.preventDefault(); setCmdOpen(false); return; }
      if (e.key === 'Tab') { e.preventDefault(); applyCommand(matched[cmdIdx], false); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); applyCommand(matched[cmdIdx]); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); return; }
    // 输入历史回放（↑/↓）：空输入框时↑取上一条（终端习惯）
    if (e.key === 'ArrowUp' && !input && inputHist.length > 0) {
      e.preventDefault();
      histIdxRef.current = Math.min(histIdxRef.current + 1, inputHist.length - 1);
      setInput(inputHist[histIdxRef.current]);
    } else if (e.key === 'ArrowDown' && histIdxRef.current >= 0) {
      e.preventDefault();
      histIdxRef.current -= 1;
      setInput(histIdxRef.current >= 0 ? inputHist[histIdxRef.current] : '');
    }
    if (e.key === 'Escape') {
      if (emojiOpen) { e.preventDefault(); setEmojiOpen(false); return; }
      if (streaming) { e.preventDefault(); onStop(); }
    }
  };

  return (
    <div className="chat-area">
      {/* ---- 会话状态横幅：这是"朋友遇到点小状况，顺便告诉你一声"，不是系统告警 ---- */}
      {(providerAuthFailed || role || (checkpoint?.exists && !streaming) || budgetHit) && (
        <div className="session-banners">
          {providerAuthFailed && (
            <div className="sess-banner auth" title={providerAuthFailed.lastError}>
              <span className="sb-icon"><IconLock size={13} /></span>
              <span className="sb-text">{AGENT_NAME}的一条线路钥匙过期了（<b>{providerAuthFailed.label}</b>）——我已经换了一条继续陪你聊，不影响使用</span>
              <button className="sb-btn" onClick={onOpenSettings}>去换钥匙</button>
            </div>
          )}
          {checkpoint?.exists && !streaming && !resuming && (
            <div className="sess-banner resume">
              <span className="sb-icon"><IconPause size={13} /></span>
              <span className="sb-text">上次做到第 {checkpoint.turn + 1} 轮停下了，之前做完的都还在</span>
              <button className="sb-btn" onClick={onResume} disabled={resuming}>接着说</button>
            </div>
          )}
          {resuming && (
            <div className="sess-banner resume">
              <span className="sb-icon"><span className="spin" style={{ borderColor: 'var(--accent)' }} /></span>
              <span className="sb-text">{sys.resumed}</span>
            </div>
          )}
          {role && (
            <div className="sess-banner role">
              <span className="sb-icon"><IconSwitch size={13} /></span>
              <span className="sb-text">这件事现在由「<b>{role}</b>」接手</span>
              <button className="sb-btn" onClick={onRoleReset}>换回{AGENT_NAME}</button>
            </div>
          )}
          {budgetHit && (
            <div className="sess-banner budget">
              <span className="sb-icon"><IconCoin size={13} /></span>
              <span className="sb-text">这次先到这儿——预算用完了（已用 {money(budgetHit.cost)} / 预算 {money(budgetHit.budget)}）。做完的事都留在上面了</span>
              <button className="sb-btn" onClick={onOpenSettings}>去调预算</button>
            </div>
          )}
        </div>
      )}
      <div className="messages" ref={scrollBoxRef} onScroll={handleScroll}>
        <div className="messages-inner">
          {/* 计划/待办卡从消息流顶部挪到输入框上方常驻（见下方 goal-strip）：
              它属于"当前在干什么"，钉在消息开头的话一滚就再也找不到 */}

          {messages.length === 0 && (
            <motion.div
              className="brand-hero"
              variants={staggerContainer}
              initial="initial"
              animate="enter"
            >
              <motion.div variants={fadeUp}><BrandLogo size={96} /></motion.div>
              <motion.div variants={fadeUp} className="brand-title">{greet}，我是{AGENT_NAME}</motion.div>
              <motion.div variants={fadeUp} className="brand-slogan">
                想聊什么、想让我做什么，直接说就行。<br />
                要找文件、跑命令、上网查资料，喊我一声——做不完的我会接着做。
              </motion.div>
              <motion.div variants={fadeUp} className="brand-kbd"><span className="bk">/</span> 看看我能干什么 <span className="bk">Enter</span> 发送</motion.div>
              {!hasModels && <motion.div variants={fadeUp} className="brand-note">还没给我配模型——在左下角「设置」里加上就能开始聊了。</motion.div>}
              <motion.div variants={fadeUp} className="hero-pills">
                <button className="hero-pill" onClick={() => onSend('起草一份技术方案')}><span className="hp-ico">✦</span>起草一份技术方案</button>
                <button className="hero-pill" onClick={() => onSend('追踪插件重载信号')}><span className="hp-ico">◆</span>追踪插件重载信号</button>
                <button className="hero-pill" onClick={() => onSend('整理本周代码审查')}><span className="hp-ico">✚</span>整理本周代码审查</button>
              </motion.div>
              {/* 手账贴纸：可换图的胶带拍立得（点击相纸换本地照片） */}
              <HeroSticker />
            </motion.div>
          )}

          <AnimatePresence initial={false}>
          {nodes.map((n, i) => n.kind === 'join' ? (
            // 群成员入群：从工具卡派生（不落库也能跨刷新一致），保留微信那点仪式感
            <motion.div key={n.key} className="msg-row sys" variants={msgRow} initial="initial" animate="enter" exit="exit">
              <div className="wx-sys-msg join"><IconParallel size={12} /> <b>{n.member}</b> 加入了群聊</div>
            </motion.div>
          ) : (
            <MessageRow
              key={n.key}
              m={n.msg}
              canResend={!streaming}
              expanded={!!expanded[n.msg.id]}
              onToggleExpand={toggleExpand}
              onResend={resend}
              modelTag={modelTag}
              showTime={timeFlags[i]}
              statusText={n.msg.streaming ? streamStatus : null}
              squad={squad}
              patted={patId === n.msg.id}
              onPat={() => patAgent(n.msg.id)}
              onQuote={quoteMsg}
              onRemove={onRemoveMessage}
            />
          ))}
          </AnimatePresence>
        </div>
      </div>

      {/* 脱离底部时的「回到底部」悬浮按钮（流式输出期间上滚阅读必备） */}
      {!pinned && messages.length > 0 && (
        <motion.button
          className="jump-bottom"
          onClick={jumpToBottom}
          title="回到底部"
          aria-label="回到底部"
          variants={popIn}
          initial="initial"
          animate="enter"
          exit="exit"
        >
          <IconChevronDown size={14} />
        </motion.button>
      )}

      {approvals.length > 0 && (
        <div style={{ padding: '0 24px 8px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <AnimatePresence initial={false}>
          {approvals.map((a) => (
            <motion.div
              key={a.id}
              className="approval-card"
              style={{ maxWidth: 760, margin: '0 auto', width: '100%' }}
              variants={msgRow}
              initial="initial"
              animate="enter"
              exit="exit"
            >
              <div className="a-title">
                <span className="a-lock"><IconLock size={13} /></span>
                {approvalHead(a.name).title} · {approvalHead(a.name).sub}
                {/* 服务端在等你点头（超时自动取消）——把"等了多久/还剩多久"摆出来，
                    不然用户看不出这张卡是有时限的 */}
                {typeof a.createdAt === 'number' && (
                  <span className="a-wait" title="超过时限会自动取消">
                    {nowTick - a.createdAt < 60_000
                      ? `等了 ${Math.max(1, Math.round((nowTick - a.createdAt) / 1000))} 秒`
                      : `等了 ${Math.floor((nowTick - a.createdAt) / 60_000)} 分钟`}
                    {typeof a.expiresAt === 'number' && a.expiresAt > nowTick
                      ? ` · 还剩 ${Math.max(1, Math.ceil((a.expiresAt - nowTick) / 60_000))} 分钟`
                      : ''}
                  </span>
                )}
                <span className="a-pulse" />
              </div>
              <pre className="a-summary" title={a.name}>{tidySentence(a.summary, 200)}</pre>
              <div className="approval-actions">
                <button
                  className="btn-primary"
                  disabled={!!pendingApprovals[a.id]}
                  onClick={() => { setPendingApprovals((p) => ({ ...p, [a.id]: 'approve' })); onApproval(a.id, true); }}
                >
                  {pendingApprovals[a.id] === 'approve' ? <span className="spin" /> : null}可以，去做吧
                </button>
                <button
                  className="btn-ghost"
                  disabled={!!pendingApprovals[a.id]}
                  onClick={() => { setPendingApprovals((p) => ({ ...p, [a.id]: 'reject' })); onApproval(a.id, false); }}
                >
                  {pendingApprovals[a.id] === 'reject' ? <span className="spin" /> : null}先别
                </button>
              </div>
            </motion.div>
          ))}
          </AnimatePresence>
        </div>
      )}

      {/* 目标 / 待办常驻条：挂在输入框上方，滚到哪儿都看得见（旧版钉在消息流顶端，一滚就丢） */}
      {(plan || todos.length > 0) && (
        <details className="goal-strip" open={!!plan && !plan.completed}>
          <summary>
            <IconPlan size={13} />
            <span className="gs-title">
              {plan
                ? (plan.completed ? '目标已完成' : '目标进行中') + `：${tidySentence(plan.objective, 40)}`
                : `待办 ${todos.filter((t) => t.status === 'done').length}/${todos.length}`}
            </span>
            {plan && <span className="gs-count">{plan.steps.filter((s) => s.status === 'done').length}/{plan.steps.length}</span>}
            {!plan && <span className="gs-count">{todos.filter((t) => t.status === 'done').length}/{todos.length}</span>}
          </summary>
          <div className="gs-body">
            {plan?.steps.map((s, i) => (
              <div key={i} className={`plan-step ${s.status}`}>
                <span className="ps-num">
                  {s.status === 'done' ? <IconCheck size={10} /> : s.status === 'in_progress' ? <IconPlay size={10} /> : s.status === 'blocked' ? <IconBlock size={10} /> : i + 1}
                </span>
                <span>{i + 1}. {s.title}</span>
              </div>
            ))}
            {todos.map((t) => (
              <div key={t.id} className={`plan-step ${t.status}`}>
                <span className="ps-num">
                  {t.status === 'done' ? <IconCheck size={10} /> : t.status === 'doing' ? <IconPlay size={10} /> : t.status === 'blocked' ? <IconBlock size={10} /> : <IconCircle size={10} />}
                </span>
                <span>{t.title}</span>
                {t.desc && <span className="todo-note">{t.desc}</span>}
              </div>
            ))}
          </div>
        </details>
      )}

      <div className="composer-area">
        <AnimatePresence>
        {cmdOpen && matched.length > 0 && (
          <div className="cmd-overlay" onClick={() => setCmdOpen(false)}>
            <motion.div
              className="cmd-panel"
              onClick={(e) => e.stopPropagation()}
              variants={popIn}
              initial="initial"
              animate="enter"
              exit="exit"
            >
              <div className="cmd-input-row">
                <span className="cmd-slash">/</span>
                <span className="cmd-typed">{input.slice(1)}</span>
                <span className="cmd-cursor" />
              </div>
              <div className="cmd-list" role="listbox" aria-label="斜杠命令">
                {matched.map((c, i) => (
                  <div
                    key={c.name}
                    className={`cmd-item ${i === cmdIdx ? 'selected' : ''}`}
                    role="option"
                    aria-selected={i === cmdIdx}
                    onMouseEnter={() => setCmdIdx(i)}
                    onClick={() => applyCommand(c)}
                  >
                    <span className="ci-icon" style={{ background: c.source === 'builtin' ? 'var(--blue-soft)' : 'var(--purple-soft)', color: c.source === 'builtin' ? 'var(--accent)' : 'var(--purple)' }}>
                      {c.source === 'builtin' ? <IconSettings size={12} /> : <IconPlugin size={12} />}
                    </span>
                    <span className="ci-name">/{c.name}{c.usage ? ` ${c.usage}` : ''}</span>
                    <span className="ci-desc">{c.description}</span>
                    {i === cmdIdx && <span className="ci-badge"><IconReturn size={9} /> 执行</span>}
                    <span className="ci-kbd">{c.source === 'builtin' ? '内置' : '插件'}</span>
                  </div>
                ))}
              </div>
              <div className="cmd-foot">
                <span className="cf-item"><span className="cf-kbd">↑↓</span><span className="cf-label">选择</span></span>
                <span className="cf-item"><span className="cf-kbd">Enter</span><span className="cf-label">执行</span></span>
                <span className="cf-item"><span className="cf-kbd">Tab</span><span className="cf-label">补全</span></span>
                <span className="cf-item"><span className="cf-kbd">Esc</span><span className="cf-label">关闭</span></span>
              </div>
            </motion.div>
          </div>
        )}
        </AnimatePresence>

        {/* 引用回复条（微信式：引用内容随消息上送） */}
        <AnimatePresence>
        {quote && (
          <motion.div
            className="quote-bar"
            data-testid="quote-bar"
            variants={msgRow}
            initial="initial"
            animate="enter"
            exit="exit"
          >
            <span className="qb-icon"><IconReturn size={12} /></span>
            <div className="qb-body">
              <span className="qb-author">引用 {quote.author}</span>
              <span className="qb-text">{quote.text.slice(0, 120)}{quote.text.length > 120 ? '…' : ''}</span>
            </div>
            <button className="qb-close" data-testid="quote-cancel" onClick={() => setQuote(null)} aria-label="取消引用" title="取消引用"><IconClose size={12} /></button>
          </motion.div>
        )}
        </AnimatePresence>

        <div className="composer">
          {/* 表情面板（手账贴纸感） */}
          <AnimatePresence>
          {emojiOpen && (
            <motion.div
              className="emoji-panel"
              data-testid="emoji-panel"
              variants={popIn}
              initial="initial"
              animate="enter"
              exit="exit"
              role="dialog"
              aria-label="表情"
            >
              {EMOJI.map((em) => (
                // 选完不关面板（微信就是连着挑几个）：再点一次表情键收起
                <button key={em} onClick={() => { setInput((v) => v + em); inputRef.current?.focus(); }} title={em}>{em}</button>
              ))}
            </motion.div>
          )}
          </AnimatePresence>
          <textarea
            ref={inputRef}
            value={input}
            placeholder={hasModels ? '跟小马说点什么…（按 / 看命令）' : '先去左下角「设置」里配一个模型吧'}
            rows={2}
            onChange={(e) => {
              setInput(e.target.value);
              setCmdOpen(e.target.value.startsWith('/'));
              setCmdIdx(0);
            }}
            onKeyDown={onKeyDown}
            // 流式期间不禁用：保留 Esc 停止 / ↑ 历史回放等键盘能力（发送由 submit 防护）
            disabled={!hasModels}
          />
          <div className="composer-toolbar">
            <div className="comp-left">
              <span className="comp-tools-label" title="需要的时候，它会自己动手（读文件 / 跑命令 / 上网查）">会自己动手</span>
              {/* 账单不再是常驻大字：只留一个可悬停的 ⓘ（明细在统计页与每条消息上） */}
              {sessionCost > 0 && (
                <span className="comp-cost" title={`本会话累计花费 ${money(sessionCost)}（明细见「统计」页）`}><IconCoin size={11} /></span>
              )}
            </div>
            <div className="comp-right">
              <Menu
                trigger={<>{modelLabel || '未选择模型'}<IconChevronDown size={10} /></>}
                items={models.map((m) => ({ key: m.id, label: m.label, sub: m.model }))}
                selectedKey={selectedModelId}
                onSelect={(k) => onSelectModel?.(k)}
                title="切换模型"
                width={260}
                triggerTitle="切换模型"
                disabled={!hasModels || models.length === 0}
                dropUp
              />
              <AnimatePresence mode="popLayout" initial={false}>
                {streaming ? (
                  <motion.button key="stop" className="send-btn stop" onClick={onStop} title="让它停下" aria-label="停止" variants={popIn} initial="initial" animate="enter" exit="exit" layout><IconStop size={13} />停下</motion.button>
                ) : input.trim() ? (
                  <motion.button key="send" className="send-btn" data-testid="send-btn" onClick={() => submit()} disabled={!input.trim() || !hasModels} title="发送" aria-label="发送" variants={popIn} initial="initial" animate="enter" exit="exit" layout>发送</motion.button>
                ) : null}
              </AnimatePresence>
              {/* 表情键常驻：微信里打字时它也不会消失（发送键是"多出来"的那个，不是替换） */}
              <button
                className={`emoji-btn ${emojiOpen ? 'on' : ''}`}
                data-testid="emoji-btn"
                onClick={() => setEmojiOpen((v) => !v)}
                title="表情"
                aria-label="表情"
                aria-expanded={emojiOpen}
              >😊</button>
            </div>
          </div>
        </div>
        <div className="composer-hint">
          <span className="mono">Enter</span> 发送 · <span className="mono">Shift+Enter</span> 换行 · <span className="mono">/</span> 命令 · <span className="mono">Esc</span> 让它停下
        </div>
      </div>
    </div>
  );
}
