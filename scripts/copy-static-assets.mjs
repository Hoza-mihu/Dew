import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const copies = [
  {
    from: path.join(root, "public", "images"),
    to: path.join(root, "dist", "images"),
  },
  {
    from: path.join(root, "public", "about-scroll-frames"),
    to: path.join(root, "dist", "about-scroll-frames"),
  },
  {
    from: path.join(root, "public", "about-reference.mp4"),
    to: path.join(root, "dist", "about-reference.mp4"),
  },
];

for (const { from, to } of copies) {
  if (!existsSync(from)) continue;
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, force: true });
  console.log(`[copy-static-assets] Copied: ${from} -> ${to}`);
}
