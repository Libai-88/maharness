import type { ChatMessage, TaskVerificationInfo, ToolStep } from '../types';
import { shouldShowDivider, withJoins } from '../replay';
import { chatTime, sys } from '../voice';

export type ChatPart =
  | { kind: 'narration'; id: string; paragraphs: string[]; streaming: boolean }
  | { kind: 'reasoning'; id: string; text: string; streaming: boolean }
  | { kind: 'tool'; id: string; tool: ToolStep }
  | { kind: 'verification'; id: string; verification: TaskVerificationInfo }
  | { kind: 'text'; id: string; text: string; streaming: boolean }
  | { kind: 'status'; id: string; text: string }
  | { kind: 'failure'; id: string; text: string; raw?: string; retryable: boolean }
  | { kind: 'stopped'; id: string; text: string };

export interface ChatRun {
  id: string;
  message: ChatMessage;
  parts: ChatPart[];
  streaming: boolean;
  cached: boolean;
}

export interface ChatTurn {
  kind: 'turn';
  id: string;
  user?: ChatMessage;
  runs: ChatRun[];
}

export interface ChatMarkerItem {
  kind: 'marker';
  id: string;
  marker: 'time' | 'join' | 'system';
  content: string;
  member?: string;
  ts?: number;
}

export type ChatTimelineItem = ChatTurn | ChatMarkerItem;

function buildParts(message: ChatMessage, statusText?: string | null): ChatPart[] {
  const parts: ChatPart[] = [];
  const content = message.retryFrom ? message.content.slice(message.retryFrom) : message.content;
  const reasoning = message.retryFromReasoning ? (message.reasoning ?? '').slice(message.retryFromReasoning) : message.reasoning;
  const narration = (message.narration ?? []).filter((part) => part.trim());
  const thinking = !!message.streaming && !content && !(message.tools ?? []).some((tool) => tool.status === 'running');

  if (narration.length) {
    parts.push({
      kind: 'narration',
      id: `${message.id}:narration`,
      paragraphs: narration,
      streaming: thinking,
    });
  }

  for (const [index, tool] of (message.tools ?? []).entries()) {
    parts.push({
      kind: 'tool',
      id: tool.id ?? `${message.id}:tool:${index}`,
      tool,
    });
  }

  if (message.taskVerification) {
    parts.push({
      kind: 'verification',
      id: `${message.id}:verification`,
      verification: message.taskVerification,
    });
  }

  if (reasoning) {
    parts.push({
      kind: 'reasoning',
      id: `${message.id}:reasoning`,
      text: reasoning,
      streaming: thinking,
    });
  }

  if (content) {
    parts.push({
      kind: 'text',
      id: `${message.id}:text`,
      text: content,
      streaming: !!message.streaming,
    });
  } else if (message.streaming) {
    parts.push({
      kind: 'status',
      id: `${message.id}:status`,
      text: statusText || '正在思考…',
    });
  }

  if (message.stopped && !content) {
    parts.push({
      kind: 'stopped',
      id: `${message.id}:stopped`,
      text: sys.stopped,
    });
  }

  if (message.error) {
    parts.push({
      kind: 'failure',
      id: `${message.id}:failure`,
      text: message.error,
      raw: message.errorRaw,
      retryable: !message.streaming,
    });
  }

  return parts;
}

export function buildChatTimeline(messages: ChatMessage[], statusText?: string | null): ChatTimelineItem[] {
  const timeline: ChatTimelineItem[] = [];
  const nodes = withJoins(messages);
  let currentTurn: ChatTurn | null = null;
  let previousTs: number | undefined;

  for (const node of nodes) {
    const ts = node.kind === 'msg' ? node.msg.ts : node.ts;
    if (shouldShowDivider(previousTs, ts) && ts) {
      timeline.push({
        kind: 'marker',
        id: `time:${ts}`,
        marker: 'time',
        content: chatTime(ts),
        ts,
      });
    }

    if (node.kind === 'join') {
      timeline.push({
        kind: 'marker',
        id: `join:${node.key}`,
        marker: 'join',
        content: `${node.member} 加入了协作`,
        member: node.member,
        ts: node.ts,
      });
      currentTurn = null;
    } else if (node.msg.role === 'system') {
      timeline.push({
        kind: 'marker',
        id: `system:${node.msg.id}`,
        marker: 'system',
        content: node.msg.content,
        ts: node.msg.ts,
      });
      currentTurn = null;
    } else if (node.msg.role === 'user') {
      currentTurn = {
        kind: 'turn',
        id: `turn:${node.msg.id}`,
        user: node.msg,
        runs: [],
      };
      timeline.push(currentTurn);
    } else {
      if (!currentTurn) {
        currentTurn = {
          kind: 'turn',
          id: `turn:assistant:${node.msg.id}`,
          runs: [],
        };
        timeline.push(currentTurn);
      }
      currentTurn.runs.push({
        id: `run:${node.msg.id}`,
        message: node.msg,
        parts: buildParts(node.msg, statusText),
        streaming: !!node.msg.streaming,
        cached: !!node.msg.cached,
      });
    }

    if (ts) previousTs = ts;
  }

  return timeline;
}
