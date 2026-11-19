/**
 * Public plugin SDK surface.
 *
 * Plugins should import contracts from this module instead of reaching into
 * the kernel's implementation files. Runtime behavior remains owned by the
 * host; this module only exposes the stable plugin-facing contract.
 *
 * The re-exports below are intentionally the supported bundle for built-in
 * plugins. New plugin code must import from here; the dependency-boundary
 * tests reject any other kernel path in core/ and plugins/ source files.
 */
export { PLUGIN_API_VERSION } from './plugin-loader';
export { SERVICE_KEYS } from './loop';
export * from './types';
export * from './loop';
export * from './cache';
export * from './budget';
export * from './context';
export * from './model-call';
export * from './model-response';
export * from './modelCatalog';
export * from './material';
export * from './tokens';
export * from './sandbox';
export * from './tool-contract';
export * from './tool-privilege';
export * from './plugin-review';
export * from './execution-pool';
export * from './rules';
export * from './validate';
export * from './shared';
export * from './vectors';
export * from './frontmatter';
export * from './error-policy';
export * from './write-lock';
export * from './task-plugins';
export * from './run';
export * from './tool-journal';
export * from './tool-discovery';
export * from './task-verifier';
export * from './skillsSync';
export * from './plugin-snapshot';
export * from './plugin-process';
export * from './plugin-loader';
export * from './plugin-files';
export * from './input-diagnostics';
export * from './history-tools';
export * from './content-safety';
export * from './config';
export * from './capability-identity';
export * from './bus';
export * from './provider-gateway';
export * from './fssearch';
export * from './plugin-trial';
