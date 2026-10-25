import { readFile } from "node:fs/promises";

const path = process.env.QUOTA_SOURCES ?? new URL("./sources.json", import.meta.url);
const configuration = JSON.parse(await readFile(path, "utf8"));

export const sources = configuration.sources.filter((source) => source.enabled !== false);
