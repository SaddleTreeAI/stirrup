import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { darkTokens } from "../src/index.ts";

const root = new URL("../../../", import.meta.url);
const path = (name: string) => fileURLToPath(new URL(name, root));
const source = path("packages/ui-tokens/assets/Stirrup.icon/Assets/stirrup.png");

// The centered Stirrup mark is shared across every platform export.
const portrait = await sharp(source).resize(1024, 1024).png().toBuffer();
async function framed(background: string) {
  return sharp({ create: { width: 1024, height: 1024, channels: 4, background } })
    .composite([{ input: portrait, top: 0, left: 0 }])
    .png()
    .toBuffer();
}
const mask = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" rx="200" fill="white"/></svg>',
);
async function roundedCorners(input: Buffer) {
  return sharp(input)
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
}
const square = await framed(darkTokens.background);
const rounded = await roundedCorners(square);

async function png(input: Buffer, name: string, size: number) {
  await sharp(input).resize(size, size).png().toFile(path(name));
}

// PNG frames in ICO are supported by modern Windows and browser favicon loaders.
async function ico(input: Buffer, name: string, sizes: number[]) {
  const frames = await Promise.all(sizes.map((size) => sharp(input).resize(size).png().toBuffer()));
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach((frame, index) => {
    const entry = 6 + index * 16;
    const size = sizes[index] ?? 0;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
  });
  await writeFile(path(name), Buffer.concat([header, ...frames]));
}

for (const app of ["web", "www"]) {
  const publicDir = `apps/${app}/public`;
  await png(rounded, `${publicDir}/favicon-16x16.png`, 16);
  await png(rounded, `${publicDir}/favicon-32x32.png`, 32);
  await png(rounded, `${publicDir}/favicon.png`, 128);
  await png(square, `${publicDir}/apple-touch-icon.png`, 180);
  await png(square, `${publicDir}/icon-192.png`, 192);
  await png(square, `${publicDir}/icon-512.png`, 512);
  await ico(rounded, `${publicDir}/favicon.ico`, [16, 32, 48]);
}
await mkdir(path("apps/www/public/brand"), { recursive: true });
await png(rounded, "apps/www/public/brand/stirrup-mark.png", 256);
await png(rounded, "apps/mobile/assets/favicon.png", 128);
await png(square, "apps/desktop/assets/icon.png", 1024);
await ico(rounded, "apps/desktop/assets/icon.ico", [16, 32, 48, 64, 128, 256]);

// The splash shows the character alone, with no plate, so it sits on either splash colour.
// Keep the existing transparent padding so its visual size stays stable.
await sharp(await roundedCorners(await framed("transparent")))
  .resize(620, 620)
  .extend({ top: 202, bottom: 202, left: 202, right: 202, background: "transparent" })
  .png()
  .toFile(path("apps/mobile/assets/splash-icon.png"));

// Native exports use the same source; Android applies its own launcher mask.
await png(square, "apps/mobile/assets/icon.png", 1024);
await png(portrait, "apps/mobile/assets/adaptive-icon.png", 1024);
const alpha = await sharp(portrait).extractChannel("alpha").toBuffer();
const monochrome = await sharp({
  create: { width: 1024, height: 1024, channels: 3, background: "white" },
})
  .joinChannel(alpha)
  .png()
  .toBuffer();
await png(monochrome, "apps/mobile/assets/monochrome-icon.png", 1024);
await png(monochrome, "apps/mobile/assets/notification-icon.png", 72);
await sharp({
  create: { width: 1024, height: 1024, channels: 4, background: darkTokens.background },
})
  .png()
  .toFile(path("apps/mobile/assets/icon-background.png"));
await sharp(rounded)
  .resize(824, 824)
  .extend({ top: 100, bottom: 100, left: 100, right: 100, background: "transparent" })
  .png()
  .toFile(path("apps/desktop/assets/icon-macos.png"));
const kit = "apps/www/public/brand/kit";
await png(square, `${kit}/stirrup-icon.png`, 1024);
await png(portrait, `${kit}/stirrup-mascot.png`, 700);
const wordmark = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="360" viewBox="0 0 1100 360"><text x="24" y="268" fill="#141414" font-family="Arial,Helvetica,sans-serif" font-size="280" font-weight="700" letter-spacing="-12">stirrup</text></svg>',
);
await writeFile(path(`${kit}/stirrup-wordmark.svg`), wordmark);
const lockup = await sharp({
  create: { width: 1712, height: 576, channels: 4, background: "white" },
})
  .composite([
    { input: await sharp(portrait).resize(480, 480).toBuffer(), top: 48, left: 24 },
    { input: await sharp(wordmark).png().toBuffer(), top: 108, left: 540 },
  ])
  .png()
  .toBuffer();
await sharp(lockup)
  .png()
  .toFile(path(`${kit}/stirrup-logo.png`));
for (const [name, input] of [
  ["logo", lockup],
  ["icon", square],
  ["mascot", portrait],
] as const) {
  await sharp(input)
    .resize({ width: 800, withoutEnlargement: true })
    .webp()
    .toFile(path(`${kit}/stirrup-${name}-preview.webp`));
}
