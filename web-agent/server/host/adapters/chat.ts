import { discoverProviders as discoverEnvProviders } from '../../../core/chat/provider';
import { globalApprovalBoard, APPROVAL_TIMEOUT } from '../../../core/chat/approvals';
import {
  getProviderHealth as coreGetProviderHealth,
  noteProviderFailure as coreNoteProviderFailure,
  noteProviderSuccess as coreNoteProviderSuccess,
  isAuthError as coreIsAuthError,
  LLMHttpError as CoreLLMHttpError,
} from '../../../core/chat/provider-health';

export type { ProviderConfig } from '../../../core/chat/provider';
export type { CompactOptions, CompactResult } from '../../../core/chat/compact';
export type { ProviderHealth } from '../../../core/chat/provider-health';

/** Server's single explicit adapter to the chat plugin's implementation. */
export function discoverProviders(): ReturnType<typeof discoverEnvProviders> {
  return discoverEnvProviders();
}

export function approvalBoard(): typeof globalApprovalBoard {
  return globalApprovalBoard;
}

export { APPROVAL_TIMEOUT };
export const getProviderHealth = coreGetProviderHealth;
export const noteProviderFailure = coreNoteProviderFailure;
export const noteProviderSuccess = coreNoteProviderSuccess;
export const isAuthError = coreIsAuthError;
export const LLMHttpError = CoreLLMHttpError;