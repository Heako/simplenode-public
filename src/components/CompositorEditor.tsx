"use client";

import { convertFileSrc } from "@tauri-apps/api/core";
import { AudioLines, Eye, EyeOff, Film, GripVertical, ImageIcon, Pause, Play, Rows3, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useFlow, useRunning } from "@/lib/store";

/** Mirrors `compose::Placement` in src-tauri: canvas pixels and seconds. */
export interface Placement {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  opacity?: number;
  start?: number;
  duration?: number;
  volume?: number;
  /** Seconds; picture and sound fade in from nothing, and out. */
  fadeIn?: number;
  fadeOut?: number;
  /** Sounds and videos: repeated to fill their duration, or the result. */
  loop?: boolean;
  /** Shown instead of "Calque n". */
  name?: string;
  hidden?: boolean;
}

export interface LayerInput {
  /** Port id: "bg", "layer1"… */
  port: string;
  label: string;
  value?: string;
}

type Kind = "image" | "video" | "audio";
interface Info {
  kind: Kind;
  width: number;
  height: number;
  duration: number | null;
}
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Shown for an image when timeline mode has nothing else to go by. */
const IMAGE_SECONDS = 3;

function mediaSrc(value: string) {
  return /^https?:\/\//.test(value) ? value : convertFileSrc(value);
}

