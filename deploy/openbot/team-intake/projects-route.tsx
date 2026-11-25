import { createFileRoute } from "@tanstack/react-router";
import { TeamProjects } from "@/components/channels/team-projects";

export const Route = createFileRoute("/_authed/_app/projects")({
  validateSearch: (search: Record<string, unknown>) => ({
    project: typeof search.project === "string" ? search.project : undefined,
    businessProject: typeof search.businessProject === "string" ? search.businessProject : undefined,
  }),
  component: ProjectsPage,
});

function ProjectsPage() {
  const search = Route.useSearch();
  return <TeamProjects projectId={search.project} businessProjectId={search.businessProject} />;
}
