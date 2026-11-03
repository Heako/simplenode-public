"use client";

import { useReactFlow } from "@xyflow/react";
import {
  Crop,
  Eye,
  FileText,
  Camera,
  Clapperboard,
  Film,
  FolderDown,
  ImageIcon,
  ImageUp,
  Images,
  ListChecks,
  AudioLines,
  Layers,
  Grid3x3,
  Merge,
  Search,
  Sparkles,
  Split,
  Type,
  WandSparkles,
  Wrench,
  ScanFace,
  Frame,
  ScrollText,
  MonitorUp,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useFlow } from "@/lib/store";
import ProviderIcon from "./ProviderIcon";
import { findModel, libraryItems, useModels, type LibraryItem } from "@/lib/spec";
import { FAL_ONLY_KINDS, useKeys } from "@/lib/provider";

type Section = "search" | "tools" | "image" | "video" | "audio" | "text";

const RAIL: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: "search", label: "All", icon: Search },
  { id: "tools", label: "Tools", icon: Wrench },
  { id: "image", label: "Image", icon: ImageIcon },
  { id: "video", label: "Video", icon: Clapperboard },
  { id: "audio", label: "Audio", icon: AudioLines },
  { id: "text", label: "Text", icon: Sparkles },
];

export const GROUP_TITLES: Record<LibraryItem["group"], string> = {
  inputs: "Inputs",
  tools: "Tools",
  image: "Image models",
  video: "Video models",
  audio: "Music & sound",
  text: "Text & analysis",
  outputs: "Outputs",
};

const GROUP_ORDER: LibraryItem["group"][] = ["inputs", "tools", "image", "video", "audio", "text", "outputs"];

/** Node width is 300px; this centers a new node on the drop point. */
const NODE_HALF_WIDTH = 150;

const KIND_ICONS: Partial<Record<LibraryItem["kind"], LucideIcon>> = {
  prompt: Type,
  image: ImageUp,
  preview: Eye,
  router: Split,
  list: ListChecks,
  gridCrop: Grid3x3,
  angles: Camera,
  anglePick: Images,
  angleExport: FolderDown,
  concat: Merge,
  crop: Crop,
  frame: Frame,
  enhancer: WandSparkles,
  describer: FileText,
  videoDescriber: Film,
  motionPrompt: ScrollText,
  upscale: MonitorUp,
  addAudio: AudioLines,
  compositor: Layers,
  bpPortrait: ScanFace,
};

export function itemIcon(item: LibraryItem): LucideIcon {
  return KIND_ICONS[item.kind] ?? (item.group === "text" ? Sparkles : item.group === "video" ? Clapperboard : item.group === "audio" ? AudioLines : ImageIcon);
}

export function filterItems(items: LibraryItem[], query: string) {
  const q = query.trim().toLowerCase();
  return items.filter((i) => !q || `${i.label} ${i.hint}`.toLowerCase().includes(q));
}

/**
 * Adds a library item at a screen point and returns its id. `anchor` says which
 * part of the node lands there: its top-center, or its left / right edge so a
 * node created from a dragged link sits beside the link's end.
 */
export function usePlaceItem() {
  const addNode = useFlow((s) => s.addNode);
  const { screenToFlowPosition } = useReactFlow();
  return (item: LibraryItem, screen: { x: number; y: number }, anchor: "center" | "left" | "right" = "center") => {
    const pos = screenToFlowPosition(screen);
    const dx = anchor === "left" ? 0 : anchor === "right" ? -2 * NODE_HALF_WIDTH : -NODE_HALF_WIDTH;
    return addNode(item.kind, { x: pos.x + dx, y: pos.y - 20 }, item.modelId);
  };
}

function sectionGroups(section: Section): LibraryItem["group"][] {
  switch (section) {
    case "tools":
      return ["inputs", "tools", "outputs"];
    case "image":
      return ["image"];
    case "video":
      return ["video"];
    case "audio":
      return ["audio"];
    case "text":
      return ["text"];
    default:
      return GROUP_ORDER;
  }
}

const DRAG_THRESHOLD = 4;

/**
 * Pointer-based drag. HTML5 drag-and-drop doesn't reach the canvas in Tauri,
 * whose native file-drop handler swallows drop events.
 */
