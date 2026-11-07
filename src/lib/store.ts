import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type XYPosition,
} from "@xyflow/react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { nanoid } from "nanoid";
import { BILLING_ACK_KEY, BILLING_NOTICE, isBytePlusKind } from "./byteplus";
import { create } from "zustand";
import { arrange, tidy } from "./layout";
import { propagate } from "./live";
import type { Project } from "./projects";
import {
  ANGLE_LAYOUTS,
  PORT_COLORS,
  angleShots,
  defaultParams,
  findModel,
  gridSize,
  parseViews,
  portsCompatible,
  portsFor,
  promptVars,
  refNumbers,
  type NodeData,
  type NodeKind,
  type NodeStatus,
  type Port,
} from "./spec";

export type FlowNode = Node<NodeData>;

/**
 * The first time a run would launch a BytePlus node, reminds that BytePlus
 * bills the user's own account. False when the user declines.
 */
async function acknowledgeBytePlusBilling(nodes: FlowNode[], edges: Edge[], targetId?: string): Promise<boolean> {
  let acked = false;
  try {
    acked = localStorage.getItem(BILLING_ACK_KEY) === "1";
  } catch {}
  if (acked) return true;
  let scope: Set<string> | null = null;
  if (targetId) {
    scope = new Set([targetId]);
    const stack = [targetId];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of edges) {
        if (e.target === cur && !scope.has(e.source)) {
          scope.add(e.source);
          stack.push(e.source);
        }
      }
    }
  }
  if (!nodes.some((n) => isBytePlusKind(n.data.kind) && (!scope || scope.has(n.id)))) return true;
  const ok = await ask(BILLING_NOTICE, { title: "BytePlus ModelArk", kind: "info", okLabel: "Got it, run", cancelLabel: "Cancel" });
  if (ok) {
    try {
      localStorage.setItem(BILLING_ACK_KEY, "1");
    } catch {}
  }
  return ok;
}

/** Nodes that generate media with a model and keep every result in `history`. */
export function hasHistory(node: FlowNode) {
  const { kind } = node.data;
  return kind === "model" || kind === "recast" || kind === "addAudio" || kind === "upscale" || kind === "upscaleImage" || kind === "voice" || kind === "avatar" || kind === "bpSeedance" || kind === "bpSeedream";
}

/** A connection dragged from a port and dropped somewhere other than a port. */
export interface PendingLink {
  nodeId: string;
  handleId: string;
  /** Which end the drag started from. */
  side: "source" | "target";
}

/** Payload of the `node-status` event emitted by the Rust graph runner. */
export interface NodeStatusEvent {
  id: string;
  status: NodeStatus;
  outputs?: Record<string, string>;
  error?: string;
  /** The error came before any generation was billed. */
  unbilled?: boolean;
}

interface Snapshot {
  nodes: FlowNode[];
  edges: Edge[];
}

const HISTORY_LIMIT = 100;

/** Copied nodes, kept for the session so they can be pasted into another project. */
let clipboard: { nodes: FlowNode[]; edges: Edge[]; pastes: number } | null = null;
/** Each paste without a target lands this much further from the originals. */
const PASTE_OFFSET = 40;

