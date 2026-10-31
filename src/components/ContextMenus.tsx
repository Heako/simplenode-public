"use client";

import { Copy, CopyPlus, Eraser, PencilLine, Play, Search, Trash2, type LucideIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { hasHistory, useFlow, useRunning, type PendingLink } from "@/lib/store";
import { defaultParams, libraryItems, portsCompatible, portsFor, useModels, type LibraryItem, type PortType } from "@/lib/spec";
import ProviderIcon from "./ProviderIcon";
import { GROUP_ORDER, GROUP_TITLES, filterItems, itemIcon, usePlaceItem } from "./Library";

export type MenuState =
  | { type: "add"; x: number; y: number; link?: PendingLink }
  | { type: "node"; x: number; y: number; nodeId: string }
  | null;

const ADD_MENU_WIDTH = 240;
const NODE_MENU_WIDTH = 180;
const MENU_MAX_HEIGHT = 360;

const EDGE = 8;

/**
 * Where to draw a menu of this size opened at (x, y): at the pointer when it
 * fits, otherwise flipped above / to the left of it, always inside the window.
 */
function place(x: number, y: number, width: number, height: number) {
  const fitsBelow = y + height <= window.innerHeight - EDGE;
  const fitsRight = x + width <= window.innerWidth - EDGE;
  return {
    left: Math.max(EDGE, fitsRight ? x : x - width),
    top: Math.max(EDGE, fitsBelow ? y : y - height),
  };
}

function Frame({ x, y, width, onClose, children }: { x: number; y: number; width: number; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Measured before the first paint, so the menu never shows up in one spot
  // and then jumps to another.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (ref.current) setPos(place(x, y, width, ref.current.offsetHeight));
  }, [x, y, width]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // Defer so the opening right-click doesn't immediately close it.
    const t = setTimeout(() => window.addEventListener("pointerdown", onDown));
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-50 overflow-hidden rounded-xl border border-line bg-panel shadow-2xl shadow-black/60"
      style={{ ...(pos ?? { left: x, top: y }), width, visibility: pos ? "visible" : "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>
  );
}

/** Whether a new node of this kind could take the dragged link. */
function accepts(item: LibraryItem, side: PendingLink["side"], type: PortType) {
  const ports = portsFor({ kind: item.kind, params: defaultParams(item.kind, item.modelId) });
  if (side === "source") {
    // A Prompt takes any text link as a new variable.
    if (item.kind === "prompt") return type === "text" || type === "any";
    return ports.inputs.some((p) => portsCompatible(type, p.type));
  }
  return ports.outputs.some((p) => portsCompatible(p.type, type));
}

/**
 * Right-click on the canvas, or a link dropped on empty canvas: searchable list
 * of nodes, added at that point. With a link, only nodes that can take it are
 * listed, and the new node comes connected.
 */
export function AddNodeMenu({ x, y, link, onClose }: { x: number; y: number; link?: PendingLink; onClose: () => void }) {
  const models = useModels((s) => s.models);
  const place = usePlaceItem();
  const autoConnect = useFlow((s) => s.autoConnect);
  const linkType = useFlow((s) => {
    if (!link) return undefined;
    const node = s.nodes.find((n) => n.id === link.nodeId);
    const ports = node && portsFor(node.data)[link.side === "source" ? "outputs" : "inputs"];
    return ports?.find((p) => p.id === link.handleId)?.type;
  });
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const items = useMemo(() => {
    const visible = filterItems(libraryItems(models), query).filter((i) => !link || !linkType || accepts(i, link.side, linkType));
    // Flatten in display order so arrow keys follow what's on screen.
    return GROUP_ORDER.flatMap((g) => visible.filter((i) => i.group === g));
  }, [models, query, link, linkType]);

  function choose(i: number) {
    const item = items[i];
    if (!item) return;
    if (!link) {
      place(item, { x, y });
    } else {
      // Dragged from an output: the new node sits to the right; from an input, to the left.
      const id = place(item, { x, y }, link.side === "source" ? "left" : "right");
      autoConnect(link, id);
    }
    onClose();
  }

  return (
    <Frame x={x} y={y} width={ADD_MENU_WIDTH} onClose={onClose}>
      <div className="flex items-center gap-1.5 border-b border-line px-2.5 py-2">
        <Search size={12} className="text-muted" />
        <input
          autoFocus
          className="w-full bg-transparent text-xs outline-none placeholder:text-muted"
          placeholder={link ? "Relier à un nouveau nœud…" : "Ajouter un nœud…"}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, items.length - 1));
            else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
            else if (e.key === "Enter") choose(active);
            else return;
            e.preventDefault();
          }}
        />
      </div>
      <div className="overflow-y-auto py-1" style={{ maxHeight: MENU_MAX_HEIGHT - 40 }}>
        {items.map((item, i) => {
          const Icon = itemIcon(item);
          const showGroup = i === 0 || items[i - 1].group !== item.group;
          return (
            <div key={item.key}>
              {showGroup && <div className="px-2.5 pt-2 pb-1 text-[10px] text-muted">{GROUP_TITLES[item.group]}</div>}
              <button
                className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs ${i === active ? "bg-panel-2" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(i)}
              >
                <ProviderIcon modelId={item.modelId} size={13} fallback={Icon} className={item.kind === "model" ? "text-fg" : "text-muted"} />
                <span className="max-w-[70%] shrink-0 truncate">{item.label}</span>
                <span className="min-w-0 flex-1 truncate text-right text-[10px] text-muted">{item.hint}</span>
              </button>
            </div>
          );
        })}
        {!items.length && <div className="px-2.5 py-3 text-center text-[11px] text-muted">Aucun résultat</div>}
      </div>
    </Frame>
  );
}