function kindOf(value: string): Kind | null {
  const path = value.split(/[?#]/)[0];
  if (/\.(mp4|mov|webm)$/i.test(path)) return "video";
  if (/\.(mp3|wav|m4a|aac|ogg)$/i.test(path)) return "audio";
  if (/\.(png|jpe?g|webp|gif)$/i.test(path)) return "image";
  return null;
}

/** Layers bottom first: the saved order, then those it doesn't list (new ones on top). */
export function orderLayers<T extends { port: string }>(layers: T[], order: string | undefined): T[] {
  let saved: string[] = [];
  try {
    saved = JSON.parse(order || "[]");
  } catch {}
  const rank = (port: string) => {
    const i = saved.indexOf(port);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...layers].sort((a, b) => rank(a.port) - rank(b.port));
}

export function parseComp(value: string | undefined): Record<string, Placement> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Size and length of each connected medium, read by the browser. */
function useInfos(layers: LayerInput[]) {
  const [infos, setInfos] = useState<Record<string, Info>>({});
  const key = layers.map((l) => `${l.port}=${l.value ?? ""}`).join("|");
  useEffect(() => {
    const cleanups: (() => void)[] = [];
    for (const { value } of layers) {
      const kind = value ? kindOf(value) : null;
      if (!value || !kind) continue;
      const done = (info: Info) => setInfos((prev) => ({ ...prev, [value]: info }));
      if (kind === "image") {
        const img = new Image();
        img.onload = () => done({ kind, width: img.naturalWidth, height: img.naturalHeight, duration: null });
        img.src = mediaSrc(value);
        cleanups.push(() => (img.onload = null));
      } else {
        const el = document.createElement(kind);
        el.preload = "metadata";
        el.onloadedmetadata = () => {
          const v = el as HTMLVideoElement;
          done({ kind, width: v.videoWidth ?? 0, height: v.videoHeight ?? 0, duration: Number.isFinite(el.duration) ? el.duration : null });
        };
        el.src = mediaSrc(value);
        cleanups.push(() => {
          el.onloadedmetadata = null;
          el.removeAttribute("src");
          el.load();
        });
      }
    }
    return () => cleanups.forEach((c) => c());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return infos;
}

function fit(info: Info, cw: number, ch: number, cover: boolean): Box {
  const scale = cover ? Math.max(cw / info.width, ch / info.height) : Math.min(cw / info.width, ch / info.height);
  const w = info.width * scale;
  const h = info.height * scale;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

const round = (n: number) => Math.round(n * 100) / 100;
const input = "w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-xs text-fg outline-none focus:border-accent tabular-nums";

function NumberField({ label, value, placeholder, step = 1, onChange }: { label: string; value?: number; placeholder?: string; step?: number; onChange: (v: number | undefined) => void }) {
  return (
    <label className="flex items-center gap-2 rounded-md border border-line bg-panel-2 px-2 py-1.5 text-xs">
      <span className="w-3 shrink-0 text-muted">{label}</span>
      <input
        type="number"
        step={step}
        className="w-full min-w-0 bg-transparent text-fg outline-none tabular-nums"
        value={value === undefined ? "" : round(value)}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      />
    </label>
  );
}

const KIND_ICONS = { image: ImageIcon, video: Film, audio: AudioLines };

export default function CompositorEditor({
  id,
  params,
  layers: inputs,
  onClose,
}: {
  id: string;
  params: Record<string, string>;
  layers: LayerInput[];
  onClose: () => void;
}) {
  const setParam = useFlow((s) => s.setParam);
  const checkpoint = useFlow((s) => s.checkpoint);
  const run = useFlow((s) => s.run);
  const running = useRunning(id);
  const layers = orderLayers(inputs, params.order);
  const infos = useInfos(layers);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const [comp, setComp] = useState(() => parseComp(params.comp));
  // Read when a drag ends, after the renders it caused.
  const latest = useRef(comp);
  latest.current = comp;
  const [selected, setSelected] = useState<string | null>(layers.find((l) => l.value)?.port ?? null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timeline = params.timeline === "true";

  // Undo restores the composition as it was when the editor opened.
  useEffect(() => checkpoint(), [checkpoint]);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => root.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const info = (l: LayerInput) => (l.value ? infos[l.value] : undefined);
  const firstVisual = layers.map(info).find((i) => i && i.kind !== "audio" && i.width > 0);
  const cw = Number(params.width) || firstVisual?.width || 1024;
  const ch = Number(params.height) || firstVisual?.height || 1024;

  function save(next: Record<string, Placement>) {
    setComp(next);
    setParam(id, "comp", JSON.stringify(next));
  }
  function patch(port: string, p: Partial<Placement>, commit = true) {
    const next = { ...comp, [port]: { ...comp[port], ...p } };
    if (commit) save(next);
    else setComp(next);
  }

  /** Where a layer shows, explicit or as the renderer places it by default. */
  function box(l: LayerInput): Box | null {
    const i = info(l);
    if (!i || i.kind === "audio" || !i.width) return null;
    const p = comp[l.port] ?? {};
    if (p.w && p.h) return { x: p.x ?? (cw - p.w) / 2, y: p.y ?? (ch - p.h) / 2, w: p.w, h: p.h };
    const b = fit(i, cw, ch, l.port === "bg");
    return { x: p.x ?? b.x, y: p.y ?? b.y, w: b.w, h: b.h };
  }

  // Timing, as the renderer computes it (`compose::plan`).
  const looped = (l: LayerInput) => {
    const i = info(l);
    return !!comp[l.port]?.loop && !!i && i.kind !== "image" && i.duration != null;
  };
  /** The duration the user set, in timeline mode. */
  const wanted = (l: LayerInput) => {
    const d = comp[l.port]?.duration;
    return timeline && d && d > 0 ? d : null;
  };
  /** Length before loops are stretched to the end; null: as long as the result. */
  const ownLength = (l: LayerInput): number | null => {
    const media = info(l)?.duration ?? null;
    const w = wanted(l);
    if (looped(l)) return w;
    // A medium never plays longer than it lasts.
    if (w != null && media != null) return Math.min(w, media);
    return w ?? media;
  };
  /** Seams of a loop as rendered: sounds overlap each repetition by up to 1 s
   *  (`compose::LOOP_CROSSFADE`), videos follow each other end to end. */
  const loopShape = (l: LayerInput) => {
    const i = info(l);
    const once = i?.duration ?? 0;
    const overlap = i?.kind === "audio" ? Math.min(1, once / 4) : 0;
    return { once, step: once - overlap };
  };
  const startOf = (l: LayerInput) => (timeline ? Math.max(comp[l.port]?.start ?? 0, 0) : 0);
  const connected = layers.filter((l) => l.value && !comp[l.port]?.hidden);
  const ends = (pick: (l: LayerInput) => number | null) =>
    Math.max(0, ...connected.map((l) => {
      const len = pick(l);
      return len == null ? 0 : startOf(l) + len;
    }));
  // Only loops without a duration: they play once.
  const total = ends(ownLength) || ends((l) => info(l)?.duration ?? null) || 5;
  const timing = (l: LayerInput) => {
    const start = startOf(l);
    return { start, length: ownLength(l) ?? total - start };
  };
  /** 0 to 1: where the layer is in its fades at the playhead. */
  const fadeAt = (l: LayerInput) => {
    const p = comp[l.port] ?? {};
    const { start, length } = timing(l);
    const end = start + length;
    let f = 1;
    if (p.fadeIn) f = Math.min(f, (time - start) / p.fadeIn);
    if (p.fadeOut) f = Math.min(f, (end - time) / p.fadeOut);
    return Math.min(Math.max(f, 0), 1);
  };
  const visibleAt = (l: LayerInput) => {
    if (!timeline) return true;
    const t = timing(l);
    return time >= t.start && time < t.start + t.length;
  };

  // Playback of the preview: a clock, videos and sounds follow it.
  const mediaRefs = useRef<Record<string, HTMLMediaElement | null>>({});
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      setTime((t) => {
        const next = t + (now - last) / 1000;
        if (next >= total) {
          setPlaying(false);
          return total;
        }
        return next;
      });
      last = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, total]);
  useEffect(() => {
    for (const l of layers) {
      const el = mediaRefs.current[l.port];
      if (!el) continue;
      const { start, length } = timing(l);
      const once = info(l)?.duration;
      el.loop = looped(l);
      // Within the medium: a loop starts over each time it ends.
      const local = looped(l) && once ? (time - start) % once : time - start;
      const inside = time >= start && time < start + length;
      // Near the medium's own ends, the volume dips as the render's crossfades
      // and anti-click fades do: the browser jumps back to the start abruptly.
      const edge = info(l)?.kind === "audio" && looped(l) ? loopShape(l).once - loopShape(l).step : 0.02;
      const pos = el.currentTime;
      const ends = once && edge > 0 ? Math.min(1, pos / edge, (once - pos) / edge) : 1;
      el.volume = Math.min(comp[l.port]?.volume ?? 1, 1) * fadeAt(l) * Math.min(Math.max(ends, 0), 1);
      if (playing && inside) {
        if (el.paused) {
          el.currentTime = local;
          el.play().catch(() => {});
        }
      } else {
        if (!el.paused) el.pause();
        if (inside && Math.abs(el.currentTime - local) > 0.05) el.currentTime = local;
      }
    }
  });

  // Stage scale: the canvas fits the free space.
  const area = useRef<HTMLDivElement>(null);
  const [space, setSpace] = useState({ w: 800, h: 600 });
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSpace({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const scale = Math.min((space.w - 48) / cw, (space.h - 48) / ch);

  // Dragging a layer, or its corner to resize it (keeping its proportions).
  const drag = useRef<{ port: string; mode: "move" | "resize"; x: number; y: number; box: Box } | null>(null);
  function startDrag(e: ReactPointerEvent, l: LayerInput, mode: "move" | "resize") {
    const b = box(l);
    if (!b) return;
    e.stopPropagation();
    e.preventDefault();
    setSelected(l.port);
    drag.current = { port: l.port, mode, x: e.clientX, y: e.clientY, box: b };
    const move = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = (ev.clientX - d.x) / scale;
      const dy = (ev.clientY - d.y) / scale;
      if (d.mode === "move") {
        patch(d.port, { x: d.box.x + dx, y: d.box.y + dy, w: d.box.w, h: d.box.h }, false);
      } else {
        const w = Math.max(8, d.box.w + dx);
        patch(d.port, { x: d.box.x, y: d.box.y, w, h: (w * d.box.h) / d.box.w }, false);
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      drag.current = null;
      setParam(id, "comp", JSON.stringify(latest.current));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** Montage end to end: images and videos one after the other, full frame. */
  function chain() {
    const next = { ...comp };
    let at = 0;
    for (const l of layers) {
      const i = info(l);
      if (!i || next[l.port]?.hidden || i.kind === "audio") continue;
      const p = { ...next[l.port] };
      const length = p.duration && p.duration > 0 ? p.duration : (i.duration ?? IMAGE_SECONDS);
      const b = fit(i, cw, ch, true);
      next[l.port] = { ...p, ...b, start: at, duration: i.kind === "image" ? length : p.duration };
      at += length;
    }
    save(next);
    setParam(id, "timeline", "true");
    setTime(0);
  }

  const nameOf = (l: LayerInput) => comp[l.port]?.name || l.label;
  /** Drops `port` above `target` in the stack. */
  function reorder(port: string, target: string) {
    if (port === target) return;
    const stack = [...layers].reverse().map((l) => l.port).filter((p) => p !== port);
    stack.splice(stack.indexOf(target), 0, port);
    setParam(id, "order", JSON.stringify(stack.reverse()));
  }

  const current = layers.find((l) => l.port === selected);
  const currentInfo = current ? info(current) : undefined;
  const currentBox = current ? box(current) : null;
  const place = current ? (comp[current.port] ?? {}) : {};
  // Top layer first, as in the stack.
  const stack = [...layers].reverse();
  const hasSound = (l: LayerInput) => info(l)?.kind === "audio" || info(l)?.kind === "video";
  const sizeHint = firstVisual ? `${firstVisual.width}` : "1024";

  return createPortal(
    // `nokey`, focused: the canvas shortcuts (Delete, undo…) stay out of the editor.
    <div ref={root} tabIndex={-1} className="nokey nodrag nowheel fixed inset-0 z-[90] flex flex-col bg-bg text-fg outline-none">
      <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <h2 className="text-[13px] font-medium">Compositeur</h2>
        <span className="text-[11px] text-muted tabular-nums">
          {cw}×{ch} · {round(total)} s
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            className="rounded-lg bg-fg px-3 py-1.5 text-xs font-medium text-bg disabled:opacity-50"
            disabled={running}
            onClick={() => {
              run(id);
              onClose();
            }}
            title="Exports the composition as a video or an image, on this computer (free)"
          >
            {running ? "Exporting…" : "Export"}
          </button>
          <button className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-panel-2 hover:text-fg" onClick={onClose} title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-56 shrink-0 overflow-y-auto border-r border-line bg-panel p-2">
          <h3 className="px-2 pt-1 pb-2 text-[11px] font-medium tracking-wide text-muted uppercase">Layers</h3>
          {stack.map((l) => {
            const i = info(l);
            const Icon = i ? KIND_ICONS[i.kind] : Rows3;
            const hidden = !!comp[l.port]?.hidden;
            return (
              <div
                key={l.port}
                draggable={renaming !== l.port}
                onDragStart={(e) => {
                  setDragged(l.port);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  if (dragged) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragged) reorder(dragged, l.port);
                  setDragged(null);
                }}
                onDragEnd={() => setDragged(null)}
                className={`group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12px] ${selected === l.port ? "bg-panel-2" : "hover:bg-panel-2/60"} ${l.value ? "" : "opacity-50"} ${dragged === l.port ? "opacity-40" : ""}`}
                onClick={() => setSelected(l.port)}
              >
                <GripVertical size={12} className="shrink-0 cursor-grab text-muted opacity-0 group-hover:opacity-100" />
                <Icon size={13} className="shrink-0 text-muted" />
                {renaming === l.port ? (
                  <input
                    autoFocus
                    defaultValue={nameOf(l)}
                    placeholder={l.label}
                    className="min-w-0 flex-1 rounded border border-accent bg-panel-2 px-1 text-[12px] outline-none"
                    onFocus={(e) => e.currentTarget.select()}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      patch(l.port, { name: e.currentTarget.value.trim() || undefined });
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate" onDoubleClick={() => setRenaming(l.port)} title="Double-click to rename, drag to reorder">
                    {nameOf(l)}
                  </span>
                )}
                {!l.value && <span className="text-[10px] text-muted">not connected</span>}
                {l.value && (
                  <button
                    className="text-muted opacity-0 group-hover:opacity-100 hover:text-fg data-[on]:opacity-100"
                    data-on={hidden || undefined}
                    onClick={(e) => {
                      e.stopPropagation();
                      patch(l.port, { hidden: !hidden });
                    }}
                    title={hidden ? "Show" : "Hide"}
                  >
                    {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                )}
              </div>
            );
          })}
          <p className="px-2 pt-3 text-[10px] leading-snug text-muted">
            The top layer is in front: drag them to reorder, double-click to rename. Add inputs with “+ Layer” on the node, then connect images, videos or sounds to them.
          </p>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div ref={area} className="relative grid min-h-0 flex-1 place-items-center overflow-hidden" onPointerDown={() => setSelected(null)}>
            <div className="checker relative overflow-hidden shadow-2xl shadow-black/60" style={{ width: cw * scale, height: ch * scale }}>
              {layers.map((l) => {
                const b = box(l);
                const i = info(l);
                if (!l.value || !i) return null;
                const p = comp[l.port] ?? {};
                if (i.kind === "audio") {
                  return <audio key={l.port} ref={(el) => void (mediaRefs.current[l.port] = el)} src={mediaSrc(l.value)} />;
                }
                if (!b || p.hidden) return null;
                const style = {
                  left: b.x * scale,
                  top: b.y * scale,
                  width: b.w * scale,
                  height: b.h * scale,
                  opacity: (p.opacity ?? 1) * fadeAt(l),
                  visibility: visibleAt(l) ? ("visible" as const) : ("hidden" as const),
                };
                return (
                  <div key={l.port} className="absolute cursor-move" style={style} onPointerDown={(e) => startDrag(e, l, "move")}>
                    {i.kind === "video" ? (
                      <video
                        ref={(el) => void (mediaRefs.current[l.port] = el)}
                        src={mediaSrc(l.value)}
                        className="pointer-events-none block h-full w-full object-fill"
                        muted={(p.volume ?? 1) === 0}
                        playsInline
                        preload="auto"
                      />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={mediaSrc(l.value)} alt="" draggable={false} className="pointer-events-none block h-full w-full object-fill" />
                    )}
                  </div>
                );
              })}
            </div>
            {/* Selection frame, above everything and not clipped by the canvas. */}
            {currentBox && current && !place.hidden && (
              <div
                className="pointer-events-none absolute border-2 border-accent"
                style={{
                  left: `calc(50% - ${(cw * scale) / 2}px + ${currentBox.x * scale}px)`,
                  top: `calc(50% - ${(ch * scale) / 2}px + ${currentBox.y * scale}px)`,
                  width: currentBox.w * scale,
                  height: currentBox.h * scale,
                }}
              >
                <div
                  className="pointer-events-auto absolute -right-1.5 -bottom-1.5 h-3 w-3 cursor-nwse-resize rounded-sm border-2 border-accent bg-bg"
                  onPointerDown={(e) => startDrag(e, current, "resize")}
                />
              </div>
            )}
          </div>

          <div className="border-t border-line bg-panel px-4 py-2.5">
            <div className="flex items-center gap-3">
              <button
                className="grid h-7 w-7 place-items-center rounded-md hover:bg-panel-2"
                onClick={() => {
                  if (!playing && time >= total) setTime(0);
                  setPlaying(!playing);
                }}
                title={playing ? "Pause" : "Play"}
              >
                {playing ? <Pause size={14} /> : <Play size={14} />}
              </button>
              <input
                type="range"
                min={0}
                max={total}
                step={0.01}
                value={Math.min(time, total)}
                onChange={(e) => {
                  setPlaying(false);
                  setTime(Number(e.target.value));
                }}
                className="flex-1 accent-[var(--color-accent,#8b5cf6)]"
              />
              <span className="w-24 text-right text-[11px] text-muted tabular-nums">
                {round(time).toFixed(2)} / {round(total).toFixed(2)} s
              </span>
            </div>
            {timeline && (
              <div className="mt-2 max-h-48 space-y-1 overflow-y-auto">
                {stack.filter((l) => l.value && info(l)).map((l) => (
                  <TimelineRow
                    key={l.port}
                    label={nameOf(l)}
                    selected={selected === l.port}
                    start={timing(l).start}
                    length={timing(l).length}
                    max={looped(l) ? null : (info(l)?.duration ?? null)}
                    loop={looped(l) ? loopShape(l) : null}
                    total={total}
                    time={time}
                    onSelect={() => setSelected(l.port)}
                    onChange={(p, commit) => patch(l.port, p, commit)}
                    onSeek={(t) => {
                      setPlaying(false);
                      setTime(t);
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </main>

        <aside className="w-64 shrink-0 space-y-4 overflow-y-auto border-l border-line bg-panel p-4 text-xs">
          <section className="space-y-2">
            <h3 className="text-[11px] font-medium tracking-wide text-muted uppercase">Canvas</h3>
            <div className="grid grid-cols-2 gap-2">
              <NumberField label="W" value={Number(params.width) || undefined} placeholder={sizeHint} onChange={(v) => setParam(id, "width", v ? String(Math.round(v)) : "")} />
              <NumberField
                label="H"
                value={Number(params.height) || undefined}
                placeholder={firstVisual ? `${firstVisual.height}` : "1024"}
                onChange={(v) => setParam(id, "height", v ? String(Math.round(v)) : "")}
              />
            </div>
            <p className="text-[10px] text-muted">Empty: the size of the background.</p>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={timeline} onChange={(e) => setParam(id, "timeline", String(e.target.checked))} />
              Timeline mode
            </label>
            <p className="text-[10px] leading-snug text-muted">
              Each layer has its own start and duration. Without this mode, everything starts together and the video lasts as long as the longest media.
            </p>
            <button className="w-full rounded-md border border-line py-1.5 hover:border-accent" onClick={chain} title="Places the images and videos one after another, full frame">
              Chain end to end
            </button>
          </section>

          {current && (
            <section className="space-y-2 border-t border-line pt-4">
              <h3 className="truncate text-[11px] font-medium tracking-wide text-muted uppercase">{nameOf(current)}</h3>
              {!current.value ? (
                <p className="text-[11px] text-muted">Connect an image, video or sound to this input, and run the connected node.</p>
              ) : !currentInfo ? (
                <p className="text-[11px] text-muted">Reading media…</p>
              ) : (
                <>
                  {currentInfo.kind !== "audio" && currentBox && (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        <NumberField label="X" value={currentBox.x} onChange={(v) => patch(current.port, { ...currentBox, x: v ?? 0 })} />
                        <NumberField label="Y" value={currentBox.y} onChange={(v) => patch(current.port, { ...currentBox, y: v ?? 0 })} />
                        <NumberField
                          label="W"
                          value={currentBox.w}
                          onChange={(v) => v && patch(current.port, { ...currentBox, w: v, h: (v * currentBox.h) / currentBox.w })}
                        />
                        <NumberField
                          label="H"
                          value={currentBox.h}
                          onChange={(v) => v && patch(current.port, { ...currentBox, h: v, w: (v * currentBox.w) / currentBox.h })}
                        />
                      </div>
                      <div className="flex gap-2">
                        <button className="flex-1 rounded-md border border-line py-1.5 hover:border-accent" onClick={() => patch(current.port, fit(currentInfo, cw, ch, false))}>
                          Fit
                        </button>
                        <button className="flex-1 rounded-md border border-line py-1.5 hover:border-accent" onClick={() => patch(current.port, fit(currentInfo, cw, ch, true))}>
                          Fill
                        </button>
                      </div>
                      <label className="block space-y-1">
                        <span className="flex justify-between text-muted">
                          Opacity <span className="tabular-nums">{Math.round((place.opacity ?? 1) * 100)} %</span>
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          value={place.opacity ?? 1}
                          onChange={(e) => patch(current.port, { opacity: Number(e.target.value) })}
                          className="w-full"
                        />
                      </label>
                    </>
                  )}
                  {hasSound(current) && (
                    <label className="block space-y-1">
                      <span className="flex justify-between text-muted">
                        Volume <span className="tabular-nums">{Math.round((place.volume ?? 1) * 100)} %</span>
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={2}
                        step={0.05}
                        value={place.volume ?? 1}
                        onChange={(e) => patch(current.port, { volume: Number(e.target.value) })}
                        className="w-full"
                      />
                    </label>
                  )}
                  {currentInfo.kind !== "image" && (
                    <label className="flex items-center gap-2" title="The media repeats, each sound fading into the next">
                      <input type="checkbox" checked={!!place.loop} onChange={(e) => patch(current.port, { loop: e.target.checked || undefined })} />
                      Loop {timeline && !place.duration ? "until the end" : ""}
                    </label>
                  )}
                  {!place.loop && currentInfo.duration != null && (wanted(current) ?? 0) > currentInfo.duration + 0.05 && (
                    <p className="rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] leading-snug text-amber-200">
                      This media only lasts {round(currentInfo.duration)} s: it stops there. Check “Loop” to repeat it until {round(wanted(current) ?? 0)} s.
                    </p>
                  )}
                  {timeline && (
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1">
                        <span className="text-muted">Start (s)</span>
                        <input
                          type="number"
                          min={0}
                          step={0.1}
                          className={input}
                          value={round(place.start ?? 0)}
                          onChange={(e) => patch(current.port, { start: Math.max(0, Number(e.target.value) || 0) })}
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-muted">Duration (s)</span>
                        <input
                          type="number"
                          min={0}
                          step={0.1}
                          className={input}
                          value={place.duration ? round(place.duration) : ""}
                          placeholder={currentInfo.duration ? `${round(currentInfo.duration)}` : "full"}
                          max={!place.loop && currentInfo.duration != null ? round(currentInfo.duration) : undefined}
                          onChange={(e) => {
                            const d = Number(e.target.value) || undefined;
                            // Not longer than the medium, unless it loops.
                            const limit = !place.loop && currentInfo.duration != null ? currentInfo.duration : Infinity;
                            patch(current.port, { duration: d && Math.min(d, limit) });
                          }}
                        />
                      </label>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <label className="space-y-1">
                      <span className="text-muted">Fade in (s)</span>
                      <input
                        type="number"
                        min={0}
                        step={0.1}
                        className={input}
                        value={place.fadeIn ? round(place.fadeIn) : ""}
                        placeholder="0"
                        onChange={(e) => patch(current.port, { fadeIn: Number(e.target.value) || undefined })}
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-muted">Fade out (s)</span>
                      <input
                        type="number"
                        min={0}
                        step={0.1}
                        className={input}
                        value={place.fadeOut ? round(place.fadeOut) : ""}
                        placeholder="0"
                        onChange={(e) => patch(current.port, { fadeOut: Number(e.target.value) || undefined })}
                      />
                    </label>
                  </div>
                  <p className="text-[10px] leading-snug text-muted">
                    {currentInfo.kind === "audio" ? "The sound" : currentInfo.kind === "video" ? "The picture and sound" : "The picture"} fades in and out smoothly.
                    {currentInfo.kind !== "image" && " Every sound gets an unnoticeable 20 ms fade anyway, which avoids the click at the end."}
                  </p>
                  <button className="text-[11px] text-muted hover:text-fg" onClick={() => save({ ...comp, [current.port]: { hidden: place.hidden, name: place.name } })}>
                    Reset this layer
                  </button>
                </>
              )}
            </section>
          )}
        </aside>
      </div>
    </div>,
    document.body,
  );
}

/** One layer on the timeline: drag the bar to move it, its right edge to change its length. */
function TimelineRow({
  label,
  selected,
  start,
  length,
  total,
  time,
  max,
  loop,
  onSelect,
  onChange,
  onSeek,
}: {
  /** Longest it may be: the medium's own length, unless it loops. */
  max: number | null;
  /** A looped layer: its first play, then where each repetition starts. */
  loop: { once: number; step: number } | null;
  label: string;
  selected: boolean;
  start: number;
  length: number;
  total: number;
  time: number;
  onSelect: () => void;
  onChange: (p: Partial<Placement>, commit: boolean) => void;
  onSeek: (t: number) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const span = useMemo(() => Math.max(total, start + length), [total, start, length]);

  function drag(e: ReactPointerEvent, mode: "move" | "end") {
    e.stopPropagation();
    onSelect();
    const width = track.current?.clientWidth ?? 1;
    const x0 = e.clientX;
    let last: Partial<Placement> = {};
    const move = (ev: PointerEvent) => {
      const dt = ((ev.clientX - x0) / width) * span;
      last = mode === "move" ? { start: Math.max(0, round(start + dt)) } : { duration: Math.min(max ?? Infinity, Math.max(0.1, round(length + dt))) };
      onChange(last, false);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onChange(last, true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <div className="flex items-center gap-2">
      <span className={`w-28 shrink-0 truncate text-[11px] ${selected ? "text-fg" : "text-muted"}`}>{label}</span>
      <div
        ref={track}
        className="relative h-6 flex-1 rounded bg-panel-2"
        onPointerDown={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          onSeek(((e.clientX - rect.left) / rect.width) * span);
        }}
      >
        <div
          className={`absolute inset-y-0.5 cursor-grab rounded ${selected ? "bg-accent/70" : "bg-accent/35"}`}
          style={{ left: `${(start / span) * 100}%`, width: `${(length / span) * 100}%` }}
          onPointerDown={(e) => drag(e, "move")}
        >
          {loop && loop.once < length && (
            // The repetitions, grey, with a line at each seam.
            <div
              className="pointer-events-none absolute inset-y-0 right-0 overflow-hidden rounded-r bg-zinc-500/60"
              style={{
                left: `${(loop.once / length) * 100}%`,
                backgroundImage: "repeating-linear-gradient(135deg, transparent 0 4px, rgba(255,255,255,0.12) 4px 8px)",
              }}
            >
              {Array.from({ length: Math.min(Math.ceil((length - loop.once) / loop.step), 200) }, (_, j) => (
                <div
                  key={j}
                  className="absolute inset-y-0 w-px bg-white/50"
                  style={{ left: `${((j * loop.step) / (length - loop.once)) * 100}%` }}
                />
              ))}
            </div>
          )}
          <div
            className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r bg-accent"
            title={max != null ? `Shorten (${round(max)} s at most, or check "Loop")` : "Change the duration"}
            onPointerDown={(e) => drag(e, "end")}
          />
        </div>
        <div className="pointer-events-none absolute inset-y-0 w-px bg-fg" style={{ left: `${(Math.min(time, span) / span) * 100}%` }} />
      </div>
    </div>
  );
}
