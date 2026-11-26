import type { ReadinessProbe } from "./readiness.js";

/** Run the assigned native bot as the authenticated project manager. */
export function createNativeReadinessProbe(
  runTurn: (input: { ownerUserId: string; routineId: string; agentId: string; threadId: string; instruction: string; workspaceRequired: boolean; checkWorkspace: () => Promise<{ verified: boolean; evidence: string }> }) => Promise<{ replyText: string }>,
  mintThreadId: () => string,
  verifyWorkspace?: (input: Parameters<ReadinessProbe>[0]) => Promise<{ verified: boolean; evidence: string }>,
): ReadinessProbe {
  return async input => {
    let workspaceEvidence: { verified: boolean; evidence: string } | undefined;
    const workspaceRequired = input.checks.some(check => check.kind === "workspace-ready" || check.kind === "artifact-access");
    const instruction = [
      workspaceRequired
        ? "First call project_workspace_check with {} and wait for its result. Use that result for the workspace and source checks in your final report."
        : "This role has no workspace checks.",
      "Check your readiness for the assigned project role. Return one raw JSON object with no Markdown fences or surrounding text:",
      '{"ready":boolean,"checks":[{"id":string,"passed":boolean,"evidence":string}],"reason":string}.',
      "Include exactly one result for every requested check. Report a check as failed if you cannot actually verify it; never infer access from a supplied location or claim you inspected something you did not inspect.",
      `The checks array must contain every one of these exact IDs: ${JSON.stringify(input.checks.map(check => check.id))}. Do not omit an ID, even if several checks use the same tool result.`,
      "Only the checks listed below are required for this role. Do not add workspace or source access as a prerequisite when neither check is listed. Set ready to true if and only if every requested check passes.",
      "This report describes your own assigned role, not the whole team. A role-ready check asks whether you can perform that role; it does not require an existing readiness report or workspace access. This report helps create the readiness record, so do not wait for that record to exist.",
      "Return the report in your final assistant message as text. Do not use a state update to submit the report.",
      JSON.stringify({ projectId: input.projectId, role: input.roleKey, checks: input.checks,
        artifacts: input.artifacts.map(({ typeKey, status }) => ({ typeKey, status })) }),
    ].join("\n");
    const { replyText } = await runTurn({
      ownerUserId: input.actorId, routineId: `project-readiness:${input.projectId}`,
      agentId: input.nativeBotId, threadId: mintThreadId(), instruction,
      workspaceRequired,
      checkWorkspace: async () => workspaceEvidence = verifyWorkspace
        ? await verifyWorkspace(input) : { verified: false, evidence: "Project-scoped workspace access is unavailable." },
    });
    let value: unknown;
    if (typeof replyText !== "string" || replyText.length > 64000) throw new Error("Bot returned invalid readiness JSON.");
    const trimmed = replyText.trim();
    const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
    try { value = JSON.parse(fenced ? fenced[1] : trimmed); } catch { throw new Error("Bot returned invalid readiness JSON."); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Bot returned invalid readiness report.");
    const report = value as Record<string, unknown>;
    if (typeof report.ready !== "boolean" || !Array.isArray(report.checks) ||
      (report.reason !== undefined && typeof report.reason !== "string") || report.checks.length !== input.checks.length) {
      throw new Error("Bot returned invalid readiness report.");
    }
    const seen = new Set<string>();
    const checks = report.checks.map((item: unknown) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Bot returned invalid readiness check.");
      const check = item as Record<string, unknown>;
      if (typeof check.id !== "string" || typeof check.passed !== "boolean" || typeof check.evidence !== "string" || !check.evidence.trim() || seen.has(check.id)) {
        throw new Error("Bot returned invalid readiness check.");
      }
      const definition = input.checks.find(expected => expected.id === check.id);
      if (!definition) throw new Error("Bot returned an unknown readiness check.");
      seen.add(check.id);
      // Only a tool invocation during this turn can establish workspace access.
      if (definition.kind === "workspace-ready" || definition.kind === "artifact-access") {
        const verified = workspaceEvidence?.verified === true && check.passed
          && (definition.kind !== "artifact-access" || definition.artifactType === "source-code");
        return { id: check.id, passed: verified, evidence: workspaceEvidence?.evidence ?? "The bot did not verify project-scoped workspace access." };
      }
      return { id: check.id, passed: check.passed, evidence: check.evidence };
    });
    return { ready: report.ready && checks.every(check => check.passed), checks,
      ...(typeof report.reason === "string" ? { reason: report.reason } : {}) };
  };
}
