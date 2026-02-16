import { createDefaultGuidanceEngine } from "file:///C:/ProjectPlant/ProjectPlant/packages/care-engine/dist/engine/guidance-engine.js";
import { readFile } from "node:fs/promises";
const data = JSON.parse(await readFile("sample-care.json", "utf8"));
const engine = createDefaultGuidanceEngine();
const blocks = engine.render(data.profile);
console.log(JSON.stringify(blocks, null, 2));
