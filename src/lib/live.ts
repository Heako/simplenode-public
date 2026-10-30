import type { Edge } from "@xyflow/react";
import { listItems, parseViews, promptVars, type NodeKind } from "./spec";
import type { FlowNode } from "./store";

/**
 * Nodes computed in the UI as the graph changes, without a run. Each rule
 * mirrors the same node in `src-tauri/src/graph.rs`, so what is shown is
 * exactly what a run would send downstream.
 */
const LIVE_KINDS = new Set<NodeKind>(["prompt", "list", "concat", "router", "preview", "anglePick"]);

const SEPARATORS: Record<string, string> = { newline: "\n", space: " ", comma: ", " };

type Ports = Record<string, string>;

/**
 * Replaces `{name}` for each declared variable with its wired value (empty
 * when unwired); unknown `{…}` stays as typed. Mirrors `fill_template` in Rust.
 */
export function fillTemplate(text: string, vars: string[], inputs: Record<string, string[]>) {
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) =>
    vars.includes(name) ? (inputs[`var:${name}`]?.[0] ?? "") : match,
  );
}

function compute(node: FlowNode, inputs: Record<string, string[]>): Ports {
  const { kind, params } = node.data;
  switch (kind) {
    case "prompt":
      return { text: fillTemplate(params.text ?? "", promptVars(params), inputs) };
    case "list":
      return { text: listItems(params)[Number(params.selected) || 0] ?? "" };
    case "anglePick": {
      const views = parseViews(inputs.views?.[0]);
      const view = views[Number(params.selected) || 0] ?? views[0];
      return view ? { image: view.path } : {};
    }
    case "concat": {
      const parts = (inputs.texts ?? []).map((p) => p.trim()).filter(Boolean);
      return { text: parts.join(SEPARATORS[params.separator] ?? "\n") };
    }
    default: {
      // router, preview: pass the first connected value through.
      const value = inputs.value?.[0];
      return value === undefined ? {} : { value };
    }
  }
}

function sameOutputs(a: Ports, b: Ports) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/** Kahn's algorithm; nodes caught in a cycle are left as they are. */
function topoOrder(nodes: FlowNode[], edges: Edge[]) {
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  const queue = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of edges) {
      if (e.source !== id) continue;
      const d = indegree.get(e.target)! - 1;
      indegree.set(e.target, d);
      if (d === 0) queue.push(e.target);
    }
  }
  return order;
}

/**
 * Recomputes live nodes' outputs. Unchanged nodes keep their identity so
 * React Flow only re-renders what actually changed.
 */
export function propagate(nodes: FlowNode[], edges: Edge[]): FlowNode[] {
  if (!nodes.some((n) => LIVE_KINDS.has(n.data.kind))) return nodes;
  const outputs = new Map(nodes.map((n) => [n.id, n.data.outputs]));
  const updated = new Map<string, Ports>();

  for (const id of topoOrder(nodes, edges)) {
    const node = nodes.find((n) => n.id === id)!;
    if (!LIVE_KINDS.has(node.data.kind)) continue;
    const inputs: Record<string, string[]> = {};
    for (const e of edges) {
      if (e.target !== id || !e.targetHandle) continue;
      const value = outputs.get(e.source)?.[e.sourceHandle ?? ""];
      if (value !== undefined) (inputs[e.targetHandle] ??= []).push(value);
    }
    const next = compute(node, inputs);
    if (!sameOutputs(next, node.data.outputs)) {
      outputs.set(id, next);
      updated.set(id, next);
    }
  }

  if (!updated.size) return nodes;
  return nodes.map((n) => (updated.has(n.id) ? { ...n, data: { ...n.data, outputs: updated.get(n.id)! } } : n));
}
