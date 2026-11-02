"use client";

import { ArrowLeftRight } from "lucide-react";
import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

/** A crop in source pixels. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Size {
  w: number;
  h: number;
}

export const ASPECTS: [string, string][] = [
  ["free", "Free"],
  ["1:1", "1:1"],
  ["16:9", "16:9"],
  ["9:16", "9:16"],
  ["4:3", "4:3"],
  ["3:4", "3:4"],
  ["3:2", "3:2"],
  ["2:3", "2:3"],
  ["21:9", "21:9"],
];

const MIN = 16;

function ratioOf(aspect: string): number | null {
  if (aspect === "free") return null;
  const [a, b] = aspect.split(":").map(Number);
  return a > 0 && b > 0 ? a / b : null;
}

/** The largest box of this ratio, centered: the default crop. */
function fullBox(size: Size, ratio: number | null): Box {
  if (!ratio) return { x: 0, y: 0, w: size.w, h: size.h };
  const [w, h] = size.w / size.h > ratio ? [size.h * ratio, size.h] : [size.w, size.w / ratio];
  return { x: (size.w - w) / 2, y: (size.h - h) / 2, w, h };
}

/** The node's crop in pixels. Older nodes with a ratio but no box crop centered (`storage::crop_rect`). */
export function readBox(params: Record<string, string>, size: Size): Box {
  if (params.box !== "1" && params.aspect && params.aspect !== "free") return fullBox(size, ratioOf(params.aspect));
  const pct = (k: string, d: number) => {
    const v = Number(params[k]);
    return Number.isFinite(v) && params[k] !== undefined && params[k] !== "" ? v : d;
  };
  const x = (pct("x", 0) / 100) * size.w;
  const y = (pct("y", 0) / 100) * size.h;
  return { x, y, w: Math.min((pct("w", 100) / 100) * size.w, size.w - x), h: Math.min((pct("h", 100) / 100) * size.h, size.h - y) };
}

/** Keeps the box inside the image, at least MIN pixels wide and high. */
function clampBox(b: Box, size: Size): Box {
  const w = Math.min(Math.max(b.w, MIN), size.w);
  const h = Math.min(Math.max(b.h, MIN), size.h);
  return { x: Math.min(Math.max(b.x, 0), size.w - w), y: Math.min(Math.max(b.y, 0), size.h - h), w, h };
}

/** Same size and ratio, around the same center, shrunk to fit if needed. */
function resizeAround(b: Box, w: number, h: number, size: Size): Box {
  const scale = Math.min(1, size.w / w, size.h / h);
  const [nw, nh] = [w * scale, h * scale];
  return clampBox({ x: b.x + (b.w - nw) / 2, y: b.y + (b.h - nh) / 2, w: nw, h: nh }, size);
}

type Corner = "nw" | "ne" | "sw" | "se";

