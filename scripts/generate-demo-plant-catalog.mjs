/**
 * One-off: reads server.js store.plantCatalog + PLANT_EXTRAS, writes public/demo-plant-catalog.json
 * Run: node scripts/generate-demo-plant-catalog.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const serverPath = path.join(root, "server.js");
const s = fs.readFileSync(serverPath, "utf8");

const catStart = s.indexOf("plantCatalog: [");
if (catStart < 0) throw new Error("plantCatalog not found");
const sub = s.slice(catStart);
const open = sub.indexOf("[");
let depth = 0;
let end = -1;
for (let i = open; i < sub.length; i++) {
  const c = sub[i];
  if (c === "[") depth++;
  if (c === "]") {
    depth--;
    if (depth === 0) {
      end = i;
      break;
    }
  }
}
if (end < 0) throw new Error("could not find catalog array end");

const catalog = Function(`"use strict"; return (${sub.slice(open, end + 1)})`)();

const extrasStart = s.indexOf("const PLANT_EXTRAS = {");
if (extrasStart < 0) throw new Error("PLANT_EXTRAS not found");
const subE = s.slice(extrasStart);
const o = subE.indexOf("{");
let d = 0;
let endE = -1;
for (let i = o; i < subE.length; i++) {
  const c = subE[i];
  if (c === "{") d++;
  if (c === "}") {
    d--;
    if (d === 0) {
      endE = i;
      break;
    }
  }
}
const extras = Function(`"use strict"; return (${subE.slice(o, endE + 1)})`)();

const merged = catalog.map((p) => {
  const ex = extras[p.id] || {};
  return {
    ...p,
    facts: ex.facts || [],
    benefits: ex.benefits || [],
    tips: ex.tips || [],
    ratings: ex.ratings || { ease: 4, benefits: 4, cost: 4, popularity: 4 },
  };
});

const out = path.join(root, "public", "demo-plant-catalog.json");
fs.writeFileSync(out, JSON.stringify(merged, null, 2), "utf8");
console.log("Wrote", out, "plants:", merged.length);
