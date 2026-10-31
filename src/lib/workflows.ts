import type { Edge } from "@xyflow/react";
import { nanoid } from "nanoid";
import { PORT_COLORS, defaultParams, recastParams, recastPrompt, type NodeData, type NodeKind, type PortType } from "./spec";
import type { FlowNode } from "./store";

/** A ready-made graph a new file starts from, offered on the home page. */
export interface Workflow {
  id: string;
  title: string;
  description: string;
  /** What the user still has to provide, in order. */
  steps: string[];
  build: () => { nodes: FlowNode[]; edges: Edge[] };
}

function node(kind: NodeKind, x: number, y: number, init: Partial<NodeData> = {}): FlowNode {
  return {
    id: nanoid(8),
    type: kind,
    position: { x, y },
    data: { kind, params: defaultParams(kind), outputs: {}, status: "idle", ...init },
  };
}

function link(source: FlowNode, sourceHandle: string, target: FlowNode, targetHandle: string, type: PortType): Edge {
  return { id: nanoid(8), source: source.id, sourceHandle, target: target.id, targetHandle, style: { stroke: PORT_COLORS[type], strokeWidth: 2 } };
}

/** Source video and character imports wired into a Recast node in `mode`, shown in a Preview. */
function recastGraph(mode: string) {
  const video = node("image", 0, 0, { title: "Vidéo source", params: { path: "", media: "video" } });
  const character = node("image", 0, 330, { title: "Personnage", params: { path: "", media: "image" } });
  const recast = node("recast", 400, 60, { params: { ...recastParams(mode), prompt: recastPrompt(mode), segment: "10" } });
  const preview = node("preview", 820, 60);
  return {
    nodes: [video, character, recast, preview],
    edges: [
      link(video, "video", recast, "video", "video"),
      link(character, "image", recast, "characters", "image"),
      link(recast, "video", preview, "value", "video"),
    ],
  };
}

export const WORKFLOWS: Workflow[] = [
  {
    id: "recast-replace",
    title: "Remplacer un personnage",
    description: "Votre personnage prend la place de la personne filmée. La scène, la lumière, la caméra et le son de la vidéo sont conservés.",
    steps: ["Importez la vidéo source", "Importez l'image de votre personnage", "Exécutez le nœud Recast"],
    build: () => recastGraph("replace"),
  },
  {
    id: "recast-motion",
    title: "Transfert de mouvement",
    description: "Votre personnage, dans son propre décor, reproduit les gestes et les mouvements de caméra de la vidéo.",
    steps: ["Importez la vidéo de référence", "Importez l'image de votre personnage", "Exécutez le nœud Recast"],
    build: () => recastGraph("motion"),
  },
];
