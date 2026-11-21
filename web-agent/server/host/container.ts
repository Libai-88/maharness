import type { Kernel } from '../../kernel';
import type { ProviderDef, ToolDef } from '../../kernel/types';
import type { Store } from '../db';
import { AutomationService } from '../automations';
import { ExperienceService } from '../experience';
import { OrganizationService } from '../organization';
import { organizationTools } from '../organization-tools';
import { SocietyService } from '../society';
import { tenantSandboxRoot } from '../tenant-workspace';
import { currentPlan } from './adapters/goal-plan';

export interface HostServices {
  automations: AutomationService;
  organization: OrganizationService;
  society: SocietyService;
  experience: ExperienceService;
  automationTools: ToolDef[];
  organizationTools: ToolDef[];
  runTools: () => ToolDef[];
}

/**
 * Explicit host-service composition boundary.
 *
 * Product services in this module are intentionally not plugins: they own
 * durable Run/tenant facts and must be constructed once for the host process.
 * Plugins continue to enter through kernel/plugin-sdk; routes receive narrow
 * ports (server/host/ports.ts) instead of constructing their own instances.
 */
export function createHostServices(kernel: Kernel, store: Store): HostServices {
  const automations = new AutomationService(
    store,
    tenant => tenantSandboxRoot(kernel.config.get<string>('sandboxRoot', kernel.rootDir), tenant),
    Date.now,
    {
      filePollMs: kernel.config.get<number>('automation.filePollMs', 5_000),
      urlPollMs: kernel.config.get<number>('automation.urlPollMs', 300_000),
    },
  );
  const automationTools = automations.tools();
  let runtimeToolNames: () => string[] = () => [];
  const organization = new OrganizationService({
    store,
    emit: (type, data) => kernel.bus.emit({ type, data, ts: Date.now() }),
    runtimeAuthority: tenant => {
      const workspace = tenantSandboxRoot(kernel.config.get<string>('sandboxRoot', kernel.rootDir), tenant);
      return {
        workspace,
        readOnly: false,
        profile: store.runs.permission(tenant, workspace).profile,
        allowedTools: runtimeToolNames(),
      };
    },
    goalPlan: { currentPlan },
  });
  const society = new SocietyService({
    store,
    emit: (type, data) => kernel.bus.emit({ type, data, ts: Date.now() }),
    organization,
  });
  const experience = new ExperienceService({
    store,
    providers: () => {
      const chat = kernel.plugins.resolveService('service:chat') as { providers?: ProviderDef[] } | undefined;
      return chat?.providers ?? [];
    },
    emit: (type, data, traceId) => kernel.bus.emit({ type, data, ...(traceId ? { traceId } : {}), ts: Date.now() }),
    now: Date.now,
  });
  const orgTools = organizationTools(organization, store);
  const runTools = (): ToolDef[] => [
    ...kernel.plugins.capabilities('tool').map(capability => capability.tool),
    ...automationTools,
    ...orgTools,
  ];
  runtimeToolNames = () => runTools().map(tool => tool.name);
  return { automations, organization, society, experience, automationTools, organizationTools: orgTools, runTools };
}