interface FlowState {
  /** Open project; null while on the home page. */
  projectId: string | null;
  trashed: boolean;
  title: string;
  nodes: FlowNode[];
  edges: Edge[];
  /** Targets of the runs in progress: a node id, or "*" for the whole canvas. */
  runs: string[];
  /** Node whose title is being edited, if any. */
  renamingId: string | null;
  setRenaming: (id: string | null) => void;
  /** Sets a node's title; an empty one restores the default. */
  renameNode: (id: string, title: string) => void;
  /** Graph-level message (missing key, run already in progress…). */
  notice: string | null;
  setNotice: (notice: string | null) => void;
  past: Snapshot[];
  future: Snapshot[];
  setTitle: (title: string) => void;
  onNodesChange: (changes: NodeChange<FlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  isValidConnection: (connection: Connection | Edge) => boolean;
  addNode: (kind: NodeKind, position: XYPosition, modelId?: string, init?: Partial<NodeData>) => string;
  duplicateNode: (id: string) => void;
  /**
   * Copies the selected nodes (or `id` when it isn't selected) with their
   * links: those between them, and those coming in from other nodes.
   */
  copyNodes: (id?: string) => void;
  /** Pastes the copied nodes, top-left at `at` or offset from the originals; returns false when nothing is copied. */
  pasteNodes: (at?: XYPosition) => boolean;
  deleteNode: (id: string) => void;
  /** Removes every edge into one input port. */
  disconnect: (nodeId: string, handle: string) => void;
  /** Drops edges leaving output ports that no longer exist (e.g. a smaller grid). */
  pruneOutputs: (nodeId: string) => void;
  /**
   * Swaps a Grid Crop for a Camera angles node in place, keeping its input
   * and the edges of views that still exist.
   */
  gridCropToAngles: (nodeId: string) => void;
  /**
   * Lays nodes out left to right along their links: the selection when two
   * or more nodes are selected, otherwise the whole canvas.
   */
  /** Tidies the selection (or every node): same columns and order, tighter and aligned. `full` lays it out anew. */
  arrangeNodes: (full?: boolean) => void;
  /** Makes an earlier result of a model node its current output again. */
  pickHistory: (nodeId: string, index: number) => void;
  /** Makes this image the project's cover on the home page; null removes it. */
  setCover: (nodeId: string, image: string | null) => void;
  /** Creates one image node per view received by an Aperçu des angles node. */
  extractViews: (nodeId: string) => void;
  /**
   * Connects a dragged link to the first compatible port of `otherId`. A text
   * link dropped on a Prompt adds a variable for it. Returns false if nothing fits.
   */
  autoConnect: (link: PendingLink, otherId: string) => boolean;
  setParam: (id: string, key: string, value: string) => void;
  patchNode: (id: string, patch: Partial<NodeData>) => void;
  /** Records the current graph so the next change can be undone. */
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
  /** False when the run didn't start (already running, or the user declined). */
  run: (targetId?: string) => Promise<boolean>;
  /** Stops these nodes, or every running one; Rust cancels their fal requests. */
  stop: (ids?: string[]) => void;
  applyStatus: (event: NodeStatusEvent) => void;
  clear: () => void;
  /**
   * Empties the results (current output and history) of model nodes: those in
   * `ids`, else the selected ones, else all. Returns how many were purged.
   */
  purgeResults: (ids?: string[]) => number;
  openProject: (project: Project) => void;
  closeProject: () => void;
}

/**
 * The selected nodes (or `id` when it isn't selected) with their links: those
 * between them, and those coming in from other nodes.
 */
/** Models fal retired, and the registry model that replaces each. */
const RENAMED_MODELS: Record<string, string> = { "qwen-image-max": "qwen-image-3" };

function renameModels(nodes: FlowNode[]): FlowNode[] {
  return nodes.map((n) => {
    const to = n.data.kind === "model" ? RENAMED_MODELS[n.data.params.modelId] : undefined;
    return to ? { ...n, data: { ...n.data, params: { ...n.data.params, modelId: to } } } : n;
  });
}

/**
 * Projects saved before numbered reference inputs: the edges into a model's
 * single `refs` input become Image 1, Image 2… in the order they were made.
 */
/** Link colors saved as hex before the themes: now the port's theme variable. */
const OLD_PORT_HEX: Record<string, string> = {
  "#e8b04a": PORT_COLORS.text,
  "#8b7bff": PORT_COLORS.image,
  "#3ecfa0": PORT_COLORS.video,
  "#4fb3ff": PORT_COLORS.audio,
  "#e86fb5": PORT_COLORS.views,
  "#ff8a5c": PORT_COLORS.portrait,
  "#9a9aa3": PORT_COLORS.any,
};

function themeEdges(edges: Edge[]): Edge[] {
  return edges.map((e) => {
    const stroke = e.style?.stroke;
    const themed = typeof stroke === "string" ? OLD_PORT_HEX[stroke.toLowerCase()] : undefined;
    return themed ? { ...e, style: { ...e.style, stroke: themed } } : e;
  });
}

function numberRefs(nodes: FlowNode[], edges: Edge[]): { nodes: FlowNode[]; edges: Edge[] } {
  const counts = new Map<string, number>();
  const renamed = edges.map((e) => {
    if (e.targetHandle !== "refs") return e;
    const node = nodes.find((n) => n.id === e.target);
    const model = node?.data.kind === "model" ? findModel(node.data.params.modelId) : undefined;
    if (!model || model.maxRefs <= 1) return e;
    const i = (counts.get(e.target) ?? 0) + 1;
    counts.set(e.target, i);
    return { ...e, targetHandle: `ref${i}` };
  });
  if (!counts.size) return { nodes, edges };
  return {
    edges: renamed,
    nodes: nodes.map((n) =>
      counts.has(n.id) ? { ...n, data: { ...n.data, params: { ...n.data.params, refs: String(counts.get(n.id)) } } } : n,
    ),
  };
}

function snapshot(nodes: FlowNode[], edges: Edge[], id?: string) {
  const selected = nodes.filter((n) => n.selected);
  const picked = id && !selected.some((n) => n.id === id) ? nodes.filter((n) => n.id === id) : selected;
  if (!picked.length) return null;
  const ids = new Set(picked.map((n) => n.id));
  return { nodes: structuredClone(picked), edges: structuredClone(edges.filter((e) => ids.has(e.target))) };
}

/**
 * Adds a copy of `copy` moved by `shift`, selected, with new ids. Incoming
 * links from outside the copy reconnect to the same source when it's still on
 * the canvas (it may be gone, or in another project). Records an undo step.
 */
function placeCopy(state: FlowState, copy: { nodes: FlowNode[]; edges: Edge[] }, shift: XYPosition) {
  state.checkpoint();
  const ids = new Map(copy.nodes.map((n) => [n.id, nanoid(8)]));
  const added: FlowNode[] = structuredClone(copy.nodes).map((n) => ({
    ...n,
    id: ids.get(n.id)!,
    position: { x: n.position.x + shift.x, y: n.position.y + shift.y },
    selected: true,
    dragging: false,
    data: { ...n.data, status: n.data.status === "done" ? "done" : "idle", error: undefined },
  }));
  const present = new Set(state.nodes.map((n) => n.id));
  const links: Edge[] = structuredClone(copy.edges)
    .filter((e) => ids.has(e.source) || present.has(e.source))
    .map((e) => ({ ...e, id: nanoid(8), source: ids.get(e.source) ?? e.source, target: ids.get(e.target)!, selected: false }));
  const edges = [...state.edges, ...links];
  return { edges, nodes: propagate([...state.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), ...added], edges) };
}

