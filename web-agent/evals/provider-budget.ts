import { randomUUID } from 'node:crypto';
import type { ProviderDef } from '../kernel/types';

const SCALE = 1_000_000_000;
export class EvaluationBudgetError extends Error {
  constructor(readonly code: string, detail = code) { super(detail); this.name = 'EvaluationBudgetError'; }
}
export interface EvaluationCallReceipt {
  id: string; model: string; scope?: string; reservedUsd: number; chargedUsd: number;
  accounting: 'reserved' | 'reported' | 'conservative';
}
function units(value: number): number {
  const result = Math.ceil(value * SCALE);
  if (!Number.isFinite(value) || 0 > value || !Number.isSafeInteger(result)) throw new EvaluationBudgetError('EVAL_COST_INVALID');
  return result;
}

/** A synchronous reservation is shared across every model, variant and concurrent call. */
export class EvaluationBudget {
  private readonly limitUnits: number;
  private held = 0;
  private spent = 0;
  private stopped?: string;
  private readonly rows: EvaluationCallReceipt[] = [];
  constructor(limitUsd: number) {
    this.limitUnits = Math.floor(limitUsd * SCALE);
    if (!Number.isFinite(limitUsd) || !Number.isSafeInteger(this.limitUnits) || 0 >= this.limitUnits) throw new EvaluationBudgetError('EVAL_BUDGET_INVALID');
  }
  get limitUsd() { return this.limitUnits / SCALE; }
  get chargedUsd() { return this.spent / SCALE; }
  get reservedUsd() { return this.held / SCALE; }
  get remainingUsd() { return Math.max(0, this.limitUnits - this.spent - this.held) / SCALE; }
  get haltReason() { return this.stopped; }
  get receipts() { return this.rows.map(row => ({ ...row })); }
  halt(reason: string): void { this.stopped ??= reason; }
  reserve(model: string, amountUsd: number, scope?: string) {
    if (this.stopped) throw new EvaluationBudgetError('EVAL_BUDGET_HALTED', this.stopped);
    const reserved = units(amountUsd);
    if (reserved > this.limitUnits - this.spent - this.held) throw new EvaluationBudgetError('EVAL_BUDGET_EXHAUSTED');
    this.held += reserved;
    const row: EvaluationCallReceipt = { id: randomUUID(), model, ...(scope === undefined ? {} : { scope }), reservedUsd: reserved / SCALE, chargedUsd: 0, accounting: 'reserved' };
    this.rows.push(row);
    let settled = false;
    return {
      settle: (actualUsd: number | undefined, confirmed: boolean) => {
        if (settled) return;
        let charged: number;
        try {
          if (confirmed && actualUsd === undefined) throw new EvaluationBudgetError('EVAL_COST_INVALID');
          const actual = units(actualUsd ?? 0);
          charged = confirmed ? actual : Math.max(reserved, actual);
          if (!Number.isSafeInteger(this.spent + charged)) throw new EvaluationBudgetError('EVAL_COST_INVALID');
        } catch (error) { this.halt('EVAL_COST_INVALID'); throw error; }
        this.held -= reserved; this.spent += charged; settled = true;
        row.chargedUsd = charged / SCALE;
        row.accounting = confirmed ? 'reported' : 'conservative';
      },
    };
  }
}

export interface EvaluationModelPricing {
  model: string; inputUsdPerMillion: number; outputUsdPerMillion: number; maxOutputTokens: number; scope?: string;
}

/** Wraps an explicitly supplied provider; never discovers credentials or retries requests. */
export function budgetedEvaluationProvider(provider: ProviderDef, settings: EvaluationModelPricing, budget: EvaluationBudget): ProviderDef {
  const config = { ...settings };
  if (!config.model.trim() || config.model !== config.model.trim()
    || !Number.isSafeInteger(config.maxOutputTokens) || 0 >= config.maxOutputTokens
    || !Number.isFinite(config.inputUsdPerMillion) || 0 > config.inputUsdPerMillion
    || !Number.isFinite(config.outputUsdPerMillion) || 0 > config.outputUsdPerMillion) throw new EvaluationBudgetError('EVAL_PRICING_INVALID');
  const chat = provider.chat.bind(provider);
  return {
    ...provider, defaultModel: config.model,
    prices: { in: config.inputUsdPerMillion, out: config.outputUsdPerMillion },
    models: provider.models?.map(model => model.modelId === config.model ? { ...model, priceIn: config.inputUsdPerMillion, priceOut: config.outputUsdPerMillion } : model),
    async *chat(messages, options) {
      options.signal?.throwIfAborted();
      if (options.model !== config.model) throw new EvaluationBudgetError('EVAL_MODEL_MISMATCH');
      if (messages.some(message => message.images?.length)) throw new EvaluationBudgetError('EVAL_IMAGE_PRICING_REQUIRED');
      if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || 0 >= options.maxTokens)) throw new EvaluationBudgetError('EVAL_OUTPUT_LIMIT_INVALID');
      const maxTokens = Math.min(options.maxTokens ?? config.maxOutputTokens, config.maxOutputTokens);
      const tools = options.tools?.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
      const inputBound = Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8') + 4096;
      const estimate = (input: number, output: number) => (input * config.inputUsdPerMillion + output * config.outputUsdPerMillion) / 1_000_000;
      const reservation = budget.reserve(config.model, estimate(inputBound, maxTokens), config.scope);
      let input = 0; let output = 0; let reported = false; let uncertain = false; let complete = false; let failed = false;
      try {
        for await (const chunk of chat(messages, { ...options, maxTokens })) {
          if (chunk.type === 'usage') {
            if (!Number.isSafeInteger(chunk.input) || 0 > chunk.input || !Number.isSafeInteger(chunk.output) || 0 > chunk.output) {
              budget.halt('EVAL_USAGE_INVALID'); throw new EvaluationBudgetError('EVAL_USAGE_INVALID');
            }
            input = Math.max(input, chunk.input); output = Math.max(output, chunk.output);
            if (chunk.estimated) uncertain = true; else reported = true;
            if (input > inputBound || output > maxTokens) {
              budget.halt('EVAL_USAGE_BOUND_EXCEEDED'); throw new EvaluationBudgetError('EVAL_USAGE_BOUND_EXCEEDED');
            }
          }
          if (chunk.type === 'done') complete = true;
          yield chunk;
        }
      } catch (error) { failed = true; throw error; }
      finally { reservation.settle(reported || uncertain ? estimate(input, output) : undefined, complete && reported && !uncertain && !failed); }
    },
  };
}
