"use client";

import { Extension, Node, mergeAttributes, type JSONContent } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import History from "@tiptap/extension-history";
import Paragraph from "@tiptap/extension-paragraph";
import Placeholder from "@tiptap/extension-placeholder";
import Text from "@tiptap/extension-text";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { Plus } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { varLabel } from "@/lib/spec";

/**
 * Prompt text editor (Tiptap / ProseMirror) where `{varN}` tokens are atomic
 * inline chips: line breaks, Tab, clicks or WebKit's editing quirks can't turn
 * them back into text. The template string stays the source of truth.
 */

export type VarDisplay = "both" | "source" | "value";

export interface TemplateEditorHandle {
  /** Inserts a variable chip at the caret (or at the end). */
  insertVar: (name: string) => void;
}

interface Props {
  value: string;
  vars: string[];
  /** Wired value per variable; null when wired but not produced yet, absent when unwired. */
  values: Record<string, string | null | undefined>;
  display: VarDisplay;
  placeholder: string;
  onChange: (template: string) => void;
  /** Declares a new variable (and its port) and returns its name; used by "@". */
  onCreateVar: () => string;
}

const TOKEN = /\{([A-Za-z0-9_]+)\}/g;

function valueText(value: string | null | undefined) {
  return value === undefined ? "non reliée" : value === null ? "en attente" : value.trim() || "vide";
}

function chipText(name: string, value: string | null | undefined, display: VarDisplay) {
  if (display === "source") return varLabel(name);
  if (display === "value") return valueText(value);
  return `${varLabel(name)}: ${valueText(value)}`;
}

const CHIP_STYLE =
  "margin:0 1px;padding:1px 4px;border-radius:4px;background:rgba(232,176,74,0.2);color:#f3c977;white-space:nowrap;cursor:default";

// ---------------------------------------------------------------------------
// Template <-> document

/** "a {var1}\nb" -> paragraphs of text and variable nodes (declared vars only). */
function toDoc(template: string, vars: string[]): JSONContent {
  return {
    type: "doc",
    content: template.split("\n").map((line) => {
      const content: JSONContent[] = [];
      let last = 0;
      for (const m of line.matchAll(TOKEN)) {
        if (!vars.includes(m[1])) continue;
        if (m.index! > last) content.push({ type: "text", text: line.slice(last, m.index) });
        content.push({ type: "variable", attrs: { name: m[1] } });
        last = m.index! + m[0].length;
      }
      if (last < line.length) content.push({ type: "text", text: line.slice(last) });
      return content.length ? { type: "paragraph", content } : { type: "paragraph" };
    }),
  };
}

function toTemplate(editor: Editor) {
  const lines: string[] = [];
  editor.state.doc.forEach((paragraph) => {
    let line = "";
    paragraph.forEach((node) => {
      if (node.isText) line += node.text;
      else if (node.type.name === "variable") line += `{${node.attrs.name}}`;
      else if (node.type.name === "hardBreak") line += "\n";
    });
    lines.push(line);
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extensions

/** Inline atom for a variable; its label is drawn by `label`, not stored. */
const Variable = Node.create<{ label: (name: string) => string }>({
  name: "variable",
  group: "inline",
  inline: true,
  atom: true,
  // A click puts the caret next to the chip instead of selecting it, so the
  // next keystroke doesn't replace it.
  selectable: false,
  draggable: false,
  addOptions: () => ({ label: (name: string) => name }),
  addAttributes: () => ({ name: { default: "" } }),
  parseHTML: () => [{ tag: "span[data-var]", getAttrs: (el) => ({ name: (el as HTMLElement).dataset.var }) }],
  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-var": node.attrs.name, style: CHIP_STYLE }), this.options.label(node.attrs.name)];
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("span");
      dom.dataset.var = node.attrs.name;
      dom.contentEditable = "false";
      dom.setAttribute("style", CHIP_STYLE);
      dom.textContent = this.options.label(node.attrs.name);
      // Clicking a chip puts the caret right after it, ready to type.
      dom.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const pos = typeof getPos === "function" ? getPos() : undefined;
        if (pos !== undefined) editor.chain().focus().setTextSelection(pos + node.nodeSize).run();
      });
      return { dom, ignoreMutation: () => true };
    };
  },
});

