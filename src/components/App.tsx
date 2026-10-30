"use client";

import { useEffect } from "react";
import { useFlow } from "@/lib/store";
import { useModels } from "@/lib/spec";
import Editor from "./Editor";
import Home from "./Home";

/** Home page until a project is opened, then the canvas. */
export default function App() {
  const projectId = useFlow((s) => s.projectId);
  const loadModels = useModels((s) => s.load);

  // Load the model registry once; new model nodes read their defaults from it.
  useEffect(() => {
    loadModels();
  }, [loadModels]);

  return projectId ? <Editor key={projectId} /> : <Home />;
}
