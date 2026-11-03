/**
 * Who runs the models fal and WaveSpeed both host: the only provider with a
 * key, else the user's choice (Settings). Read by the library, the inspector
 * and the MCP cost estimate.
 */
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { findModel } from "./spec";

/** Mirrors `account::KeyStatus` in src-tauri. */
export interface KeyStatus {
  main: "saved" | "env" | null;
  billing: boolean;
  byteplus: boolean;
  byteplusAk: boolean;
  byteplusSk: boolean;
  wavespeed: boolean;
  provider: "fal" | "wavespeed";
}

export const useKeys = create<{ status: KeyStatus | null; refresh: () => Promise<void> }>((set) => ({
  status: null,
  refresh: () =>
    invoke<KeyStatus>("key_status")
      .then((status) => set({ status }))
      .catch(() => {}),
}));

export const WAVESPEED_LINKS = {
  signup: "https://wavespeed.ai/sign-in",
  keys: "https://wavespeed.ai/accesskey",
  dashboard: "https://wavespeed.ai/dashboard",
};

/** This model runs on WaveSpeed: it is the provider and hosts the model. */
export function runsOnWaveSpeed(status: KeyStatus | null, modelId: string | undefined) {
  return status?.provider === "wavespeed" && !!findModel(modelId)?.wavespeed;
}

/** With WaveSpeed as the provider nothing goes to fal: models it doesn't host can't run. */
export function falOnly(status: KeyStatus | null, modelId: string | undefined) {
  return status?.provider === "wavespeed" && !findModel(modelId)?.wavespeed;
}

/** Node kinds that need fal for something WaveSpeed doesn't offer. */
export const FAL_ONLY_KINDS = new Set(["enhancer", "describer", "videoDescriber", "angles"]);

/** Who a node's subtitle names as running it. */
export function runnerLabel(status: KeyStatus | null, modelId: string | undefined) {
  if (status?.provider !== "wavespeed") return null;
  return findModel(modelId)?.wavespeed ? "WaveSpeed" : "fal only";
}