type MentionItem = { name: string } | { create: true };

interface MentionMenu {
  items: MentionItem[];
  rect: DOMRect | null;
  command: (item: MentionItem) => void;
}

/** "@" suggestions, wired to React state through `open` / `close`. */
function mentionExtension(handlers: {
  items: (query: string) => MentionItem[];
  open: (menu: MentionMenu) => void;
  close: () => void;
  keyDown: (props: SuggestionKeyDownProps) => boolean;
  choose: (item: MentionItem) => string;
}) {
  return Extension.create({
    name: "variableMention",
    addProseMirrorPlugins() {
      return [
        Suggestion<MentionItem>({
          editor: this.editor,
          char: "@",
          // Only after a space or at a line start: "a@b" stays plain text.
          allowedPrefixes: [" "],
          items: ({ query }) => handlers.items(query),
          command: ({ editor, range, props }) => {
            const name = handlers.choose(props);
            editor.chain().focus().insertContentAt(range, { type: "variable", attrs: { name } }).run();
          },
          render: () => {
            const show = (p: SuggestionProps<MentionItem>) =>
              handlers.open({ items: p.items, rect: p.clientRect?.() ?? null, command: (item) => p.command(item) });
            return { onStart: show, onUpdate: show, onKeyDown: handlers.keyDown, onExit: handlers.close };
          },
        }),
      ];
    },
  });
}

// ---------------------------------------------------------------------------

