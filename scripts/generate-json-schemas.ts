import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { brainJsonSchemasV1 } from "../packages/core/src/json-schemas.js";

const destination = resolve(import.meta.dirname, "../schemas/v1");
await mkdir(destination, { recursive: true });

for (const [name, schema] of Object.entries(brainJsonSchemasV1).sort()) {
  await writeFile(
    resolve(destination, `${name}.schema.json`),
    `${JSON.stringify(schema, null, 2)}\n`,
    "utf8",
  );
}
