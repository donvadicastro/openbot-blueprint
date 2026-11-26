import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { tryClient } from "@/lib/client";

type FolderListing = { path: string; parent: string | null; folders: { name: string; path: string }[] };

export function ProjectFolderPicker({ value, onChange }: {
  value: string;
  onChange: (path: string) => void;
}) {
  const [path, setPath] = useState("/projects");
  const listing = useQuery({
    queryKey: ["blueprint-project-folders", path],
    retry: false,
    queryFn: async ({ signal }): Promise<FolderListing> => {
      const response = await tryClient(`/api/channels/team-projects/folders?path=${encodeURIComponent(path)}`, { signal });
      if (!response.ok) throw new Error("Couldn’t open this folder.");
      return response.json();
    },
  });

  return (
    <section className="space-y-3" aria-label="Project folder">
      <div className="flex flex-wrap items-center gap-2">
        <span className="break-all font-mono text-sm">{path}</span>
        <Button type="button" variant="outline" disabled={path === "/projects"}
          onClick={() => setPath(path.slice(0, path.lastIndexOf("/")) || "/projects")}>Up one folder</Button>
      </div>
      {listing.isPending && <p role="status" className="text-sm">Loading folders…</p>}
      {listing.error && <p role="alert" className="text-sm text-destructive">{listing.error.message}</p>}
      {listing.data?.folders.length === 0 && <p className="text-sm text-muted-foreground">No subfolders here.</p>}
      {Boolean(listing.data?.folders.length) && (
        <ul className="max-h-60 divide-y overflow-y-auto rounded-md border">
          {listing.data?.folders.map(folder => <li key={folder.path}>
            <button className="w-full px-3 py-2 text-left text-sm hover:bg-muted"
              type="button" onClick={() => setPath(folder.path)}>{folder.name}</button>
          </li>)}
        </ul>
      )}
      <Button type="button" variant="outline" disabled={!listing.data}
        onClick={() => listing.data && onChange(listing.data.path)}>Use this folder</Button>
      {value && <p role="status" className="break-all text-sm">Selected folder: {value}</p>}
    </section>
  );
}
