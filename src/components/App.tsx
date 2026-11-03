"use client";

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useFlow } from "@/lib/store";
import { useModels } from "@/lib/spec";
import { listenToMcp } from "@/lib/mcp";
import { useKeys } from "@/lib/provider";
import Editor from "./Editor";
import Home from "./Home";
import Welcome from "./Welcome";

/** First-launch guide while no fal key is saved, then home page, then the canvas. */
export default function App() {
  const projectId = useFlow((s) => s.projectId);
  const loadModels = useModels((s) => s.load);
  // null until known; the guide shows again next launch if skipped.
  const [welcome, setWelcome] = useState<boolean | null>(null);

  // Load the model registry once; new model nodes read their defaults from it.
  useEffect(() => {
    loadModels();
    useKeys.getState().refresh();
    // Either provider's key is enough to start.
    invoke<{ main: string | null; wavespeed: boolean }>("key_status")
      .then((s) => setWelcome(!s.main && !s.wavespeed))
      .catch(() => setWelcome(false));
  }, [loadModels]);

  // Tool calls from Claude Code, when the MCP server is on (Settings → MCP).
  useEffect(() => {
    const unlisten = listenToMcp();
    return () => void unlisten.then((stop) => stop());
  }, []);

  if (welcome === null) return null;
  if (welcome)
    return (
      <Welcome
        onDone={() => {
          useKeys.getState().refresh();
          setWelcome(false);
        }}
      />
    );
  return projectId ? <Editor key={projectId} /> : <Home />;
}
