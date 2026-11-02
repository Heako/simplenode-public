"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Background, BackgroundVariant, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow, useViewport } from "@xyflow/react";
import { AlignHorizontalDistributeCenter, Eraser, Hand, MousePointer2, Play, Redo2, Square, Trash2, Undo2 } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { hasHistory, useFlow, type NodeStatusEvent, type PendingLink } from "@/lib/store";
import { useModels } from "@/lib/spec";
import { persistableNodes, saveProject, thumbnailOf } from "@/lib/projects";
import { AddNodeMenu, NodeMenu, type MenuState } from "./ContextMenus";
import Inspector from "./Inspector";
import Library from "./Library";
import { nodeTypes } from "./nodes";

type Tool = "select" | "pan";

/** What an Import node holds for a dropped file, from its extension. */
function mediaOf(path: string): "image" | "video" | "audio" | null {
  if (/\.(png|jpe?g|webp|gif)$/i.test(path)) return "image";
  if (/\.(mp4|mov|webm)$/i.test(path)) return "video";
  if (/\.(mp3|wav|m4a|aac|ogg)$/i.test(path)) return "audio";
  return null;
}

/** Floating card, top right: run controls. The API key lives on the home page. */
function RunCard() {
  const run = useFlow((s) => s.run);
  const running = useFlow((s) => s.runs.includes("*"));
  const busy = useFlow((s) => s.nodes.some((n) => n.data.status === "running"));
  const stop = useFlow((s) => s.stop);
  const clear = useFlow((s) => s.clear);
  const purgeResults = useFlow((s) => s.purgeResults);
  const setNotice = useFlow((s) => s.setNotice);
  const scoped = useFlow((s) => s.nodes.some((n) => n.selected && hasHistory(n)));

  function purge() {
    const count = purgeResults();
    setNotice(
      count
        ? `Results cleared on ${count} model${count > 1 ? "s" : ""} (undo with ⌘Z).`
        : "No results to clear.",
    );
  }

  return (
    <div className="absolute top-4 right-4 z-10 flex items-center gap-1.5 rounded-2xl border border-line bg-panel/95 p-1.5 shadow-xl backdrop-blur">
      <button
        className="grid h-7 w-7 place-items-center rounded-lg text-muted hover:text-fg"
        title="Clear the canvas (undo with ⌘Z)"
        onClick={clear}
      >
        <Trash2 size={13} />
      </button>
      <button
        className="grid h-7 w-7 place-items-center rounded-lg text-muted hover:text-fg"
        title={`Clear the results of ${scoped ? "the selected models" : "every model"}: image and history (undo with ⌘Z)`}
        onClick={purge}
      >
        <Eraser size={13} />
      </button>
      {busy && (
        <button
          className="flex items-center gap-1.5 rounded-lg border border-red-500/50 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/10"
          title="Stops every running node and cancels their requests"
          onClick={() => stop()}
        >
          <Square size={11} fill="currentColor" /> Stop all
        </button>
      )}
      <button
        className="flex items-center gap-1.5 rounded-lg bg-fg px-3 py-1.5 text-xs font-medium text-bg disabled:opacity-50"
        disabled={running}
        title="Runs the nodes that have no result yet; paid nodes already rendered are not run again"
        onClick={() => run()}
      >
        <Play size={12} fill="currentColor" />
        {running ? "Running…" : "Run all"}
      </button>
    </div>
  );
}

const ZOOMS = [0.25, 0.5, 0.75, 1, 1.5, 2];

/**
 * Arranges the selection (two or more nodes) in place, or the whole canvas
 * and then frames it.
 */
function useArrange() {
  const arrangeNodes = useFlow((s) => s.arrangeNodes);
  const { fitView } = useReactFlow();
  return useCallback(() => {
    const wholeCanvas = useFlow.getState().nodes.filter((n) => n.selected).length < 2;
    arrangeNodes();
    // Next frame: React Flow has applied the new positions by then.
    if (wholeCanvas) requestAnimationFrame(() => fitView({ duration: 300, padding: 0.15 }));
  }, [arrangeNodes, fitView]);
}

