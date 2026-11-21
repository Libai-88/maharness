import type { ToolDef } from '../../kernel/types';
import type { AutomationService } from '../automations';
import type { ExperienceService } from '../experience';
import type { OrganizationService } from '../organization';
import type { SocietyService } from '../society';

/**
 * Narrow host-service ports consumed by HTTP routes and read-only projections.
 *
 * These are deliberately smaller than the service classes: routes validate and
 * map HTTP, while durable Run/organization facts remain owned by the host
 * services. New route code must extend a port here instead of importing a
 * concrete service implementation.
 */
export type OrganizationPort = Pick<OrganizationService,
  | 'createForRun'
  | 'detail'
  | 'updateRole'
  | 'confirmPersistentRole'
  | 'roleHistory'
  | 'rollbackRole'
  | 'evaluationHistory'
  | 'updateEvaluation'
  | 'rollbackEvaluation'
  | 'scorecards'
  | 'wellbeing'
  | 'raiseException'
  | 'resolveException'
  | 'setTeamState'
  | 'reassign'
  | 'createProposal'
  | 'decideProposal'
>;

export type SocietyPort = Pick<SocietyService,
  | 'snapshot'
  | 'createTask'
  | 'tick'
  | 'approveTask'
  | 'releaseTask'
  | 'experiment'
  | 'roleLife'
  | 'updateInstitution'
  | 'rollbackInstitution'
>;

export type ExperiencePort = Pick<ExperienceService,
  | 'estimate'
  | 'create'
  | 'list'
  | 'review'
  | 'audits'
  | 'cancel'
  | 'deepen'
  | 'audit'
  | 'calibrate'
  | 'adoptSuggestion'
  | 'findings'
  | 'updateFinding'
  | 'reproduceFinding'
  | 'recordRegressionResult'
  | 'evolveFinding'
>;

export type AutomationPort = Pick<AutomationService,
  | 'list'
  | 'occurrences'
  | 'create'
  | 'get'
  | 'update'
  | 'confirm'
  | 'pause'
  | 'resume'
  | 'runNow'
  | 'cancelRun'
  | 'cancel'
>;

export interface HostPorts {
  automations?: AutomationPort;
  organization?: OrganizationPort;
  society?: SocietyPort;
  experience?: ExperiencePort;
}

export interface HostToolPorts {
  runTools: () => ToolDef[];
}