function findPort(nodes: FlowNode[], nodeId: string, handle: string | null | undefined, side: "inputs" | "outputs") {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return undefined;
  return { node, port: portsFor(node.data)[side].find((p) => p.id === handle) };
}

/** Upstream node ids of `id`, including `id` itself. */
function ancestors(id: string, edges: Edge[]) {
  const seen = new Set<string>([id]);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of edges) {
      if (e.target === cur && !seen.has(e.source)) {
        seen.add(e.source);
        stack.push(e.source);
      }
    }
  }
  return seen;
}

function wouldCycle(source: string, target: string, edges: Edge[]) {
  return source === target || ancestors(source, edges).has(target);
}

/** True while `id` is running or is the target of a run, so it can't be started twice. */
export function useRunning(id: string) {
  return useFlow((s) => s.runs.includes(id) || s.nodes.some((n) => n.id === id && n.data.status === "running"));
}

export const useFlow = create<FlowState>()((set, get) => ({
  projectId: null,
  trashed: false,
  title: "Untitled",
  nodes: [],
  edges: [],
  runs: [],
  notice: null,
  setNotice: (notice) => set({ notice }),
  renamingId: null,
  setRenaming: (renamingId) => set({ renamingId }),
  renameNode: (id, title) => {
    const node = get().nodes.find((n) => n.id === id);
    const next = title.trim() || undefined;
    set({ renamingId: null });
    if (!node || node.data.title === next) return;
    get().checkpoint();
    get().patchNode(id, { title: next });
  },
  past: [],
  future: [],

  setTitle: (title) => set({ title }),

  checkpoint: () => {
    const { nodes, edges, past } = get();
    set({ past: [...past.slice(-HISTORY_LIMIT + 1), { nodes, edges }], future: [] });
  },

  undo: () => {
    const { past, future, nodes, edges } = get();
    const prev = past.at(-1);
    if (!prev) return;
    set({ ...prev, past: past.slice(0, -1), future: [{ nodes, edges }, ...future] });
  },

  redo: () => {
    const { past, future, nodes, edges } = get();
    const next = future[0];
    if (!next) return;
    set({ ...next, past: [...past, { nodes, edges }], future: future.slice(1) });
  },

  onNodesChange: (changes) => {
    const removing = changes.some((c) => c.type === "remove");
    if (removing) get().checkpoint();
    const nodes = applyNodeChanges(changes, get().nodes);
    // Drags and selection don't change values; skip the recompute for them.
    set({ nodes: removing ? propagate(nodes, get().edges) : nodes });
  },

  onEdgesChange: (changes) => {
    const removing = changes.some((c) => c.type === "remove");
    if (removing) get().checkpoint();
    const edges = applyEdgeChanges(changes, get().edges);
    set(removing ? { edges, nodes: propagate(get().nodes, edges) } : { edges });
  },

  onConnect: (connection) => {
    const { nodes, edges, checkpoint } = get();
    const src = findPort(nodes, connection.source, connection.sourceHandle, "outputs");
    const dst = findPort(nodes, connection.target, connection.targetHandle, "inputs");
    checkpoint();
    // Single-value inputs keep only their latest edge.
    const kept = dst?.port?.multiple
      ? edges
      : edges.filter((e) => !(e.target === connection.target && e.targetHandle === connection.targetHandle));
    const color = PORT_COLORS[src?.port?.type ?? "any"];
    const next = addEdge({ ...connection, id: nanoid(8), style: { stroke: color, strokeWidth: 2 } }, kept);
    set({ edges: next, nodes: propagate(nodes, next) });
  },

  isValidConnection: (c) => {
    const { nodes, edges } = get();
    const src = findPort(nodes, c.source, c.sourceHandle, "outputs");
    const dst = findPort(nodes, c.target, c.targetHandle, "inputs");
    if (!src?.port || !dst?.port) return false;
    if (!portsCompatible(src.port.type, dst.port.type)) return false;
    const duplicate = edges.some(
      (e) => e.source === c.source && e.sourceHandle === c.sourceHandle && e.target === c.target && e.targetHandle === c.targetHandle,
    );
    return !duplicate && !wouldCycle(c.source, c.target, edges);
  },

  addNode: (kind, position, modelId, init) => {
    get().checkpoint();
    const node: FlowNode = {
      id: nanoid(8),
      type: kind,
      position,
      selected: true,
      data: { kind, params: defaultParams(kind, modelId), outputs: {}, status: "idle", ...init },
    };
    set({ nodes: propagate([...get().nodes.map((n) => ({ ...n, selected: false })), node], get().edges) });
    return node.id;
  },

  duplicateNode: (id) => {
    const copy = snapshot(get().nodes, get().edges, id);
    if (copy) set(placeCopy(get(), copy, { x: PASTE_OFFSET, y: PASTE_OFFSET }));
  },

  copyNodes: (id) => {
    const copy = snapshot(get().nodes, get().edges, id);
    if (copy) clipboard = { ...copy, pastes: 0 };
  },

  pasteNodes: (at) => {
    if (!clipboard) return false;
    clipboard.pastes += 1;
    const origin = {
      x: Math.min(...clipboard.nodes.map((n) => n.position.x)),
      y: Math.min(...clipboard.nodes.map((n) => n.position.y)),
    };
    const shift = at
      ? { x: at.x - origin.x, y: at.y - origin.y }
      : { x: PASTE_OFFSET * clipboard.pastes, y: PASTE_OFFSET * clipboard.pastes };
    set(placeCopy(get(), clipboard, shift));
    return true;
  },

  deleteNode: (id) => {
    get().checkpoint();
    const edges = get().edges.filter((e) => e.source !== id && e.target !== id);
    set({ nodes: propagate(get().nodes.filter((n) => n.id !== id), edges), edges });
  },

  disconnect: (nodeId, handle) => {
    get().checkpoint();
    const edges = get().edges.filter((e) => !(e.target === nodeId && e.targetHandle === handle));
    set({ edges, nodes: propagate(get().nodes, edges) });
  },

  extractViews: (nodeId) => {
    const { nodes, edges } = get();
    const pick = nodes.find((n) => n.id === nodeId);
    const incoming = edges.find((e) => e.target === nodeId && e.targetHandle === "views");
    const source = incoming && nodes.find((n) => n.id === incoming.source);
    const views = parseViews(source?.data.outputs[incoming?.sourceHandle ?? ""]);
    if (!pick || !views.length) return;
    get().checkpoint();
    // A grid 3 per row, sized for image nodes, right of the preview and of
    // anything already in that band of the canvas so nothing gets covered.
    const COLS = 3;
    const [W, H, GAP] = [300, 260, 40];
    const top = pick.position.y;
    const bottom = top + Math.ceil(views.length / COLS) * (H + GAP);
    const left = nodes
      .filter((n) => n.id === nodeId || (n.position.y < bottom && n.position.y + (n.measured?.height ?? H) > top))
      .reduce((x, n) => Math.max(x, n.position.x + (n.measured?.width ?? W) + 80), pick.position.x);
    const created: FlowNode[] = views.map((view, i) => ({
      id: nanoid(8),
      type: "image",
      position: { x: left + (i % COLS) * (W + GAP), y: pick.position.y + Math.floor(i / COLS) * (H + GAP) },
      selected: true,
      data: { kind: "image", params: { path: view.path, media: "image", label: view.label }, outputs: { image: view.path }, status: "done" },
    }));
    set({ nodes: propagate([...nodes.map((n) => ({ ...n, selected: false })), ...created], edges) });
  },

  gridCropToAngles: (nodeId) => {
    const old = get().nodes.find((n) => n.id === nodeId);
    if (!old || old.data.kind !== "gridCrop") return;
    get().checkpoint();
    const { rows, cols } = gridSize(old.data.params);
    const params = defaultParams("angles");
    // Same grid when the angles node offers it, else its default (3×4).
    if (ANGLE_LAYOUTS.some(([c, r]) => c === cols && r === rows)) params.layout = `${cols}x${rows}`;
    params.shots = JSON.stringify(angleShots(params));
    const node: FlowNode = {
      id: nanoid(8),
      type: "angles",
      position: old.position,
      selected: true,
      data: { kind: "angles", params, outputs: {}, status: "idle" },
    };
    const views = new Set(portsFor(node.data).outputs.map((p) => p.id));
    const edges = get().edges.flatMap((e) => {
      if (e.target === nodeId) return e.targetHandle === "image" ? [{ ...e, target: node.id }] : [];
      if (e.source === nodeId) return views.has(e.sourceHandle ?? "") ? [{ ...e, source: node.id }] : [];
      return [e];
    });
    const nodes = [...get().nodes.filter((n) => n.id !== nodeId).map((n) => ({ ...n, selected: false })), node];
    set({ nodes: propagate(nodes, edges), edges });
  },

  pruneOutputs: (nodeId) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const ports = new Set(portsFor(node.data).outputs.map((p) => p.id));
    const edges = get().edges.filter((e) => e.source !== nodeId || ports.has(e.sourceHandle ?? ""));
    if (edges.length !== get().edges.length) set({ edges, nodes: propagate(get().nodes, edges) });
  },

  autoConnect: (link, otherId) => {
    const { nodes, onConnect, isValidConnection } = get();
    const other = nodes.find((n) => n.id === otherId);
    const from = findPort(nodes, link.nodeId, link.handleId, link.side === "source" ? "outputs" : "inputs")?.port;
    if (!other || !from || otherId === link.nodeId) return false;

    // Exact type matches first, so an image link prefers an image port over an untyped one.
    const pick = (ports: Port[]) =>
      [...ports].sort((a, b) => Number(b.type === from.type) - Number(a.type === from.type)).find((p) => {
        const c =
          link.side === "source"
            ? { source: link.nodeId, sourceHandle: link.handleId, target: otherId, targetHandle: p.id }
            : { source: otherId, sourceHandle: p.id, target: link.nodeId, targetHandle: link.handleId };
        return isValidConnection(c);
      });

    if (link.side === "source") {
      // An image dropped on a model taking several: the first free Image n,
      // or a new one, rather than replacing Image 1.
      const model = other.data.kind === "model" ? findModel(other.data.params.modelId) : undefined;
      if (model && model.maxRefs > 1 && from.type === "image") {
        const numbers = refNumbers(model, other.data.params);
        const taken = (i: number) => get().edges.some((e) => e.target === otherId && e.targetHandle === `ref${i}`);
        let free = numbers.find((i) => !taken(i));
        if (free === undefined && numbers.length < model.maxRefs) {
          free = numbers.length + 1;
          get().setParam(otherId, "refs", String(free));
        }
        if (free !== undefined) {
          onConnect({ source: link.nodeId, sourceHandle: link.handleId, target: otherId, targetHandle: `ref${free}` });
          return true;
        }
      }
      const port = pick(portsFor(other.data).inputs.filter((p) => !p.id.startsWith("var:")));
      if (port) {
        onConnect({ source: link.nodeId, sourceHandle: link.handleId, target: otherId, targetHandle: port.id });
        return true;
      }
      if (other.data.kind === "prompt" && (from.type === "text" || from.type === "any")) {
        const vars = promptVars(other.data.params);
        let n = 1;
        while (vars.includes(`var${n}`)) n++;
        const text = other.data.params.text ?? "";
        get().setParam(otherId, "vars", [...vars, `var${n}`].join(","));
        get().setParam(otherId, "text", `${text}${text && !/\s$/.test(text) ? " " : ""}{var${n}}`);
        onConnect({ source: link.nodeId, sourceHandle: link.handleId, target: otherId, targetHandle: `var:var${n}` });
        return true;
      }
      return false;
    }
    const port = pick(portsFor(other.data).outputs);
    if (!port) return false;
    onConnect({ source: otherId, sourceHandle: port.id, target: link.nodeId, targetHandle: link.handleId });
    return true;
  },

  setParam: (id, key, value) =>
    set({
      nodes: propagate(
        get().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, params: { ...n.data.params, [key]: value } } } : n)),
        get().edges,
      ),
    }),

  // Also the path for run results (applyStatus), so previews follow new outputs.
  patchNode: (id, patch) =>
    set({ nodes: propagate(get().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)), get().edges) }),

  /** Execution happens in Rust; progress arrives through `applyStatus`. */
  run: async (targetId) => {
    // Several runs can go at once; Rust shares the nodes they have in common.
    const key = targetId ?? "*";
    if (get().runs.includes(key)) return false;
    if (!(await acknowledgeBytePlusBilling(get().nodes, get().edges, targetId))) return false;
    if (get().runs.includes(key)) return false;
    set({ runs: [...get().runs, key] });
    const { nodes, edges } = get();
    try {
      await invoke("run_graph", {
        nodes: nodes.map((n) => ({ id: n.id, kind: n.data.kind, params: n.data.params, outputs: n.data.outputs })),
        edges: edges.map((e) => ({
          source: e.source,
          sourceHandle: e.sourceHandle ?? "",
          target: e.target,
          targetHandle: e.targetHandle ?? "",
        })),
        target: targetId ?? null,
      });
    } catch (err) {
      // Graph-level failures (missing key) have no node to attach to.
      set({ notice: String(err) });
    } finally {
      set({ runs: get().runs.filter((r) => r !== key) });
    }
    return true;
  },

  stop: (ids) => {
    invoke("stop_nodes", { ids: ids ?? null }).catch((err) => set({ notice: String(err) }));
  },

  applyStatus: ({ id, status, outputs, error, unbilled }) => {
    const node = get().nodes.find((n) => n.id === id);
    // Model results join the node's history, so earlier ones stay reachable.
    const media = outputs && node && hasHistory(node) ? (outputs.image ?? outputs.video ?? outputs.audio) : undefined;
    const history = media ? [...(node!.data.history ?? []).filter((h) => h !== media), media] : undefined;
    get().patchNode(id, { status, error, unbilled: unbilled || undefined, ...(outputs ? { outputs } : {}), ...(history ? { history } : {}) });
  },

  arrangeNodes: (full = false) => {
    const { nodes, edges } = get();
    const selected = nodes.filter((n) => n.selected);
    const target = selected.length >= 2 ? selected : nodes;
    if (target.length < 2) return;
    get().checkpoint();
    const others = nodes.filter((n) => !target.includes(n));
    const positions = full ? arrange(target, edges, others) : tidy(target, edges, others);
    set({ nodes: nodes.map((n) => (positions.has(n.id) ? { ...n, position: positions.get(n.id)! } : n)) });
  },

  setCover: (nodeId, image) =>
    set({
      // One cover per project.
      nodes: get().nodes.map((n) => {
        const cover = n.id === nodeId ? (image ?? undefined) : undefined;
        if (n.data.cover === cover) return n;
        const data = { ...n.data, cover };
        if (!cover) delete data.cover;
        return { ...n, data };
      }),
    }),

  pickHistory: (nodeId, index) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    const value = node?.data.history?.[index];
    if (!node || !value) return;
    const key =
      node.data.outputs.video !== undefined || /\.(mp4|mov|webm)$/i.test(value)
        ? "video"
        : node.data.outputs.audio !== undefined || /\.(mp3|wav|m4a|aac|ogg)$/i.test(value)
          ? "audio"
          : "image";
    // Drafts can only be finalized from the result that produced them.
    // Recast keeps its segments, which are not part of the history.
    const kept = node.data.kind === "recast" ? node.data.outputs : {};
    get().patchNode(nodeId, { outputs: { ...kept, [key]: value }, status: "done", error: undefined });
  },

  clear: () => {
    get().checkpoint();
    set({ nodes: [], edges: [] });
  },

  purgeResults: (ids) => {
    const { nodes, edges } = get();
    const hasResults = (n: FlowNode) => hasHistory(n) && (Object.keys(n.data.outputs).length > 0 || !!n.data.history?.length);
    const selected = nodes.filter((n) => n.selected && hasHistory(n));
    const scope = ids ? new Set(ids) : selected.length ? new Set(selected.map((n) => n.id)) : null;
    const targets = nodes.filter((n) => hasResults(n) && n.data.status !== "running" && (!scope || scope.has(n.id)));
    if (!targets.length) return 0;
    get().checkpoint();
    const purge = new Set(targets.map((n) => n.id));
    set({
      nodes: propagate(
        nodes.map((n) => (purge.has(n.id) ? { ...n, data: { ...n.data, outputs: {}, history: [], status: "idle", error: undefined } } : n)),
        edges,
      ),
    });
    return targets.length;
  },

  openProject: ({ id, title, trashed, ...graph }) => {
    const { nodes, edges } = numberRefs(renameModels(graph.nodes), themeEdges(graph.edges));
    set({ projectId: id, title, trashed, nodes: propagate(nodes, edges), edges, past: [], future: [], notice: null });
  },

  closeProject: () => set({ projectId: null, nodes: [], edges: [], past: [], future: [], notice: null }),
}));