/** Floating toolbar, bottom center. */
function BottomBar({ tool, setTool }: { tool: Tool; setTool: (t: Tool) => void }) {
  const undo = useFlow((s) => s.undo);
  const redo = useFlow((s) => s.redo);
  const canUndo = useFlow((s) => s.past.length > 0);
  const canRedo = useFlow((s) => s.future.length > 0);
  const { zoomTo, fitView } = useReactFlow();
  const { zoom } = useViewport();
  const arrange = useArrange();
  const selection = useFlow((s) => s.nodes.filter((n) => n.selected).length);
  const btn = "grid h-9 w-9 place-items-center rounded-lg text-muted hover:text-fg disabled:opacity-30";

  return (
    <div className="absolute bottom-5 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-2xl border border-line bg-panel/95 p-1.5 shadow-xl backdrop-blur">
      <button className={`${btn} ${tool === "select" ? "!bg-fg !text-bg" : ""}`} onClick={() => setTool("select")} title="Select (V)">
        <MousePointer2 size={16} />
      </button>
      <button className={`${btn} ${tool === "pan" ? "!bg-fg !text-bg" : ""}`} onClick={() => setTool("pan")} title="Main (H)">
        <Hand size={16} />
      </button>
      <div className="mx-1 h-6 w-px bg-line" />
      <button className={btn} onClick={undo} disabled={!canUndo} title="Undo (⌘Z)">
        <Undo2 size={16} />
      </button>
      <button className={btn} onClick={redo} disabled={!canRedo} title="Redo (⇧⌘Z)">
        <Redo2 size={16} />
      </button>
      <div className="mx-1 h-6 w-px bg-line" />
      <button
        className={btn}
        onClick={arrange}
        title={selection >= 2 ? `Arrange the ${selection} selected nodes (⇧L)` : "Arrange all nodes (⇧L)"}
      >
        <AlignHorizontalDistributeCenter size={16} />
      </button>
      <div className="mx-1 h-6 w-px bg-line" />
      <select
        className="h-9 rounded-lg bg-transparent px-2 text-xs text-fg outline-none hover:bg-panel-2"
        value=""
        onChange={(e) => (e.target.value === "fit" ? fitView({ duration: 200 }) : zoomTo(Number(e.target.value), { duration: 200 }))}
      >
        <option value="" hidden>
          {Math.round(zoom * 100)}%
        </option>
        {ZOOMS.map((z) => (
          <option key={z} value={z}>
            {z * 100}%
          </option>
        ))}
        <option value="fit">Ajuster</option>
      </select>
    </div>
  );
}

/** In-app replacement for alert(): stays until dismissed. */
function Notice() {
  const notice = useFlow((s) => s.notice);
  const setNotice = useFlow((s) => s.setNotice);
  if (!notice) return null;
  return (
    <div className="absolute top-16 right-4 z-20 flex max-w-sm items-start gap-2 rounded-xl border border-red-500/40 bg-panel px-3 py-2.5 text-xs shadow-xl">
      <span className="flex-1 leading-relaxed text-red-200">{notice}</span>
      <button className="text-muted hover:text-fg" onClick={() => setNotice(null)} title="Close">
        ✕
      </button>
    </div>
  );
}

