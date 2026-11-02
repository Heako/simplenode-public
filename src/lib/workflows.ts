import type { Edge } from "@xyflow/react";
import { nanoid } from "nanoid";
import { PORT_COLORS, defaultParams, recastParams, recastPrompt, type NodeData, type NodeKind, type PortType } from "./spec";
import type { FlowNode } from "./store";

/** A ready-made graph a new file starts from, offered on the home page. */
export interface Workflow {
  id: string;
  /** What it makes: workflows are grouped by it on the home page. */
  category: "image" | "video";
  title: string;
  description: string;
  /** What the user still has to provide, in order. */
  steps: string[];
  build: () => { nodes: FlowNode[]; edges: Edge[] };
}

function node(kind: NodeKind, x: number, y: number, init: Partial<NodeData> = {}, modelId?: string): FlowNode {
  return {
    id: nanoid(8),
    type: kind,
    position: { x, y },
    data: { kind, params: defaultParams(kind, modelId), outputs: {}, status: "idle", ...init },
  };
}

/**
 * Image models the workflows start with; any other can be picked on the node.
 * Seedream creates characters best; Nano Banana Pro keeps a subject faithful
 * across edits and variations.
 */
const CREATE_MODEL = "seedream-5-lite";
const VARIATION_MODEL = "nano-banana-pro";

/** A model node with `refs` numbered image inputs and its registry defaults. */
function imageModel(x: number, y: number, refs = 0, modelId = VARIATION_MODEL): FlowNode {
  const model = node("model", x, y, {}, modelId);
  if (refs > 0) model.data.params = { ...model.data.params, refs: String(refs) };
  return model;
}

function prompt(x: number, y: number, text = ""): FlowNode {
  return node("prompt", x, y, { params: { ...defaultParams("prompt"), text } });
}

function imageImport(x: number, y: number, title: string): FlowNode {
  return node("image", x, y, { title, params: { path: "", media: "image" } });
}

function link(source: FlowNode, sourceHandle: string, target: FlowNode, targetHandle: string, type: PortType): Edge {
  return { id: nanoid(8), source: source.id, sourceHandle, target: target.id, targetHandle, style: { stroke: PORT_COLORS[type], strokeWidth: 2 } };
}

/** Source video and character imports wired into a Recast node in `mode`, shown in a Preview. */
function recastGraph(mode: string) {
  const video = node("image", 0, 0, { title: "Source video", params: { path: "", media: "video" } });
  const character = node("image", 0, 330, { title: "Character", params: { path: "", media: "image" } });
  const recast = node("recast", 400, 60, { params: { ...recastParams(mode), prompt: recastPrompt(mode), segment: "10" } });
  const preview = node("preview", 820, 60);
  return {
    nodes: [video, character, recast, preview],
    edges: [
      link(video, "video", recast, "video", "video"),
      link(character, "image", recast, "characters", "image"),
      link(recast, "video", preview, "value", "video"),
    ],
  };
}

function generateGraph() {
  const text = prompt(0, 0);
  const model = imageModel(420, 0, 0, CREATE_MODEL);
  return { nodes: [text, model], edges: [link(text, "text", model, "prompt", "text")] };
}

function editGraph() {
  const source = imageImport(0, 0, "Image to edit");
  const text = prompt(0, 330);
  const model = imageModel(420, 60, 1);
  return {
    nodes: [source, text, model],
    edges: [link(source, "image", model, "ref1", "image"), link(text, "text", model, "prompt", "text")],
  };
}

function combineGraph() {
  const character = imageImport(0, 0, "Character");
  const setting = imageImport(0, 330, "Setting");
  const text = prompt(0, 660, "The character from Image 1 in the setting from Image 2. Keep the character's face, hair and outfit exactly as they are.");
  const model = imageModel(420, 220, 2);
  return {
    nodes: [character, setting, text, model],
    edges: [
      link(character, "image", model, "ref1", "image"),
      link(setting, "image", model, "ref2", "image"),
      link(text, "text", model, "prompt", "text"),
    ],
  };
}

/** The character of Image 1 takes the place of the person in the scene of Image 2, in the same pose. */
function swapGraph() {
  const character = imageImport(0, 0, "Character");
  const scene = imageImport(0, 330, "Scene with the pose");
  const text = prompt(
    0,
    660,
    "Create a new photo of the person from Image 1. " +
      "Their identity comes only from Image 1: the same face, facial features, skin tone, hairstyle, hair length and hair color. " +
      "Use Image 2 only as a reference for the pose, body position, hands and gesture, the outfit and accessories, the framing, the camera angle, the background and the lighting. " +
      "Do not keep the face or the hair of the person in Image 2: the person in the new photo must be clearly recognizable as the person from Image 1.",
  );
  const model = imageModel(420, 220, 2);
  return {
    nodes: [character, scene, text, model],
    edges: [
      link(character, "image", model, "ref1", "image"),
      link(scene, "image", model, "ref2", "image"),
      link(text, "text", model, "prompt", "text"),
    ],
  };
}

function anglesGraph() {
  const source = imageImport(0, 0, "Reference image");
  const angles = node("angles", 400, 0);
  const pick = node("anglePick", 860, 0);
  return {
    nodes: [source, angles, pick],
    edges: [link(source, "image", angles, "image", "image"), link(angles, "views", pick, "views", "views")],
  };
}

export const WORKFLOWS: Workflow[] = [
  {
    id: "image-generate",
    category: "image",
    title: "Create a character",
    description: "Describe a character or any image and generate it, with Seedream, the best at creating characters. Then use the variation workflows below to put it in other shots.",
    steps: ["Describe the character in the prompt", "Pick the size on the model node", "Run the model node"],
    build: generateGraph,
  },
  {
    id: "image-edit",
    category: "image",
    title: "Edit an image",
    description: "Change an existing image with a sentence: a color, a background, an object, a style. The rest of the image is kept. With Nano Banana Pro, the best at staying faithful to the subject.",
    steps: ["Import the image to edit", "Describe the change in the prompt", "Run the model node"],
    build: editGraph,
  },
  {
    id: "image-combine",
    category: "image",
    title: "Combine two images",
    description: "Puts the character of one image into the setting of another. The prompt calls them Image 1 and Image 2.",
    steps: ["Import the character's image", "Import the setting's image", "Adjust the prompt if needed, then run the model node"],
    build: combineGraph,
  },
  {
    id: "image-swap",
    category: "image",
    title: "Put a character in a scene",
    description:
      "Your character takes the place of the person in a reference photo: same pose, outfit, framing, background and light. Edit the prompt to keep your character's outfit instead.",
    steps: ["Import your character's image", "Import the scene with the pose to copy", "Run the model node"],
    build: swapGraph,
  },
  {
    id: "image-angles",
    category: "image",
    title: "Camera angles",
    description: "Generates several shots of the same subject from one image (close-up, wide, low angle…), then lets you pick one.",
    steps: ["Import the reference image", "Choose the layout and shots on the Camera angles node", "Run it, then pick a shot in the Angle picker"],
    build: anglesGraph,
  },
  {
    id: "recast-replace",
    category: "video",
    title: "Replace a character",
    description: "Your character takes the place of the person on screen. The video's scene, lighting, camera and sound are kept.",
    steps: ["Import the source video", "Import your character's image", "Run the Recast node"],
    build: () => recastGraph("replace"),
  },
  {
    id: "recast-motion",
    category: "video",
    title: "Motion transfer",
    description: "Your character, in their own setting, performs the gestures and camera moves of the video.",
    steps: ["Import the reference video", "Import your character's image", "Run the Recast node"],
    build: () => recastGraph("motion"),
  },
];
