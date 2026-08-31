/**
 * core/chat/replay-provider.ts —— Agent 级回归评测的确定性 LLM（Record/Replay）
 *
 * 2026 实践（Trace→Replay→Eval）：agent 工程质量基线 = 确定性回放 + 轨迹断言 + golden 回归。
 * maharness 已有 JSONL 轨迹落盘（data/traces/）与 provider 接口抽象，这里补上回放侧：
 *
 *  - RecordingProvider：包裹真实 provider，把每次 LLM 调用（请求消息 + 响应 chunks）录制成 JSON；
 *  - ReplayProvider：把录音按调用顺序逐次回放（确定性、零 API 成本）——
 *    同一录音 + 同一代码 = 同一轨迹，任何 agent 循环/钩子/缓存改动都会反映在轨迹差异上。
 *
 * 使用场景：
 *  - 回归测试（npm run eval）：golden 场景重放 → 断言工具序列/最终答案/缓存命中；
 *  - 复现线上 bug：data/traces/*.jsonl 有完整步骤，但缺 LLM 原始请求/响应——
 *    需要 `npm run eval -- --record <name> <task>` 在真实 provider 下先录制。
 *
 * 注意：录音按「调用顺序」回放，不做请求内容匹配——保证同一任务两次运行的行为
 * 若因钩子注入等导致调用次数/顺序不同，会以「序列耗尽/错位」的形式暴露（这正是回归要抓的）。
 */
import { readFileSync } from 'node:fs';
import type { LLMChunk, LLMMessage, ProviderDef, ChatOptions } from '../../kernel/types';

export interface RecordedRequest {
  /** 实际发送给 LLM 的消息序列（文本化形态，见 agent.ts textualizeHistory） */
  messages: LLMMessage[];
  model?: string;
  /** 响应的完整 chunk 流（delta/reasoning/tool_call/usage/done 全量） */
  chunks: LLMChunk[];
}

export interface Recording {
  version: 1;
  requests: RecordedRequest[];
}

/** 包裹真实 provider 录制请求/响应（一次 run 的所有 LLM 调用） */
export class RecordingProvider implements ProviderDef {
  id: string;
  label: string;
  defaultModel: string;
  prices?: { in: number; out: number };
  requests: RecordedRequest[] = [];
  private inner: ProviderDef;

  constructor(inner: ProviderDef) {
    this.inner = inner;
    this.id = inner.id;
    this.label = inner.label;
    this.defaultModel = inner.defaultModel;
    this.prices = inner.prices;
  }

  toRecording(): Recording {
    return { version: 1, requests: this.requests };
  }

  async *chat(messages: LLMMessage[], opts: ChatOptions): AsyncIterable<LLMChunk> {
    const chunks: LLMChunk[] = [];
    this.requests.push({ messages, model: opts.model, chunks });
    for await (const chunk of this.inner.chat(messages, opts)) {
      chunks.push(chunk);
      yield chunk;
    }
  }
}

/** 确定性回放 provider：按录音顺序逐次返回响应（零 API 成本） */
export class ReplayProvider implements ProviderDef {
  id = 'replay';
  label = 'REPLAY';
  defaultModel = 'replay';
  /** 已消耗的 LLM 调用次数（断言用：如 L1 缓存命中时第二次 run 应为 0 次新调用） */
  callCount = 0;
  private cursor = 0;

  constructor(private recording: Recording) {}

  async *chat(_messages: LLMMessage[], _opts: ChatOptions): AsyncIterable<LLMChunk> {
    const req = this.recording.requests[this.cursor];
    if (!req) {
      throw new Error(
        `[replay] LLM 请求序列耗尽（第 ${this.cursor + 1} 次调用无录音）。` +
        '说明 agent 循环行为与录制时不一致（调用次数/顺序变了）——这正是回归测试要暴露的差异。',
      );
    }
    this.cursor++;
    this.callCount++;
    for (const chunk of req.chunks) yield chunk;
  }
}

/** 读取 golden 录音文件（JSON） */
export function loadRecording(path: string): Recording {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<Recording>;
  if (raw.version !== 1 || !Array.isArray(raw.requests)) {
    throw new Error(`录音格式不合法: ${path}`);
  }
  return raw as Recording;
}
