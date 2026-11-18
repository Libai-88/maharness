import type { ModelCallRecord } from '../kernel/model-call';
import type { Store } from './db';

export interface PricedModel {
  providerId: string;
  model: string;
  priceIn: number;
  priceOut: number;
  priceSource: 'configured' | 'catalog';
}

export interface ModelUsageProfile {
  samples: number;
  callsPerRun: number;
  inputTokens: number;
  outputTokens: number;
}

function priced(provider: {
  id: string;
  model: string;
  priceIn?: number | null;
  priceOut?: number | null;
}, model: string, priceIn: number, priceOut: number, priceSource: PricedModel['priceSource']): PricedModel {
  return { providerId: provider.id, model, priceIn, priceOut, priceSource };
}

export function resolvePricedModel(store: Store, providerId: string, model: string): PricedModel | undefined {
  const provider = store.listProviders().find(item => item.enabled && item.id === providerId);
  if (!provider) return undefined;
  const capability = store.listModels(provider.id)
    .find(item => item.enabled && item.modelId === model);
  if (capability && capability.source !== 'inferred'
    && Number.isFinite(capability.priceIn) && Number.isFinite(capability.priceOut)
    && capability.priceIn! >= 0 && capability.priceOut! >= 0) {
    return priced(provider, model, capability.priceIn!, capability.priceOut!,
      capability.source === 'manual' ? 'configured' : 'catalog');
  }
  if (model === provider.model
    && Number.isFinite(provider.priceIn) && Number.isFinite(provider.priceOut)
    && provider.priceIn! >= 0 && provider.priceOut! >= 0) {
    return priced(provider, model, provider.priceIn!, provider.priceOut!, 'configured');
  }
  return undefined;
}

export function firstPricedModel(store: Store): PricedModel | undefined {
  const provider = store.listProviders().find(item => item.enabled);
  return provider ? resolvePricedModel(store, provider.id, provider.model) : undefined;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function modelUsageProfile(
  store: Store,
  tenantId: string,
  providerId: string,
  model: string,
): ModelUsageProfile | undefined {
  const calls = store.runs.reportedModelUsage(tenantId, providerId, model, 200)
    .filter(call => Number.isFinite(call.input) && Number.isFinite(call.output));
  if (!calls.length) return undefined;
  const byRun = new Map<string, ModelCallRecord[]>();
  for (const call of calls) {
    const runId = call.runId ?? '';
    byRun.set(runId, [...(byRun.get(runId) ?? []), call]);
  }
  return {
    samples: calls.length,
    callsPerRun: Math.max(1, Math.ceil(median([...byRun.values()].map(items => items.length)))),
    inputTokens: Math.max(1, Math.ceil(median(calls.map(call => call.input!)))),
    outputTokens: Math.max(1, Math.ceil(median(calls.map(call => call.output!)))),
  };
}

export function estimateModelWorkloadCost(
  store: Store,
  input: {
    tenantId: string;
    pricedModel: PricedModel;
    promptTokens: number;
    outputTokens: number;
    fallbackCalls: number;
  },
): {
  costUsd: number;
  tokens: number;
  calls: number;
  source: 'configured' | 'historical';
  historySamples: number;
} {
  const history = modelUsageProfile(
    store, input.tenantId, input.pricedModel.providerId, input.pricedModel.model,
  );
  const calls = history?.callsPerRun ?? Math.max(1, input.fallbackCalls);
  const promptTokens = Math.max(
    Math.max(1, Math.ceil(input.promptTokens)),
    history?.inputTokens ?? 0,
  );
  const outputTokens = Math.max(
    Math.max(1, Math.ceil(input.outputTokens)),
    history?.outputTokens ?? 0,
  );
  const tokens = calls * (promptTokens + outputTokens);
  const costUsd = calls * (
    promptTokens * input.pricedModel.priceIn
    + outputTokens * input.pricedModel.priceOut
  ) / 1_000_000;
  return {
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
    tokens,
    calls,
    source: history ? 'historical' : 'configured',
    historySamples: history?.samples ?? 0,
  };
}