/** Right-click on a node. */
export function NodeMenu({ x, y, nodeId, onClose }: { x: number; y: number; nodeId: string; onClose: () => void }) {
  const run = useFlow((s) => s.run);
  const running = useRunning(nodeId);
  const duplicateNode = useFlow((s) => s.duplicateNode);
  const copyNodes = useFlow((s) => s.copyNodes);
  const purgeResults = useFlow((s) => s.purgeResults);
  const isModel = useFlow((s) => {
    const node = s.nodes.find((n) => n.id === nodeId);
    return !!node && hasHistory(node);
  });
  const hasResults = useFlow((s) => {
    const data = s.nodes.find((n) => n.id === nodeId)?.data;
    return !!data && (Object.keys(data.outputs).length > 0 || !!data.history?.length);
  });
  const setRenaming = useFlow((s) => s.setRenaming);
  const deleteNode = useFlow((s) => s.deleteNode);

  const entries: { label: string; hint?: string; icon: LucideIcon; disabled?: boolean; danger?: boolean; action: () => void }[] = [
    { label: "Exécuter jusqu'ici", icon: Play, disabled: running, action: () => run(nodeId) },
    { label: "Renommer", icon: PencilLine, action: () => setRenaming(nodeId) },
    { label: "Copier", hint: "⌘C", icon: Copy, action: () => copyNodes(nodeId) },
    { label: "Dupliquer", hint: "⌘D", icon: CopyPlus, action: () => duplicateNode(nodeId) },
    ...(isModel ? [{ label: "Vider les résultats", icon: Eraser, disabled: !hasResults || running, action: () => purgeResults([nodeId]) }] : []),
    { label: "Supprimer", icon: Trash2, danger: true, action: () => deleteNode(nodeId) },
  ];

  return (
    <Frame x={x} y={y} width={NODE_MENU_WIDTH} onClose={onClose}>
      <div className="py-1">
        {entries.map(({ label, hint, icon: Icon, disabled, danger, action }) => (
          <button
            key={label}
            disabled={disabled}
            className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-panel-2 disabled:opacity-40 ${danger ? "text-red-300" : ""}`}
            onClick={() => {
              action();
              onClose();
            }}
          >
            <Icon size={13} />
            {label}
            {hint && <span className="ml-auto text-[10px] text-muted">{hint}</span>}
          </button>
        ))}
      </div>
    </Frame>
  );
}