function Tile({ item }: { item: LibraryItem }) {
  const place = usePlaceItem();
  // With WaveSpeed as the provider, flag what only runs on fal.
  const needsFal = useKeys((s) => {
    if (s.status?.provider !== "wavespeed") return false;
    return item.kind === "model" ? !findModel(item.modelId)?.wavespeed : FAL_ONLY_KINDS.has(item.kind);
  });
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const Icon = itemIcon(item);

  function onPointerDown(e: ReactPointerEvent) {
    if (e.button !== 0) return;
    start.current = { x: e.clientX, y: e.clientY };
    const onMove = (ev: PointerEvent) => {
      const s = start.current!;
      if (Math.hypot(ev.clientX - s.x, ev.clientY - s.y) > DRAG_THRESHOLD) setGhost({ x: ev.clientX, y: ev.clientY });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const s = start.current!;
      start.current = null;
      setGhost(null);
      const dragged = Math.hypot(ev.clientX - s.x, ev.clientY - s.y) > DRAG_THRESHOLD;
      if (!dragged) {
        // Plain click: drop it in the middle of the visible canvas.
        const pane = document.querySelector(".react-flow")?.getBoundingClientRect();
        if (pane) place(item, { x: pane.left + pane.width / 2, y: pane.top + pane.height / 3 });
        return;
      }
      const over = document.elementFromPoint(ev.clientX, ev.clientY);
      if (over?.closest(".react-flow__pane, .react-flow__node, .react-flow__edges")) place(item, { x: ev.clientX, y: ev.clientY });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <>
      <button
        onPointerDown={onPointerDown}
        title={needsFal ? `${item.hint} — runs on fal.ai only (Settings → Provider)` : item.hint}
        className={`relative flex aspect-square cursor-grab flex-col items-center justify-center gap-1.5 rounded-md border border-line bg-panel px-1 text-center hover:border-[#4a4a52] hover:bg-panel-2 active:cursor-grabbing ${needsFal ? "opacity-45" : ""}`}
      >
        <ProviderIcon modelId={item.modelId} size={17} fallback={Icon} className="text-fg" />
        <span className="line-clamp-2 text-[10px] leading-tight">{item.label}</span>
        {needsFal && <span className="absolute top-1 right-1 rounded bg-panel-2 px-1 text-[8px] text-muted">fal only</span>}
      </button>
      {ghost &&
        createPortal(
          <div
            className="pointer-events-none fixed z-50 flex items-center gap-1.5 rounded-lg border border-accent bg-panel px-2.5 py-1.5 text-xs shadow-2xl"
            style={{ left: ghost.x + 10, top: ghost.y + 10 }}
          >
            <ProviderIcon modelId={item.modelId} size={13} fallback={Icon} className="text-accent" />
            {item.label}
          </div>,
          document.body,
        )}
    </>
  );
}

export default function Library({ onHome }: { onHome: () => void }) {
  const models = useModels((s) => s.models);
  const title = useFlow((s) => s.title);
  const setTitle = useFlow((s) => s.setTitle);
  // Closed by default: the canvas gets the room; the rail opens a section.
  const [section, setSection] = useState<Section | null>(null);
  const [query, setQuery] = useState("");

  const items = useMemo(() => libraryItems(models), [models]);
  const visible = filterItems(items, query);

  // Escape closes the panel when focus isn't in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as HTMLElement).closest("input, textarea")) setSection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full">
      <nav className="flex w-[48px] flex-col items-center gap-0.5 border-r border-line bg-panel py-2.5">
        <button
          className="mb-2 grid h-7 w-7 place-items-center rounded-md bg-accent text-xs font-bold hover:opacity-80"
          onClick={onHome}
          title="Back to home"
        >
          S
        </button>
        {RAIL.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setSection(section === id ? null : id)}
            className={`flex w-10 flex-col items-center gap-0.5 rounded-md py-1.5 text-[9px] ${section === id ? "bg-panel-2 text-fg" : "text-muted hover:text-fg"}`}
          >
            <Icon size={15} strokeWidth={1.7} />
            {label}
          </button>
        ))}
      </nav>

      {section && (
        <aside className="flex w-[184px] flex-col border-r border-line bg-panel">
          <input
            className="mx-3 mt-3 rounded px-1 text-[13px] font-medium outline-none hover:bg-panel-2 focus:bg-panel-2"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <div className="mx-3 mt-2.5 flex items-center gap-1.5 rounded-md border border-line px-2 py-1 focus-within:border-accent">
            <Search size={12} className="text-muted" />
            <input
              className="w-full bg-transparent text-[11px] outline-none placeholder:text-muted"
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="mt-1 flex-1 overflow-y-auto px-3 pb-3">
            {sectionGroups(section).map((group) => {
              const groupItems = visible.filter((i) => i.group === group);
              if (!groupItems.length) return null;
              return (
                <section key={group} className="mt-3">
                  <h3 className="mb-1.5 text-[11px] font-medium text-muted">{GROUP_TITLES[group]}</h3>
                  <div className="grid grid-cols-2 gap-1.5">
                    {groupItems.map((item) => (
                      <Tile key={item.key} item={item} />
                    ))}
                  </div>
                </section>
              );
            })}
            {!visible.length && <div className="mt-6 text-center text-[11px] text-muted">No results</div>}
          </div>
          <p className="border-t border-line px-3 py-2 text-[10px] leading-snug text-muted">
            Drag a tile onto the canvas, or right-click the canvas.
          </p>
        </aside>
      )}
    </div>
  );
}

export { GROUP_ORDER };
