import { generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, writeFile, access, readdir, copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { configDirectory, quotaEndpoint } from "../config.mjs";

const directory = fileURLToPath(new URL(".", import.meta.url));
const sdk = process.env.CONNECTIQ_SDK ?? join(homedir(), ".local/share/garmin-connectiq/sdk");
const config = configDirectory;
const keyPath = join(config, "developer_key.der");
const credentials = JSON.parse(await readFile(join(config, "credentials.json"), "utf8"));
const endpoint = quotaEndpoint();
for (const filename of ["gpt.png", "cc.png"]) {
  try { await access(join(directory, "resources/icons", filename)); }
  catch { throw new Error(`请自行准备 watch/resources/icons/${filename}，详见 README`); }
}
await mkdir(join(directory, "private/resources"), { recursive: true, mode: 0o700 });
await mkdir(join(directory, "bin"), { recursive: true, mode: 0o700 });

try {
  await access(keyPath);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 4096,
    privateKeyEncoding: { type: "pkcs8", format: "der" },
    publicKeyEncoding: { type: "spki", format: "der" },
  });
  await writeFile(keyPath, privateKey, { mode: 0o600, flag: "wx" });
}

const builder = new XMLBuilder({ ignoreAttributes: false });
const resource = builder.build({ resources: { properties: { property: [
  { "@_id": "ReadToken", "@_type": "string", "#text": credentials.READ_TOKEN },
  { "@_id": "QuotaEndpoint", "@_type": "string", "#text": endpoint },
] } } });
await writeFile(join(directory, "private/resources/properties.xml"), resource, { mode: 0o600 });
const sourceFiles = (await readdir(join(directory, "source"))).filter((filename) => filename.endsWith(".mc"));
const sourceText = (await Promise.all(sourceFiles.map((filename) => readFile(join(directory, "source", filename), "utf8")))).join("\n");
const chinese = [...new Set(sourceText.match(/\p{Script=Han}/gu))].join("");
const ascii = Array.from({ length: 95 }, (_, index) => String.fromCodePoint(index + 32)).join("");
const channelNames = "GPTCCAGYDEVINOPENCODEZCODEWORKBUDDY";
const fonts = [
  { name: "small", size: 16, weight: "Regular", characters: ascii + chinese + "·…" },
  { name: "label", size: 18, weight: "Regular", characters: ascii + chinese + "·‹›…" },
  { name: "numbers", size: 28, weight: "Regular", characters: "0123456789%." },
  { name: "title", size: 24, weight: "Bold", characters: channelNames },
  { name: "glance-label", size: 20, weight: "Bold", characters: "GPTCC 周剩余额度0123456789$." },
  { name: "glance-small", size: 16, weight: "Regular", characters: "TiboAIHOT0123456789: ·…hdm更新公告预计重置卡后上次确认天前今天时间待定发放中演示窗口内" },
  { name: "glance-number", size: 46, weight: "Regular", characters: "0123456789%." },
];
for (const font of fonts) {
  const subset = join(directory, "private", `${font.name}.otf`);
  execFileSync("uv", ["tool", "run", "--from", "fonttools", "pyftsubset",
    `/usr/share/fonts/opentype/noto/NotoSansCJK-${font.weight}.ttc`,
    "--font-number=2", `--text=${font.characters}`, `--output-file=${subset}`,
  ], { stdio: "pipe" });
  const characters = [...new Set(font.characters)].map((character) => character.codePointAt(0)).join(",");
  // Connect IQ 按灰度读取字形，黑底保留每一笔的抗锯齿亮度。
  execFileSync(process.env.FONTBM ?? join(homedir(), ".local/bin/fontbm"), [
    "--font-file", subset, "--font-size", String(font.size), "--chars", characters, "--background-color", "0,0,0",
    "--output", join(directory, "resources/fonts", font.name), "--texture-size", "256x256",
    "--texture-crop-width", "--texture-crop-height", "--spacing-horiz", "1", "--spacing-vert", "1",
  ], { stdio: "pipe" });
}
const variants = [
  { name: "GPT", key: "codex", id: "b9a68e252d4a461d9f2ce6cb6ef8cd10", icon: "gpt.png" },
  { name: "CC", key: "claude", id: "a1c6278aab4d47b29cd4f162c2b4f113", icon: "cc.png" },
];
if (process.argv.includes("--preview-announcement")) {
  variants.splice(0, 2, { ...variants[0], name: "GPT-preview", id: "d62dbd423fbd46769aa3ac7f615d2e29", preview: true });
}
const template = new XMLParser({ ignoreAttributes: false }).parse(await readFile(join(directory, "manifest.xml"), "utf8"));
for (const variant of variants) {
  const target = join(directory, "private", variant.name);
  await mkdir(join(target, "source"), { recursive: true });
  await mkdir(join(target, "resources"), { recursive: true });
  template["iq:manifest"]["iq:application"]["@_id"] = variant.id;
  template["iq:manifest"]["iq:application"]["@_entry"] = variant.preview ? "QuotaPreviewApp" : "QuotaApp";
  await writeFile(join(target, "manifest.xml"), builder.build(template));
  await copyFile(join(directory, "resources/icons", variant.icon), join(target, "resources/icon.png"));
  await writeFile(join(target, "resources/variant.xml"), builder.build({ resources: {
    strings: { string: { "@_id": "AppName", "#text": variant.name } },
    bitmaps: { bitmap: { "@_id": "LauncherIcon", "@_filename": "icon.png", "@_scaleX": "56", "@_scaleY": "56" } },
  } }));
  await writeFile(join(target, "source/Variant.mc"), `(:glance) module QuotaVariant { const KEY = "${variant.key}"; const TITLE = "${variant.key === "codex" ? "GPT" : "CC"}"; }\n`);
  if (variant.preview) await copyFile(join(directory, "preview/Announcement.mc"), join(target, "source/Announcement.mc"));
  const jungle = [
    `project.manifest = ${join(target, "manifest.xml")}`,
    `base.sourcePath = ${join(directory, "source")};${join(target, "source")}`,
    `base.resourcePath = ${join(directory, "resources")};${join(directory, "private/resources")};${join(target, "resources")}`,
  ].join("\n");
  await writeFile(join(target, "build.jungle"), jungle);
  const packaged = process.argv.includes("--package");
  const output = variant.preview ? join(target, "GPT.prg") : join(directory, "bin", `${variant.name}.${packaged ? "iq" : "prg"}`);
  const args = ["-f", join(target, "build.jungle"), "-o", output, "-y", keyPath, "-w"];
  if (packaged) args.push("-e");
  else args.push("-d", "vivoactive5");
  execFileSync(join(sdk, "bin/monkeyc"), args, { cwd: directory, stdio: "inherit" });
}