const TemplateEditor = forwardRef<TemplateEditorHandle, Props>(function TemplateEditor(
  { value, vars, values, display, placeholder, onChange, onCreateVar },
  ref,
) {
  // Extensions are built once; they read the latest props through this ref.
  const live = useRef({ vars, values, display, onChange, onCreateVar });
  live.current = { vars, values, display, onChange, onCreateVar };
  const emitted = useRef(value);
  const lastValue = useRef(value);
  // Last caret position, kept across blur: buttons outside the editor
  // ("Réinsérer", "Ajouter une variable") insert there.
  const lastPos = useRef<number | null>(null);

  const [menu, setMenu] = useState<MentionMenu | null>(null);
  const [active, setActiveState] = useState(0);
  // Read by key handlers that run outside React: a ref is current at once,
  // where state only catches up at the next render (fast ↓ then Enter).
  const activeRef = useRef(0);
  const menuRef = useRef<MentionMenu | null>(null);
  menuRef.current = menu;
  const setActive = (i: number) => {
    activeRef.current = i;
    setActiveState(i);
  };

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      Document,
      Paragraph,
      Text,
      HardBreak,
      History,
      Placeholder.configure({ placeholder }),
      Variable.configure({ label: (name) => chipText(name, live.current.values[name], live.current.display) }),
      mentionExtension({
        items: (query) => {
          const q = query.toLowerCase();
          const matches = live.current.vars.filter((n) => !q || varLabel(n).toLowerCase().includes(q) || n.includes(q));
          return [...matches.map((name) => ({ name })), { create: true as const }];
        },
        open: (m) => {
          if (!menuRef.current || menuRef.current.items.length !== m.items.length) setActive(0);
          menuRef.current = m;
          setMenu(m);
        },
        close: () => {
          menuRef.current = null;
          setMenu(null);
        },
        keyDown: ({ event }) => {
          const m = menuRef.current;
          const a = activeRef.current;
          if (!m?.items.length) return false;
          if (event.key === "ArrowDown") setActive((a + 1) % m.items.length);
          else if (event.key === "ArrowUp") setActive((a - 1 + m.items.length) % m.items.length);
          else if (event.key === "Enter" || event.key === "Tab") m.command(m.items[Math.min(a, m.items.length - 1)]);
          else if (event.key === "Escape") {
            menuRef.current = null;
            setMenu(null);
          }
          else return false;
          return true;
        },
        choose: (item) => ("create" in item ? live.current.onCreateVar() : item.name),
      }),
      // Tab never leaves the editor (the "@" menu handles it first when open).
      Extension.create({ name: "keepTab", addKeyboardShortcuts: () => ({ Tab: () => true, "Shift-Tab": () => true }) }),
    ],
    content: toDoc(value, vars),
    editorProps: {
      attributes: {
        // macOS rewrites text in place (autocorrect, auto-capitalization); keep prompts as typed.
        spellcheck: "false",
        autocorrect: "off",
        autocapitalize: "off",
        class:
          "nodrag nowheel nopan nokey h-32 w-full group-data-[resized]/card:min-h-16 group-data-[resized]/card:flex-1 overflow-y-auto rounded-lg border border-line bg-panel-2 px-2.5 py-2 text-xs leading-relaxed whitespace-pre-wrap text-fg outline-none select-text focus:border-accent",
      },
    },
    onSelectionUpdate: ({ editor: ed }) => {
      lastPos.current = ed.state.selection.from;
    },
    onUpdate: ({ editor: ed }) => {
      const next = toTemplate(ed);
      if (next === emitted.current) return;
      emitted.current = next;
      live.current.onChange(next);
    },
  });

  // Outside changes (canvas undo, project load) replace the content. React
  // Flow first re-renders with the previous value before the store catches
  // up: that value is unchanged since last time and must not reload the text
  // (which would throw the caret to the end). Never reload while typing.
  useEffect(() => {
    if (!editor || value === lastValue.current) return;
    lastValue.current = value;
    if (value === emitted.current || editor.isFocused) return;
    emitted.current = value;
    editor.commands.setContent(toDoc(value, vars), false);
  }, [editor, value, vars]);

  // Chip labels follow wired values and the display mode.
  useEffect(() => {
    editor?.view.dom.querySelectorAll<HTMLElement>("[data-var]").forEach((chip) => {
      const label = chipText(chip.dataset.var!, values[chip.dataset.var!], display);
      // Writing an unchanged label still makes WebKit repaint and flicker.
      if (chip.textContent !== label) chip.textContent = label;
    });
  });

  useImperativeHandle(ref, () => ({
    insertVar(name) {
      if (!editor) return;
      const at = Math.min(lastPos.current ?? editor.state.doc.content.size, editor.state.doc.content.size);
      editor.chain().focus().insertContentAt(at, { type: "variable", attrs: { name } }).run();
    },
  }));

  const rect = menu?.rect;
  return (
    <>
      <EditorContent editor={editor} className="flex min-h-0 flex-col group-data-[resized]/card:flex-1" />
      {menu &&
        rect &&
        createPortal(
          <div
            className="fixed z-50 w-60 overflow-hidden rounded-xl border border-line bg-panel py-1 shadow-2xl shadow-black/60"
            style={{
              left: Math.min(rect.left, window.innerWidth - 248),
              // Rows are ~28px plus the heading; flip above the "@" near the bottom.
              ...(rect.bottom + 44 + menu.items.length * 28 > window.innerHeight - 8
                ? { bottom: window.innerHeight - rect.top + 4 }
                : { top: rect.bottom + 4 }),
            }}
            // Keep focus (and the caret) in the editor while clicking an item.
            onMouseDown={(e) => e.preventDefault()}
          >
            <div className="px-2.5 pt-1 pb-1.5 text-[10px] text-muted">Insérer une variable</div>
            {menu.items.map((item, i) => (
              <button
                key={"create" in item ? "__create" : item.name}
                className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs ${i === active ? "bg-panel-2" : ""}`}
                // Move, not enter: the menu can open under a still pointer.
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => menu.command(item)}
              >
                {"create" in item ? (
                  <>
                    <Plus size={12} className="text-muted" /> Nouvelle variable
                  </>
                ) : (
                  <>
                    <span className="shrink-0 rounded bg-[#e8b04a]/20 px-1 text-[#f3c977]">{varLabel(item.name)}</span>
                    <span className="min-w-0 flex-1 truncate text-[10px] text-muted">{valueText(values[item.name])}</span>
                  </>
                )}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
});

export default TemplateEditor;
