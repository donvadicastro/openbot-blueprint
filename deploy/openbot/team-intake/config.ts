import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReadinessField } from "./readiness";
import { setupQuestions } from "./setup-form";
import type { SetupForm } from "./setup-form";

export type TeamIntake = {
  id: string;
  agentId: string;
  name: string;
  welcomeMessage: string;
  handoffTo?: string;
  discoveryBy?: string;
  form?: boolean;
};

type BlueprintMetadata = {
  id: string;
  entrypoint: string;
  intake?: Pick<TeamIntake, "welcomeMessage" | "handoffTo" | "discoveryBy" | "form">;
  agents: { id: string; name: string; tier: "core" | "optional"; readiness?: ReadinessField[] }[];
};

/** The bundled exporter already includes the validated blueprint as a sidecar. */
function readBlueprint(directory: string): BlueprintMetadata | undefined {
  let source: string;
  try {
    source = readFileSync(join(directory, "blueprint.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return JSON.parse(source) as BlueprintMetadata;
}

export function readReadiness(directory: string) {
  return new Map(readBlueprint(directory)?.agents.map(({ id, readiness }) => [id, readiness]));
}

export function readSetupForm(directory: string, exportedIds: Set<string>): SetupForm | undefined {
  const blueprint = readBlueprint(directory);
  if (!blueprint?.intake?.form) return;
  const coreFields = blueprint.agents
    .filter(bot => bot.tier === "core" && exportedIds.has(bot.id))
    .flatMap(bot => bot.readiness ?? []);
  return { questions: setupQuestions(coreFields) };
}

export function readTeamIntake(directory: string): TeamIntake | undefined {
  const blueprint = readBlueprint(directory);
  if (!blueprint?.intake) return undefined;
  const agent = blueprint.agents.find(({ id }) => id === blueprint.entrypoint);
  if (!agent) throw new Error("The team intake entrypoint is missing from the blueprint.");
  return {
    id: blueprint.id,
    agentId: agent.id,
    name: agent.name,
    ...blueprint.intake,
  };
}
