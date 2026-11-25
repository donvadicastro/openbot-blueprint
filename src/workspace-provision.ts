export type WorkspaceProvisionArtifacts = Record<string, Record<string, unknown>>;

/** Build a small, truthful SWE startup artifact set from files in one selected workspace. */
export function workspaceProvisionArtifacts(sourcePath: string): WorkspaceProvisionArtifacts {
  if (typeof sourcePath !== 'string' || !sourcePath.startsWith('/projects/') || sourcePath.includes('\\') ||
      sourcePath.includes('\0') || sourcePath.split('/').slice(2).some(part => !part || part === '.' || part === '..') ||
      sourcePath.endsWith('/') || sourcePath.length > 1000) {
    throw new Error('Source path must name a folder under /projects.');
  }
  const file = (path: string) => `${sourcePath}/${path}`;
  return {
    'source-code': { path: sourcePath },
    'ci-cd': { reference: file('.github/workflows/ci.yml') },
    'test-environment': { reference: file('docs/test-environment.md') },
    documentation: { reference: file('README.md') },
    requirements: { reference: file('docs/requirements.md') },
  };
}

export type WorkspaceProvisionReadiness = {
  project?: { id?: string; state?: string };
  workspace?: { state?: string; reason?: string | null } | null;
  artifacts?: { typeKey: string; status?: string }[];
  reports?: { roleKey?: string; status?: string; evidence?: { reason?: string } }[];
};

export function workspaceProvisionBlockers(value: WorkspaceProvisionReadiness, expectedRoles: string[]) {
  const reports = Array.isArray(value?.reports) ? value.reports : [];
  const missing = expectedRoles.filter(role => !reports.some(report => report?.roleKey === role && report.status === 'Ready'));
  return {
    operational: value?.project?.state === 'Operational' && missing.length === 0 && reports.length === expectedRoles.length,
    blockers: missing.map(role => {
      const report = reports.find(item => item?.roleKey === role);
      return { role, status: report?.status ?? 'Pending', reason: report?.evidence?.reason ?? 'No current Ready report.' };
    }),
  };
}
