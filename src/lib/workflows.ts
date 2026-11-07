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

/**
 * A video's action generated again with your character, without sending the
 * video: a vision LLM writes it as a timed prompt (Video → Prompt), a frame of
 * the video with your character put in it gives the setting and the start, and
 * Seedance 2.5 renders it from that image and the character's front, profile
 * and full-body images. Real
 * faces in a reference video make Seedance keep them; here it never sees one.
 */
function promptMotionGraph() {
  const video = node("image", 0, 0, { title: "Source video", params: { path: "", media: "video" } });
  const frame = node("frame", 400, 0);
  const face = imageImport(0, 420, "Character · face (front)");
  const profile = imageImport(0, 750, "Character · face (profile)");
  const body = imageImport(0, 1080, "Character · full body, with the outfit");
  const text = prompt(0, 1410, SCENE_PROMPT);
  // Vertical like most source videos: "auto" can come back square. Change it for a landscape video.
  const firstFrame = imageModel(800, 0, 4);
  firstFrame.data.title = "First frame";
  firstFrame.data.params = { ...firstFrame.data.params, aspect_ratio: "9:16", resolution: "2K" };
  const describe = node("motionPrompt", 800, 520);
  const seedance = imageModel(1240, 200, 4, "seedance-2.5-motion");
  const preview = node("preview", 1680, 200);
  const upscale = node("upscale", 1680, 640);
  return {
    nodes: [video, frame, face, profile, body, text, firstFrame, describe, seedance, preview, upscale],
    edges: [
      link(video, "video", frame, "video", "video"),
      link(frame, "image", firstFrame, "ref1", "image"),
      link(face, "image", firstFrame, "ref2", "image"),
      link(profile, "image", firstFrame, "ref3", "image"),
      link(body, "image", firstFrame, "ref4", "image"),
      link(text, "text", firstFrame, "prompt", "text"),
      link(video, "video", describe, "video", "video"),
      link(describe, "text", seedance, "prompt", "text"),
      link(firstFrame, "image", seedance, "ref1", "image"),
      link(face, "image", seedance, "ref2", "image"),
      link(profile, "image", seedance, "ref3", "image"),
      link(body, "image", seedance, "ref4", "image"),
      link(seedance, "video", preview, "value", "video"),
      link(seedance, "video", upscale, "video", "video"),
    ],
  };
}

/**
 * A character speaking lines in one fixed voice: a List of lines (one picked
 * at a time), ElevenLabs v3 in a named voice, then Kling AI Avatar lip-syncs
 * the character image to it.
 */
function speakGraph() {
  const character = imageImport(0, 0, "Character (face visible)");
  const lines = node("list", 0, 360, {
    title: "Lines",
    params: { items: JSON.stringify(["Every morning is a gentle new beginning.", "I breathe in calm. I breathe out tension."]), selected: "0" },
  });
  const voice = node("voice", 420, 360);
  const avatar = node("avatar", 840, 0);
  const preview = node("preview", 1260, 0);
  return {
    nodes: [character, lines, voice, avatar, preview],
    edges: [
      link(lines, "text", voice, "text", "text"),
      link(character, "image", avatar, "image", "image"),
      link(voice, "audio", avatar, "audio", "audio"),
      link(avatar, "video", preview, "value", "video"),
    ],
  };
}

const SCENE_PROMPT =
  "Edit Image 1. " +
  "Replace the person in Image 1 with the person shown in Image 2, Image 3 and Image 4. " +
  "Face, facial features, skin tone, hairstyle, hair length and hair color: from Image 2 (front) and Image 3 (profile). " +
  "Body shape, clothes and shoes: from Image 4 (full body). " +
  "Change the clothes completely: remove every garment, accessory and shoe worn in Image 1 and dress the person exactly as in Image 4 (same garments, colors and fabric; bare feet if Image 4 shows bare feet). " +
  "Nothing of the original outfit may remain. " +
  "Keep from Image 1 only the pose, the body position, the hands, the setting, the framing, the camera angle and the lighting. " +
  "The result must look like the same photo as Image 1, with the person from Images 2 to 4 in it, wearing the outfit of Image 4.";

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
    id: "prompt-motion",
    category: "video",
    title: "Recreate a video with your character (Seedance 2.5)",
    description:
      "An LLM writes the video's action, camera and setting as a timed prompt; Seedance 2.5 generates it again with your character, in the video's setting. The video itself is never sent, so real faces in it don't block anything.",
    steps: [
      "Import the source video and three images of your character: face from the front, face in profile, full body with the outfit",
      "On Extract frame, pick the first frame, then run First frame and check the likeness",
      "Run Video → Prompt and read the prompt (add notes to change something)",
      "Set the duration of the video on the Seedance node, then run it (480p is enough)",
      "Once you like it, run Upscale / Export in 1080p, 2K or 4K and download it",
    ],
    build: promptMotionGraph,
  },
  {
    id: "speak",
    category: "video",
    title: "Make your character speak",
    description:
      "Your character says your lines, always in the same voice: ElevenLabs v3 speaks each line in the voice you pick, and Kling AI Avatar animates your character's image with the lips in sync.",
    steps: [
      "Import an image of your character with the face clearly visible",
      "Write the lines in the List node; the selected one is spoken",
      "Pick a voice on the Voice node and keep it for every line, then run it",
      "Run Talking avatar; select the next line and run Voice and Talking avatar again",
    ],
    build: speakGraph,
  },
  {
    id: "recast-replace",
    category: "video",
    title: "Replace a character",
    description:
      "Your character takes the place of the person on screen; the video's scene, lighting, camera and sound are kept. Best on simple shots (talking, walking); fast or acrobatic moves, upside down especially, break the body.",
    steps: ["Import the source video", "Import your character's image", "Run the Recast node"],
    build: () => recastGraph("replace"),
  },
  {
    id: "recast-motion",
    category: "video",
    title: "Animate your character with a video's motion",
    description:
      "Your character, in their own setting, performs the gestures and camera moves of the video. Long videos are cut into segments that can drift, and hands don't always stay on objects: for the video's own setting, use Recreate a video instead.",
    steps: ["Import the reference video", "Import your character's image", "Run the Recast node"],
    build: () => recastGraph("motion"),
  },
];
