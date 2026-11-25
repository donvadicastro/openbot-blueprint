export interface RunIdentity {
  installationId: string;
  projectId: string;
  runId: string;
  planDigest: string;
}

export interface RunInput extends RunIdentity {
  initialPhase: string;
  phaseIds: string[];
}

export interface PhaseRequest extends RunIdentity {
  phase: string;
  occurrence: number;
  operationKey: string;
  decision?: { id: string; value: unknown };
}

export type PhaseOutcome =
  | { kind: 'advance'; nextPhase: string; delaySeconds?: number }
  | { kind: 'wait'; decisionId: string; question: string }
  | { kind: 'complete'; result: string }
  | { kind: 'blocked'; reason: string }
  | { kind: 'uncertain'; reason: string };

export interface WorkflowActivities {
  executePhase(request: PhaseRequest): Promise<PhaseOutcome>;
  reconcilePhase(request: PhaseRequest): Promise<PhaseOutcome | { kind: 'not-started' }>;
}

export interface WorkflowSnapshot {
  phase: string;
  occurrence: number;
  state: 'running' | 'waiting' | 'uncertain' | 'blocked' | 'complete';
  reason?: string;
  decisionId?: string;
  result?: string;
}