export default function CropEditor({
  src,
  params,
  onChange,
  toolbar,
}: {
  /** Shown over the top of the image: actions on the cropped result. */
  toolbar?: ReactNode;
  src: string;
  params: Record<string, string>;
  /** New params to merge; called once a gesture ends. */
  onChange: (patch: Record<string, string>) => void;
}) {
  const [size, setSize] = useState<Size | null>(null);
  const [draft, setDraft] = useState<Box | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const aspect = params.aspect ?? "free";
  const ratio = ratioOf(aspect);
  const box = size ? (draft ?? readBox(params, size)) : null;

  function save(b: Box, extra: Record<string, string> = {}) {
    if (!size) return;
    const pct = (v: number, of: number) => String(Math.round((v / of) * 100 * 1000) / 1000);
    onChange({ ...extra, box: "1", x: pct(b.x, size.w), y: pct(b.y, size.h), w: pct(b.w, size.w), h: pct(b.h, size.h) });
  }

  // Moving the box, or resizing it from a corner (the opposite one stays put).
  function start(e: ReactPointerEvent, corner: Corner | null) {
    if (!size || !box || !frame.current) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = frame.current.getBoundingClientRect();
    // Screen pixels to source pixels, whatever the canvas zoom.
    const scale = size.w / rect.width;
    const from = { x: e.clientX, y: e.clientY, box };
    let last = box;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - from.x) * scale;
      const dy = (ev.clientY - from.y) * scale;
      const b = from.box;
      if (!corner) {
        last = clampBox({ ...b, x: b.x + dx, y: b.y + dy }, size);
      } else {
        const left = corner.endsWith("w");
        const top = corner.startsWith("n");
        // The fixed corner, and the free one under the pointer.
        const ax = left ? b.x + b.w : b.x;
        const ay = top ? b.y + b.h : b.y;
        let w = Math.max(MIN, left ? b.w - dx : b.w + dx);
        let h = Math.max(MIN, top ? b.h - dy : b.h + dy);
        // Room left on the moving side.
        const roomW = left ? ax : size.w - ax;
        const roomH = top ? ay : size.h - ay;
        if (ratio) {
          // Follow the larger movement, keep the ratio, then fit.
          if (w / h > ratio) h = w / ratio;
          else w = h * ratio;
          const fit = Math.min(1, roomW / w, roomH / h);
          w *= fit;
          h *= fit;
        } else {
          w = Math.min(w, roomW);
          h = Math.min(h, roomH);
        }
        last = { x: left ? ax - w : ax, y: top ? ay - h : ay, w, h };
      }
      setDraft(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDraft(null);
      save(last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function setAspect(next: string) {
    if (!size) return onChange({ aspect: next });
    save(fullBox(size, ratioOf(next)), { aspect: next });
  }

  function swap() {
    if (!size || !box) return;
    const [a, b] = aspect.split(":");
    const flipped = `${b}:${a}`;
    if (ratio && ASPECTS.some(([v]) => v === flipped)) return setAspect(flipped);
    save(resizeAround(box, box.h, box.w, size));
  }

  function setDimension(key: "w" | "h", value: number) {
    if (!size || !box || !(value > 0)) return;
    let w = key === "w" ? value : box.w;
    let h = key === "h" ? value : box.h;
    if (ratio) {
      if (key === "w") h = w / ratio;
      else w = h * ratio;
    }
    save(resizeAround(box, w, h, size));
  }

  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  const corners: [Corner, string][] = [
    ["nw", "left-0 top-0 cursor-nwse-resize border-t-[3px] border-l-[3px]"],
    ["ne", "right-0 top-0 cursor-nesw-resize border-t-[3px] border-r-[3px]"],
    ["sw", "left-0 bottom-0 cursor-nesw-resize border-b-[3px] border-l-[3px]"],
    ["se", "right-0 bottom-0 cursor-nwse-resize border-b-[3px] border-r-[3px]"],
  ];
  const label = "w-[68px] shrink-0 text-[12px] text-muted";
  const numberBox = "flex min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-panel-2 px-2 py-1.5 text-[12px]";

  return (
    <div className="flex flex-col gap-2.5">
      <div ref={frame} className="checker relative overflow-hidden rounded-lg">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt=""
          className="block w-full select-none"
          draggable={false}
          onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        />
        {toolbar && (
          // Only its buttons take clicks: the frame's top corners stay reachable underneath.
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-end gap-0.5 bg-gradient-to-b from-black/55 to-transparent px-1.5 pt-1.5 pb-4 [&>*]:pointer-events-auto">
            {toolbar}
          </div>
        )}
        {size && box && (
          <div
            className="nodrag absolute cursor-move shadow-[0_0_0_9999px_rgba(0,0,0,0.6)] outline outline-1 outline-white/90"
            style={{ left: pct(box.x, size.w), top: pct(box.y, size.h), width: pct(box.w, size.w), height: pct(box.h, size.h) }}
            onPointerDown={(e) => start(e, null)}
          >
            {/* Rule of thirds. */}
            <div className="pointer-events-none absolute inset-y-0 left-1/3 border-l border-dashed border-white/60" />
            <div className="pointer-events-none absolute inset-y-0 left-2/3 border-l border-dashed border-white/60" />
            <div className="pointer-events-none absolute inset-x-0 top-1/3 border-t border-dashed border-white/60" />
            <div className="pointer-events-none absolute inset-x-0 top-2/3 border-t border-dashed border-white/60" />
            {corners.map(([corner, place]) => (
              <div key={corner} className={`absolute h-4 w-4 border-white ${place}`} onPointerDown={(e) => start(e, corner)} />
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className={label}>Format</span>
        <select
          className="nodrag min-w-0 flex-1 rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-[12px] text-fg outline-none focus:border-accent"
          value={aspect}
          onChange={(e) => setAspect(e.target.value)}
        >
          {ASPECTS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <button
          className="nodrag shrink-0 rounded-lg px-2 py-1.5 text-[12px] text-muted hover:bg-panel-2 hover:text-fg"
          onClick={() => size && save(fullBox(size, ratio))}
          title="The largest frame of this ratio, centered"
        >
          Reset
        </button>
      </div>

      <div className="flex items-center gap-2">
        <span className={label}>Dimensions</span>
        {(["w", "h"] as const).map((key) => (
          <label key={key} className={numberBox}>
            <span className="text-muted">{key === "w" ? "L" : "H"}</span>
            <input
              type="number"
              min={MIN}
              // No native arrows: they ate the room of the digits (↑/↓ still step the value).
              className="nodrag w-full min-w-0 [appearance:textfield] bg-transparent text-fg outline-none tabular-nums [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              // Remounted when the box changes, so typing isn't interrupted.
              key={`${key}-${box ? Math.round(box[key]) : ""}`}
              defaultValue={box ? Math.round(box[key]) : ""}
              onBlur={(e) => setDimension(key, Number(e.target.value))}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
          </label>
        ))}
        <button
          className="nodrag grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-panel-2 hover:text-fg"
          onClick={swap}
          title="Swap orientation (portrait ↔ landscape)"
        >
          <ArrowLeftRight size={14} />
        </button>
      </div>
    </div>
  );
}
