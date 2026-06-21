import { parseArgs } from "node:util";

import {
  createIndex,
  loadLegacyIndex,
  writeIndex,
} from "./index-utils.js";

const { values } = parseArgs({
  options: {
    gen2: { type: "string" },
    gen3: { type: "string" },
    out: { type: "string", default: "./data/index.json" },
    "skip-invalid": { type: "boolean", default: false },
  },
  strict: true,
});

if (!values.gen2 || !values.gen3) {
  throw new Error(
    "Usage: npm run index:import -- --gen2 <file-or-url> --gen3 <file-or-url> [--out ./data/index.json]",
  );
}

const [gen2, gen3] = await Promise.all([
  loadLegacyIndex(values.gen2, { skipInvalid: values["skip-invalid"] }),
  loadLegacyIndex(values.gen3, { skipInvalid: values["skip-invalid"] }),
]);
const index = createIndex({ gen2, gen3 });

await writeIndex(values.out!, index);

console.log(
  `Wrote ${Object.keys(gen2).length} Gen2 and ${Object.keys(gen3).length} Gen3 tokens to ${values.out}.`,
);
