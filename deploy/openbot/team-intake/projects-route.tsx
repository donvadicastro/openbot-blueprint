import { createFileRoute } from "@tanstack/react-router";
import { TeamProjects } from "@/components/channels/team-projects";

export const Route = createFileRoute("/_authed/_app/projects")({
  validateSearch: (search: Record<string, unknown>) => ({
    project: typeof search.project === "string" ? search.project : undefined,
  }),
  component: ProjectsPage,
});

function ProjectsPage() {
  return <TeamProjects projectId={Route.useSearch().project} />;
}
