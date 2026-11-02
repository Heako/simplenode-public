"use client";

import { convertFileSrc } from "@tauri-apps/api/core";
import {
  ArchiveRestore,
  ArrowRight,
  Copy,
  Drama,
  ImageIcon,
  FolderOpen,
  LayoutGrid,
  LayoutTemplate,
  List,
  MoreHorizontal,
  PencilLine,
  Plus,
  Search,
  Settings as SettingsIcon,
  Trash2,
  Workflow,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useFlow } from "@/lib/store";
import {
  deleteProject,
  listProjects,
  loadProject,
  newProjectId,
  saveProject,
  type ProjectMeta,
} from "@/lib/projects";
import { useModels } from "@/lib/spec";
import { WORKFLOWS, type Workflow as WorkflowDef } from "@/lib/workflows";
import Settings from "./Settings";

type Tab = "files" | "workflows" | "trash" | "settings";
type View = "grid" | "list";

const TITLES: Record<Tab, string> = {
  files: "My workspace",
  workflows: "Workflows",
  trash: "Trash",
  settings: "Settings",
};

const WORKFLOW_GROUPS: [WorkflowDef["category"], string][] = [
  ["image", "Image"],
  ["video", "Video"],
];

/** Ready-made graphs; picking one creates a file that starts from it. */
/** `compact`: the short version shown above the files, with a link to the full tab. */
function Workflows({ onPick, compact, onMore }: { onPick: (workflow: WorkflowDef) => void; compact?: boolean; onMore?: () => void }) {
  // Workflows read model defaults from the registry, loaded at startup.
  const ready = useModels((s) => s.recastModes.length > 0);
  return (
    <>
      {compact ? (
        <div className="mt-8 flex items-center gap-3">
          <h2 className="mr-auto text-[15px] font-medium">Workflows</h2>
          <button className="flex items-center gap-1 text-[12px] text-muted hover:text-fg" onClick={onMore}>
            See all <ArrowRight size={13} />
          </button>
        </div>
      ) : (
        <p className="mt-2 text-[13px] text-muted">A workflow creates a new, already wired file: just import your media and run.</p>
      )}
      {compact ? (
        // Home page: one scrolling ribbon of compact cards, image workflows first.
        <div className="-mx-1 mt-4 flex snap-x gap-3 overflow-x-auto px-1 pb-2">
          {WORKFLOW_GROUPS.flatMap(([category, label]) =>
            WORKFLOWS.filter((w) => w.category === category).map((w) => {
              const Icon = category === "image" ? ImageIcon : Drama;
              return (
                <button
                  key={w.id}
                  disabled={!ready}
                  onClick={() => onPick(w)}
                  title={w.description}
                  className="group flex w-72 shrink-0 snap-start flex-col rounded-xl border border-line bg-panel p-4 text-left hover:border-[#4a4a52] disabled:opacity-50"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-panel-2">
                      <Icon size={14} className="text-accent" />
                    </div>
                    <span className="min-w-0 truncate text-[13px] font-medium">{w.title}</span>
                  </div>
                  <p className="mt-2 line-clamp-5 text-[12px] leading-relaxed text-muted">{w.description}</p>
                  <span className="mt-auto flex items-center justify-between pt-3 text-[11px]">
                    <span className="rounded bg-panel-2 px-1.5 py-0.5 text-muted">{label}</span>
                    <span className="flex items-center gap-1 text-fg opacity-70 group-hover:opacity-100">
                      Use <ArrowRight size={12} />
                    </span>
                  </span>
                </button>
              );
            }),
          )}
        </div>
      ) : (
        WORKFLOW_GROUPS.map(([category, label]) => {
        const Icon = category === "image" ? ImageIcon : Drama;
        return (
          <section key={category} className={compact ? "mt-4" : "mt-6"}>
            <h3 className="mb-3 text-[11px] font-medium tracking-wide text-muted uppercase">{label}</h3>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-5">
              {WORKFLOWS.filter((w) => w.category === category).map((w) => (
                <button
                  key={w.id}
                  disabled={!ready}
                  onClick={() => onPick(w)}
                  className="group flex flex-col rounded-xl border border-line bg-panel p-5 text-left hover:border-[#4a4a52] disabled:opacity-50"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="grid h-8 w-8 place-items-center rounded-lg bg-panel-2">
                      <Icon size={16} className="text-accent" />
                    </div>
                    <span className="text-[14px] font-medium">{w.title}</span>
                  </div>
                  <p className="mt-3 text-[12px] leading-relaxed text-muted">{w.description}</p>
                  {!compact && (
                    <ol className="mt-3 space-y-1 text-[12px] text-muted">
                      {w.steps.map((step, i) => (
                        <li key={i} className="flex gap-2">
                          <span className="text-fg tabular-nums">{i + 1}.</span>
                          {step}
                        </li>
                      ))}
                    </ol>
                  )}
                  <span className="mt-4 flex items-center gap-1.5 self-end text-[12px] text-fg opacity-70 group-hover:opacity-100">
                    Use <ArrowRight size={13} />
                  </span>
                </button>
              ))}
            </div>
          </section>
        );
      })
      )}
    </>
  );
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000_000],
  ["month", 2_592_000_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

function edited(ms: number) {
  const diff = ms - Date.now();
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size) return `Edited ${rtf.format(Math.round(diff / size), unit)}`;
  }
  return "Edited just now";
}

