import type { ModelCapability, ProviderDef } from './types';

export interface ProviderGatewayCandidate {
  providerId: string;
  model: string;
  score?: number;
  accepted: boolean;
  reasons: string[];
}

export interface ProviderGatewayRoute {
  provider: ProviderDef;
  model: string;
  reason: string;
  candidates: ProviderGatewayCandidate[];
}

export interface ProviderGatewayCapabilityRoute extends ProviderGatewayRoute {
  same: boolean;
}

export interface ProviderGatewayHealth {
  failures: number;
  transientFailures?: number;
  authFailed: boolean;
  lastError: string;
  lastErrorAt: number;
  circuitOpenedAt?: number;
  circuitResetAt?: number;
}

export interface ProviderModelSnapshot {
  providerId: string;
  providerLabel: string;
  model: ModelCapability;
}

/** Provider 子系统唯一对外契约：server、子代理和插件都通过该服务取路由/能力/健康。 */
export interface ProviderGateway {
  providers(): ProviderDef[];
  getProvider(id: string): ProviderDef | undefined;
  models(providerId?: string): ProviderModelSnapshot[];
  routeTask(taskText: string, routing: Record<string, string>): ProviderGatewayRoute | undefined;
  routeCapability(
    need: Record<string, unknown>,
    current: { providerId: string; model: string },
  ): ProviderGatewayCapabilityRoute | undefined;
  health(providerId: string): ProviderGatewayHealth | undefined;
  embedding(): { embed(text: string): Promise<number[]> } | undefined;
}
