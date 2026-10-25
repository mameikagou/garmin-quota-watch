import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { configDirectory } from "./config.mjs";

const directory = configDirectory;
const path = join(directory, "credentials.json");
await mkdir(directory, { recursive: true, mode: 0o700 });
let credentials;
try {
  credentials = JSON.parse(await readFile(path, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  credentials = {
    WRITE_TOKEN: randomBytes(32).toString("base64url"),
    READ_TOKEN: randomBytes(32).toString("base64url"),
  };
  await writeFile(path, JSON.stringify(credentials), { mode: 0o600, flag: "wx" });
}
if (!credentials.WRITE_TOKEN || !credentials.READ_TOKEN) throw new Error("缺少接口凭据");

if (process.argv.includes("--secrets")) {
  const child = spawn("./node_modules/.bin/wrangler", ["secret", "bulk"], { stdio: ["pipe", "inherit", "inherit"] });
  child.stdin.end(JSON.stringify(credentials));
  child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
} else {
  const vars = Object.entries(credentials).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n");
  await writeFile(new URL(".dev.vars", import.meta.url), `${vars}\n`, { mode: 0o600 });
  console.log("读写凭据已保存，文件权限 0600");
}
