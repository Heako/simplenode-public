import { invoke } from "@tauri-apps/api/core";
import type { Edge } from "@xyflow/react";
import { nanoid } from "nanoid";
import type { FlowNode } from "./store";

/** Mirrors `projects::ProjectMeta` in src-tauri. */
export interface ProjectMeta {
  id: string;
  title: string;
  updatedAt: number;
  thumbnail: string | null;
  trashed: boolean;
}

export interface Project extends ProjectMeta {
  nodes: FlowNode[];
  edges: Edge[];
}

export const listProjects = () => invoke<ProjectMeta[]>("list_projects");
export const loadProject = (id: string) => invoke<Project>("load_project", { id });
export const saveProject = (project: Project) => invoke<ProjectMeta>("save_project", { project });
export const deleteProject = (id: string) => invoke<void>("delete_project", { id });

export function newProjectId() {
  return nanoid(12);
}

/** The image chosen as cover, else the last one produced in the graph: the file's card thumbnail. */
export function thumbnailOf(nodes: FlowNode[]): string | null {
  const cover = nodes.find((n) => n.data.cover)?.data.cover;
  if (cover) return cover;
  for (const n of [...nodes].reverse()) {
    const value = Object.values(n.data.outputs).find((v) => /\.(png|jpe?g|webp|gif)$/i.test(v));
    if (value) return value;
  }
  return null;
}

/** Strips run-time state so a saved project reopens cleanly. */
export function persistableNodes(nodes: FlowNode[]): FlowNode[] {
  return nodes.map(({ id, type, position, data, width, height }) => ({
    id,
    type,
    position,
    // Set only on nodes resized by hand; others size to their content.
    ...(width ? { width, height } : {}),
    data: { ...data, status: data.status === "running" ? "idle" : data.status },
  }));
}