function Canvas() {
  // Only what the canvas uses: a whole-store subscription re-rendered it on
  // every unrelated change (run state, notices, history).
  const { nodes, edges, onNodesChange, onEdgesChange, onConnect, isValidConnection, addNode, patchNode, checkpoint, undo, redo, autoConnect } =
    useFlow(
      useShallow((s) => ({
        nodes: s.nodes,
        edges: s.edges,
        onNodesChange: s.onNodesChange,
        onEdgesChange: s.onEdgesChange,
        onConnect: s.onConnect,
        isValidConnection: s.isValidConnection,
        addNode: s.addNode,
        patchNode: s.patchNode,
        checkpoint: s.checkpoint,
        undo: s.undo,
        redo: s.redo,
        autoConnect: s.autoConnect,
      })),
    );
  const { screenToFlowPosition } = useReactFlow();
  /** Last pointer position on screen, where ⌘V pastes. */
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [menu, setMenu] = useState<MenuState>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const arrange = useArrange();

  // Image, video and audio files dropped from Finder become Import nodes.
  // Tauri reports physical pixels, so convert to CSS pixels for the canvas.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent(async ({ payload }) => {
      if (payload.type !== "drop") return;
      const ratio = window.devicePixelRatio || 1;
      const origin = screenToFlowPosition({ x: payload.position.x / ratio, y: payload.position.y / ratio });
      const files = payload.paths.flatMap((path) => {
        const media = mediaOf(path);
        return media ? [{ path, media }] : [];
      });
      for (const [i, { path, media }] of files.entries()) {
        const id = addNode("image", { x: origin.x - 150 + i * 40, y: origin.y - 20 + i * 40 });
        try {
          const stored = await invoke<string>("import_image", { path });
          patchNode(id, { params: { path: stored, media }, outputs: { [media]: stored }, status: "done" });
        } catch (err) {
          patchNode(id, { status: "error", error: String(err) });
        }
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [addNode, patchNode, screenToFlowPosition]);

  function openAddMenu(e: ReactMouseEvent | MouseEvent) {
    e.preventDefault();
    setMenu({ type: "add", x: e.clientX, y: e.clientY });
  }

  // Edges feeding a running node are animated.
  // Keyed by a string so typing (which changes `nodes`) doesn't rebuild every edge.
  const runningKey = nodes
    .filter((n) => n.data.status === "running")
    .map((n) => n.id)
    .join(",");
  const shownEdges = useMemo(() => {
    if (!runningKey) return edges;
    const running = new Set(runningKey.split(","));
    return edges.map((e) => (running.has(e.target) ? { ...e, animated: true } : e));
  }, [edges, runningKey]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable=true], .nokey")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
        useFlow.getState().copyNodes();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
        // Under the pointer when it's over the canvas, else beside the originals.
        const over = pointer.current && document.elementFromPoint(pointer.current.x, pointer.current.y)?.closest(".react-flow__pane");
        if (useFlow.getState().pasteNodes(over ? screenToFlowPosition(pointer.current!) : undefined)) e.preventDefault();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        const first = useFlow.getState().nodes.find((n) => n.selected);
        if (first) useFlow.getState().duplicateNode(first.id);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        // WebKit would select every text on the page; select the nodes instead.
        e.preventDefault();
        useFlow.setState((s) => ({ nodes: s.nodes.map((n) => (n.selected ? n : { ...n, selected: true })) }));
      } else if (e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        arrange();
      } else if (e.key === "v") setTool("select");
      else if (e.key === "h") setTool("pan");
    }
    // A stray text selection (from a field or a triple-click) would stay
    // highlighted across the canvas; a click outside any field drops it.
    function onMove(e: PointerEvent) {
      pointer.current = { x: e.clientX, y: e.clientY };
    }
    function onDown(e: PointerEvent) {
      if (!(e.target as HTMLElement).closest("input, textarea, [contenteditable=true]")) window.getSelection()?.removeAllRanges();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
    };
  }, [undo, redo, arrange, screenToFlowPosition]);

  return (
    <div
      className="relative flex-1"
      onDoubleClick={(e) => (e.target as HTMLElement).classList.contains("react-flow__pane") && openAddMenu(e)}
    >
      <ReactFlow
        nodes={nodes}
        edges={shownEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStart={checkpoint}
        onPaneContextMenu={openAddMenu}
        onConnectEnd={(event, state) => {
          if (state.isValid || !state.fromNode || !state.fromHandle?.id) return;
          const link: PendingLink = { nodeId: state.fromNode.id, handleId: state.fromHandle.id, side: state.fromHandle.type };
          const point = "changedTouches" in event ? event.changedTouches[0] : event;
          const dropped = (document.elementFromPoint(point.clientX, point.clientY) as HTMLElement | null)?.closest<HTMLElement>(".react-flow__node");
          // On a node body: connect to its first compatible port.
          if (dropped?.dataset.id) autoConnect(link, dropped.dataset.id);
          // On empty canvas: offer the nodes that can take this link.
          else setMenu({ type: "add", x: point.clientX, y: point.clientY, link });
        }}
        onNodeContextMenu={(e, node) => {
          e.preventDefault();
          setMenu({ type: "node", x: e.clientX, y: e.clientY, nodeId: node.id });
        }}
        onMoveStart={closeMenu}
        zoomOnDoubleClick={false}
        // Shift+click adds to the selection, as in Figma; ⌘+click too. Shift no
        // longer starts a box selection: dragging the pane already does.
        multiSelectionKeyCode={["Meta", "Shift"]}
        selectionKeyCode={null}
        isValidConnection={isValidConnection}
        colorMode="dark"
        fitView
        fitViewOptions={{ maxZoom: 1 }}
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={["Backspace", "Delete"]}
        panOnDrag={tool === "pan" ? true : [1, 2]}
        selectionOnDrag={tool === "select"}
        panOnScroll
        zoomOnPinch
        defaultEdgeOptions={{ type: "default" }}
        connectionLineStyle={{ stroke: "var(--accent)", strokeWidth: 2 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#34343a" />
        <MiniMap pannable zoomable position="bottom-right" maskColor="rgba(0,0,0,0.55)" nodeColor="#3a3a42" className="!rounded-xl !border !border-line" />
      </ReactFlow>
      <RunCard />
      <Notice />
      <BottomBar tool={tool} setTool={setTool} />
      {menu?.type === "add" && <AddNodeMenu x={menu.x} y={menu.y} link={menu.link} onClose={closeMenu} />}
      {menu?.type === "node" && <NodeMenu x={menu.x} y={menu.y} nodeId={menu.nodeId} onClose={closeMenu} />}
    </div>
  );
}

const AUTOSAVE_DELAY_MS = 600;

function saveCurrent() {
  const s = useFlow.getState();
  if (!s.projectId) return Promise.resolve();
  return saveProject({
    id: s.projectId,
    title: s.title,
    trashed: s.trashed,
    updatedAt: 0,
    thumbnail: thumbnailOf(s.nodes),
    nodes: persistableNodes(s.nodes),
    edges: s.edges.map(({ id, source, sourceHandle, target, targetHandle, style }) => ({ id, source, sourceHandle, target, targetHandle, style })),
  })
    .then(() => undefined)
    .catch((err) => s.setNotice(`Sauvegarde impossible : ${err}`));
}

/** Debounced save on every graph or title change; flushed when leaving. */
function useAutosave() {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = useFlow.subscribe((s, prev) => {
      if (s.nodes === prev.nodes && s.edges === prev.edges && s.title === prev.title) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(saveCurrent, AUTOSAVE_DELAY_MS);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer.current);
    };
  }, []);
  return useCallback(() => {
    clearTimeout(timer.current);
    return saveCurrent();
  }, []);
}

export default function Editor() {
  const applyStatus = useFlow((s) => s.applyStatus);
  const closeProject = useFlow((s) => s.closeProject);
  const loadModels = useModels((s) => s.load);
  const flush = useAutosave();

  async function goHome() {
    await flush();
    closeProject();
  }

  useEffect(() => {
    loadModels();
    const unlisten = listen<NodeStatusEvent>("node-status", (e) => applyStatus(e.payload));
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [applyStatus, loadModels]);

  return (
    <ReactFlowProvider>
      <div className="flex h-screen">
        <Library onHome={goHome} />
        <Canvas />
        <Inspector />
      </div>
    </ReactFlowProvider>
  );
}
