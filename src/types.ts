import type { ReadinessField } from './readiness.js';

export type BotLanguage = 'typescript' | 'python';
export type BotFramework = 'openai-agents' | 'langchain' | 'custom';

/** Runtime metadata describes implementation requirements, never live credentials. */
export type BotRuntime =
  | { kind: 'builtin' }
  | {
      kind: 'local';
      language: BotLanguage;
      framework: BotFramework;
      entrypoint: string;
      dependencyFile: string;
      exportName: string;
      files?: string[];
    }
  | { kind: 'remote'; protocol: 'ag-ui'; endpointEnv: string };

export interface Agent {
  id: string;
  name: string;
  role: string;
  purpose: string;
  tier: 'core' | 'optional';
  activateWhen?: string;
  prompt: string;
  tools: string[];
  resources: string[];
  environment: string;
  deliverables: string[];
  readiness?: ReadinessField[];
  /** Omitted for older definitions: equivalent to builtin. */
  runtime?: BotRuntime;
}

export interface Connection {
  id: string;
  from: string;
  to: string;
  trigger: string;
  input: string[];
  output: string[];
  onFailure: string;
}

export interface Tool {
  id: string;
  description: string;
  transport: 'mcp' | 'native' | 'http';
  endpointEnv?: string;
  credentialEnv?: string;
  /** Exact OpenBot MCP references granted to the bot, in server-id/tool-name form. */
  nativeRefs?: string[];
  /** Bind MCP arguments to visible active-phase artifact fields for project workflow use. */
  resourceBindings?: { argumentPath: string; artifactType: string; payloadPath: string }[];
  capabilities: string[];
  access: 'read' | 'write' | 'execute';
  setup: string;
}

export interface Resource {
  id: string;
  description: string;
  kind: 'repository' | 'documentation' | 'artifact-store' | 'local-file';
  location?: string;
  path?: string;
  access: 'read' | 'write';
}

export interface Environment {
  id: string;
  isolation: 'none' | 'container' | 'vm';
  workspace: string;
  network: 'disabled' | 'allowlist';
  allowedHosts: string[];
  cpu: number;
  memoryMb: number;
  setup: string;
}

export interface WorkflowStep {
  id: string;
  owner: string;
  dependsOn: string[];
  instructions: string;
  gates: string[];
  onFailure: string;
}

export interface QualityGate {
  id: string;
  owner: string;
  criteria: string[];
  evidence: string[];
  onFailure: string;
}

export interface Blueprint {
  $schema?: string;
  schemaVersion: '1.0';
  id: string;
  name: string;
  version: string;
  projectType: string;
  description: string;
  entrypoint: string;
  intake?: { welcomeMessage: string; handoffTo?: string; discoveryBy?: string; form?: boolean };
  inputs: string[];
  outputs: string[];
  agents: Agent[];
  connections: Connection[];
  tools: Tool[];
  resources: Resource[];
  environments: Environment[];
  workflow: WorkflowStep[];
  qualityGates: QualityGate[];
  extensionPolicy: { strategy: 'additive'; rules: string[] };
  executionPolicy: {
    maxConcurrentAgents: number;
    maxHandoffs: number;
    maxReworkCycles: number;
    timeoutMinutes: number;
    approvalRequiredFor: string[];
    onBudgetExceeded: string;
  };
  deployment?: {
    runtime: 'openbot';
    environmentFile: string;
    files?: string[];
  };
  extensions?: Record<string, unknown>;
  /** Optional operating contract. Older blueprint packages remain valid without it. */
  business?: BusinessContract;
}

/** Proposed runner boundary. SDK-specific state stays inside each adapter. */
export interface BotRequest {
  requestId: string;
  objective: string;
  baseRevision: string;
  acceptanceCriteria: string[];
  artifactPaths: string[];
}

export interface BotResult {
  requestId: string;
  baseRevision: string;
  status: 'ready' | 'needs-rework' | 'blocked';
  summary: string;
  artifactPaths: string[];
  evidence: string[];
  unresolvedRisks: string[];
}

export interface BotAdapter {
  readonly language: BotLanguage;
  readonly framework: BotFramework;
  /** A future runner supplies isolation, grants, cancellation and budget enforcement. */
  execute(agent: Agent, request: BotRequest, signal: AbortSignal): Promise<BotResult>;
}


export type BusinessResultStatus = 'succeeded' | 'needs-input' | 'blocked' | 'failed';

export type BusinessStartupCheck =
  | { id: string; description: string; kind: 'artifact-access'; artifactType: string }
  | { id: string; description: string; kind: 'workspace-ready' | 'role-ready'; artifactType?: never };

export interface BusinessRole {
  id: string;
  agentId: string;
  responsibility: string;
  actions: string[];
  startupChecks: BusinessStartupCheck[];
  viewId: string;
  skills?: string[];
}

export interface BusinessArtifactType {
  id: string;
  description: string;
  owner: string;
  producers: string[];
  consumers: string[];
  schema: Record<string, unknown>;
  states: string[];
  relationships: { field: string; targetType: string; many: boolean }[];
}

export interface BusinessAction {
  id: string;
  role: string;
  inputTypes: string[];
  outputTypes: string[];
  prerequisites: string[];
  results: {
    status: BusinessResultStatus;
    requiredOutputTypes: string[];
    requiredEvidence: string[];
  }[];
  retry: { maxAttempts: number; delaySeconds: number };
  approvalRequired?: boolean;
}

export type BusinessPhase =
  | { id: string; action: string; terminal?: never }
  | { id: string; terminal: true; action?: never };

export interface BusinessTransition {
  from: string;
  to: string;
  when: {
    status: BusinessResultStatus;
    decision?: string;
    recordType?: string;
    field?: string;
    equals?: string;
  };
}

export interface BusinessWorkflow {
  id: string;
  description: string;
  outcomes: string[];
  startPhase: string;
  terminalPhases: string[];
  phases: BusinessPhase[];
  transitions: BusinessTransition[];
}

export interface BusinessView {
  id: string;
  role: string;
  recordTypes: string[];
  summaryFields: string[];
  detailFields: string[];
  renderer: string;
}

export type BusinessWorkspace =
  | { kind: 'none' }
  | {
      kind: 'vm';
      provider: 'lima';
      image: string;
      imageDigest: string;
      cpus: number;
      memoryMb: number;
      diskGb: number;
    };

export interface BusinessContract {
  teamLeadRole: string;
  roles: BusinessRole[];
  artifactTypes: BusinessArtifactType[];
  initialization: {
    requiredArtifacts: string[];
    recommendedArtifacts: string[];
    workspace: BusinessWorkspace;
  };
  actions: BusinessAction[];
  workflows: BusinessWorkflow[];
  views: BusinessView[];
}

export type BusinessDefinition = BusinessContract;
