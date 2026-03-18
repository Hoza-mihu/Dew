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
];

for (const { from, to } of copies) {
  if (!existsSync(from)) continue;
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, force: true });
  console.log(`[copy-static-assets] Copied: ${from} -> ${to}`);
}