function Thumbnail({ meta, className }: { meta: ProjectMeta; className: string }) {
  return meta.thumbnail ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={convertFileSrc(meta.thumbnail)} alt="" className={`${className} object-cover`} draggable={false} />
  ) : (
    <div className={`${className} grid place-items-center bg-panel`}>
      <Workflow size={28} strokeWidth={1.3} className="text-muted" />
    </div>
  );
}

interface MenuState {
  meta: ProjectMeta;
  x: number;
  y: number;
}

function FileMenu({
  menu,
  tab,
  onClose,
  onAction,
}: {
  menu: MenuState;
  tab: Tab;
  onClose: () => void;
  onAction: (action: "open" | "rename" | "duplicate" | "trash" | "restore" | "delete", meta: ProjectMeta) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const t = setTimeout(() => window.addEventListener("pointerdown", onDown));
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const entries =
    tab === "files"
      ? ([
          ["open", "Open", FolderOpen],
          ["rename", "Rename", PencilLine],
          ["duplicate", "Duplicate", Copy],
          ["trash", "Move to trash", Trash2],
        ] as const)
      : ([
          ["restore", "Restore", ArchiveRestore],
          ["delete", "Delete permanently", Trash2],
        ] as const);

  return (
    <div
      ref={ref}
      className="fixed z-50 w-52 overflow-hidden rounded-xl border border-line bg-panel py-1 shadow-2xl shadow-black/60"
      style={{ left: Math.min(menu.x, window.innerWidth - 216), top: Math.min(menu.y, window.innerHeight - 180) }}
    >
      {entries.map(([action, label, Icon]) => (
        <button
          key={action}
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-panel-2 ${action === "trash" || action === "delete" ? "text-red-300" : ""}`}
          onClick={() => {
            onAction(action, menu.meta);
            onClose();
          }}
        >
          <Icon size={13} />
          {label}
        </button>
      ))}
    </div>
  );
}

function FileTitle({ meta, editing, onDone }: { meta: ProjectMeta; editing: boolean; onDone: (title: string | null) => void }) {
  const [value, setValue] = useState(meta.title);
  if (!editing) return <div className="truncate text-[13px]">{meta.title}</div>;
  return (
    <input
      autoFocus
      className="w-full rounded border border-accent bg-panel-2 px-1.5 py-0.5 text-[13px] outline-none"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => onDone(value.trim() || null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") onDone(null);
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

export default function Home() {
  const openProject = useFlow((s) => s.openProject);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [tab, setTab] = useState<Tab>("files");
  const [view, setView] = useState<View>("grid");
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => listProjects().then(setProjects).catch((e) => setError(String(e))), []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects.filter((p) => p.trashed === (tab === "trash") && (!q || p.title.toLowerCase().includes(q)));
  }, [projects, tab, query]);

  async function open(id: string) {
    try {
      openProject(await loadProject(id));
    } catch (e) {
      setError(String(e));
    }
  }

  async function create(workflow?: WorkflowDef) {
    const graph = workflow?.build() ?? { nodes: [], edges: [] };
    const project = { id: newProjectId(), title: workflow?.title ?? "Untitled", updatedAt: 0, thumbnail: null, trashed: false, ...graph };
    try {
      await saveProject(project);
      openProject(project);
    } catch (e) {
      setError(String(e));
    }
  }

  /** Metadata edits need the full project, since saving rewrites the file. */
  async function update(id: string, patch: Partial<ProjectMeta>) {
    await saveProject({ ...(await loadProject(id)), ...patch });
  }

  async function onAction(action: "open" | "rename" | "duplicate" | "trash" | "restore" | "delete", meta: ProjectMeta) {
    try {
      switch (action) {
        case "open":
          return open(meta.id);
        case "rename":
          return setRenaming(meta.id);
        case "duplicate": {
          const src = await loadProject(meta.id);
          await saveProject({ ...src, id: newProjectId(), title: `${src.title} (copy)` });
          break;
        }
        case "trash":
          await update(meta.id, { trashed: true });
          break;
        case "restore":
          await update(meta.id, { trashed: false });
          break;
        case "delete":
          await deleteProject(meta.id);
          break;
      }
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function finishRename(meta: ProjectMeta, title: string | null) {
    setRenaming(null);
    if (!title || title === meta.title) return;
    try {
      await update(meta.id, { title });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  function openMenu(e: ReactMouseEvent, meta: ProjectMeta) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ meta, x: e.clientX, y: e.clientY });
  }

  const navItem = (id: Tab, label: string, Icon: typeof FolderOpen) => (
    <button
      onClick={() => setTab(id)}
      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] ${tab === id ? "bg-panel-2 text-fg" : "text-muted hover:text-fg"}`}
    >
      <Icon size={15} strokeWidth={1.7} />
      {label}
    </button>
  );

  return (
    <div className="flex h-screen bg-bg">
      <aside className="flex w-[232px] shrink-0 flex-col border-r border-line bg-panel p-3">
        <div className="flex items-center gap-2.5 px-1 py-1.5">
          <div className="grid h-7 w-7 place-items-center rounded-md bg-accent text-xs font-bold">S</div>
          <span className="text-[14px] font-medium">SimpleNode</span>
        </div>
        <button
          className="mt-4 flex items-center justify-center gap-2 rounded-lg bg-fg py-2 text-[13px] font-medium text-bg hover:opacity-90"
          onClick={() => create()}
        >
          <Plus size={15} /> New file
        </button>
        <nav className="mt-4 space-y-0.5">
          {navItem("files", "My files", FolderOpen)}
          {navItem("workflows", "Workflows", LayoutTemplate)}
          {navItem("trash", "Trash", Trash2)}
        </nav>
        <div className="mt-auto">{navItem("settings", "Settings", SettingsIcon)}</div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1180px] px-10 py-8">
          <header className="flex items-center justify-between">
            <h1 className="text-[17px] font-medium">{TITLES[tab]}</h1>
            {tab === "files" && (
              <button className="flex items-center gap-2 rounded-lg bg-fg px-3.5 py-2 text-[13px] font-medium text-bg hover:opacity-90" onClick={() => create()}>
                <Plus size={15} /> New file
              </button>
            )}
          </header>

          {tab === "settings" ? (
            <Settings />
          ) : tab === "workflows" ? (
            <Workflows onPick={(w) => create(w)} />
          ) : (
            <>
              {tab === "files" && !query && <Workflows compact onPick={(w) => create(w)} onMore={() => setTab("workflows")} />}
              <div className="mt-8 flex items-center gap-3">
                <h2 className="mr-auto text-[15px] font-medium">{tab === "files" ? "My files" : "Deleted files"}</h2>
                <div className="flex w-64 items-center gap-2 rounded-lg bg-panel px-3 py-1.5 focus-within:ring-1 focus-within:ring-accent">
                  <Search size={14} className="text-muted" />
                  <input
                    className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted"
                    placeholder="Search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <div className="flex rounded-lg bg-panel p-0.5">
                  {(
                    [
                      ["list", List],
                      ["grid", LayoutGrid],
                    ] as const
                  ).map(([v, Icon]) => (
                    <button key={v} onClick={() => setView(v)} className={`grid h-7 w-7 place-items-center rounded-md ${view === v ? "bg-panel-2 text-fg" : "text-muted"}`}>
                      <Icon size={14} />
                    </button>
                  ))}
                </div>
              </div>

              {error && (
                <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-500/40 px-3 py-2 text-xs text-red-200">
                  <span className="flex-1">{error}</span>
                  <button onClick={() => setError(null)}>✕</button>
                </div>
              )}

              {!visible.length ? (
                <div className="mt-16 text-center text-[13px] text-muted">
                  {query ? "No matching file." : tab === "files" ? "No files yet. Create one with \"New file\"." : "The trash is empty."}
                </div>
              ) : view === "grid" ? (
                <div className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-5">
                  {visible.map((meta) => (
                    <div
                      key={meta.id}
                      className="group cursor-pointer"
                      onClick={() => tab === "files" && renaming !== meta.id && open(meta.id)}
                      onContextMenu={(e) => openMenu(e, meta)}
                    >
                      <div className="relative overflow-hidden rounded-xl border border-line group-hover:border-[#4a4a52]">
                        <Thumbnail meta={meta} className="aspect-square w-full" />
                        <button
                          className="absolute top-2 right-2 grid h-7 w-7 place-items-center rounded-md bg-black/60 opacity-0 group-hover:opacity-100"
                          onClick={(e) => openMenu(e, meta)}
                          title="Options"
                        >
                          <MoreHorizontal size={15} />
                        </button>
                      </div>
                      <div className="mt-2.5 px-1">
                        <FileTitle meta={meta} editing={renaming === meta.id} onDone={(t) => finishRename(meta, t)} />
                        <div className="mt-0.5 text-[11px] text-muted">{edited(meta.updatedAt)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-5 divide-y divide-line rounded-xl border border-line">
                  {visible.map((meta) => (
                    <div
                      key={meta.id}
                      className="group flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-panel"
                      onClick={() => tab === "files" && renaming !== meta.id && open(meta.id)}
                      onContextMenu={(e) => openMenu(e, meta)}
                    >
                      <Thumbnail meta={meta} className="h-10 w-10 shrink-0 rounded-md" />
                      <div className="min-w-0 flex-1">
                        <FileTitle meta={meta} editing={renaming === meta.id} onDone={(t) => finishRename(meta, t)} />
                      </div>
                      <div className="text-[11px] text-muted">{edited(meta.updatedAt)}</div>
                      <button className="grid h-7 w-7 place-items-center rounded-md text-muted opacity-0 group-hover:opacity-100" onClick={(e) => openMenu(e, meta)}>
                        <MoreHorizontal size={15} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </main>

      {menu && <FileMenu menu={menu} tab={tab} onClose={() => setMenu(null)} onAction={onAction} />}
    </div>
  );
}
