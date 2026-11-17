import { mkdir, open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { toJsonValue } from "./crypto.js";

export async function writePrivate(file: string, body: string) {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readBounded(file: string, maxBytes: number): Promise<Buffer> {
  const info = await stat(file);
  if (!info.isFile() || info.size > maxBytes)
    throw new Error("Input file is not a bounded regular file");
  return readFile(file);
}

export function serializePg(value: unknown): unknown {
  return toJsonValue(value);
}
