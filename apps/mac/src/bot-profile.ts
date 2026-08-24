import type { BotAvatarSpec } from "./contracts";

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const AVATAR_SIZE = 256;
const MAX_PNG_BYTES = 262_144;

function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("That image could not be opened."));
    image.src = dataUrl;
  });
}

function readFile(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error("That image could not be read."));
    reader.onerror = () => reject(new Error("That image could not be read."));
    reader.readAsDataURL(file);
  });
}

function decodedDataUrlBytes(dataUrl: string) {
  const payload = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor(payload.length * 3 / 4) - padding;
}

export function normalizeBotName(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
}

export async function avatarFromFile(file: File): Promise<BotAvatarSpec> {
  if (!file.type.startsWith("image/")) throw new Error("Choose a PNG, JPEG, or WebP image.");
  if (file.size <= 0 || file.size > MAX_SOURCE_BYTES) throw new Error("Choose an image smaller than 8 MB.");
  const image = await loadImage(await readFile(file));
  if (!image.naturalWidth || !image.naturalHeight) throw new Error("That image has no visible pixels.");

  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("Codelit could not prepare that image.");
  const crop = Math.min(image.naturalWidth, image.naturalHeight);
  const sourceX = (image.naturalWidth - crop) / 2;
  const sourceY = (image.naturalHeight - crop) / 2;
  context.clearRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
  context.drawImage(image, sourceX, sourceY, crop, crop, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  const dataUrl = canvas.toDataURL("image/png");
  if (!dataUrl.startsWith("data:image/png;base64,") || decodedDataUrlBytes(dataUrl) > MAX_PNG_BYTES) {
    throw new Error("That image is too detailed. Try a simpler or smaller image.");
  }
  return { kind: "image", dataUrl };
}
