/** Provider/model 对外契约：身份只由稳定 ID 组成，显示名称和别名不参与计价。 */
export const MODEL_SCHEMA_VERSION = 1 as const;

export interface StableModelIdentity {
  providerId: string;
  modelId: string;
  modelKey: string;
  pricingId: string;
}

function requireId(value: string, name: string): string {
  const id = String(value ?? '').trim();
  if (!id) throw new Error(`${name} 不能为空`);
  return id;
}

export function stableModelIdentity(providerId: string, modelId: string): StableModelIdentity {
  const provider = requireId(providerId, 'providerId');
  const model = requireId(modelId, 'modelId');
  const modelKey = `${provider}@${model}`;
  return { providerId: provider, modelId: model, modelKey, pricingId: modelKey };
}
