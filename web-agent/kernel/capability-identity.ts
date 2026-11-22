import type { Capability } from './types';

export const CAPABILITY_IDENTIFIERS = {
  tool: 'name',
  command: 'name',
  service: 'id',
  context: 'id',
  role: 'id',
  provider: 'id',
  persona: 'id',
  api: 'mount',
  listener: 'event',
} as const;

export function capabilityName(cap: Capability): string {
  if (cap.kind === 'listener') return cap.event;
  const value = (cap as unknown as Record<string, Record<string, string>>)[cap.kind];
  return value[CAPABILITY_IDENTIFIERS[cap.kind]];
}
