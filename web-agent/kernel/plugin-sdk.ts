/**
 * Public plugin SDK surface.
 *
 * Plugins should import contracts from this module instead of reaching into
 * the kernel's implementation files. Runtime behavior remains owned by the
 * host; this module only exposes the stable plugin-facing contract.
 */
export { PLUGIN_API_VERSION } from './plugin-loader';
export type * from './types';
export type * from './loop';
export { SERVICE_KEYS } from './loop';
