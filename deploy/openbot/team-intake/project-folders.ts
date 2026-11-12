import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const PROJECTS_ROOT = "/projects";

export async function resolveProjectFolder(path: unknown) {
  if (typeof path !== "string" || !isAbsolute(path)) return;
  const relativePath = relative(PROJECTS_ROOT, path);
  if (relativePath === ".." || relativePath.startsWith(".." + sep) ||
      relativePath.split(sep).some(part => part.startsWith("."))) return;
  try {
    const folder = resolve(PROJECTS_ROOT, relativePath);
    const canonical = await realpath(folder);
    if (canonical !== folder || !(await stat(canonical)).isDirectory()) return;
    return folder;
  } catch {
    return;
  }
}

export async function listProjectFolders(path: string) {
  const folder = await resolveProjectFolder(path);
  if (!folder) return;
  const children = await readdir(folder, { withFileTypes: true });
  return {
    path: folder,
    parent: folder === PROJECTS_ROOT ? null : resolve(folder, ".."),
    folders: children
      .filter(child => child.isDirectory() && !child.name.startsWith("."))
      .map(child => ({ name: child.name, path: resolve(folder, child.name) }))
      .sort((first, second) => first.name.localeCompare(second.name)),
  };
}
