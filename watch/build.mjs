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

const builder = new XMLBuilder({ ignoreAttributes: false, suppressBooleanAttributes: false });
const resource = builder.build({ resources: { properties: { property: [
  { "@_id": "ReadToken", "@_type": "string", "#text": credentials.READ_TOKEN },
  { "@_id": "QuotaEndpoint", "@_type": "string", "#text": endpoint },
] } } });
await writeFile(join(directory, "private/resources/properties.xml"), resource, { mode: 0o600 });
const channelNames = "GPTClaudeAGYDEVINOPENCODEZCODEWORKBUDDY";
const fonts = [
  { name: "small", id: "Small", size: 16, weight: 500, characters: "0123456789/:. ·…hdmTibo更新刷新中失败离线后今天明天重置前已" },
  { name: "label", id: "Label", size: 18, weight: 500, characters: channelNames + "LocalGlobalFlashAB5.30123456789/$%. 周日月积分余额活动起步返回总览‹›" },
  { name: "numbers", id: "Numbers", size: 28, weight: 300, characters: "0123456789%." },
  { name: "title", id: "Title", size: 24, weight: 500, characters: channelNames },
  { name: "glance-label", id: "GlanceLabel", size: 20, weight: 500, characters: "GPTClaude 余额0123456789$.", scope: "glance" },
  { name: "glance-small", id: "GlanceSmall", size: 16, weight: 500, characters: "Tibo0123456789:/. ·hdm更新后今天明天重置前已", scope: "glance" },
  { name: "glance-number", id: "GlanceNumber", size: 46, weight: 300, characters: "0123456789%.", scope: "glance" },
];

const fontBuildDirectory = join(directory, "private/font-build");
const fontResourceDirectory = join(directory, "private/font-resources");
const fontOutputDirectory = join(fontResourceDirectory, "fonts");
await mkdir(fontBuildDirectory, { recursive: true, mode: 0o700 });
await mkdir(fontOutputDirectory, { recursive: true, mode: 0o700 });

async function localSansFile() {
  const fontDirectory = process.env.CEDAR_FONT_DIR ?? join(homedir(), "mrlonely-code/cedar/frontend/src/assets/fonts");
  try {
    const filenames = await readdir(fontDirectory);
    const filename = filenames.find((candidate) => candidate.endsWith("Sans-Roman.woff2"));
    return filename == null ? null : join(fontDirectory, filename);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function fontTools(...arguments_) {
  execFileSync("uv", ["tool", "run", "--from", "fonttools", "--with", "brotli", ...arguments_], { stdio: "pipe" });
}

function uniqueCharacters(value) {
  return [...new Set(value)];
}

function separatedCharacters(value) {
  const result = { latin: "", cjk: "" };
  for (const character of uniqueCharacters(value)) {
    if (/\p{Script=Han}/u.test(character)) result.cjk += character;
    else result.latin += character;
  }
  return result;
}

function subsetFont(source, fontNumber, characters, output) {
  const arguments_ = ["pyftsubset", source];
  if (fontNumber != null) arguments_.push(`--font-number=${fontNumber}`);
  arguments_.push(`--text=${characters}`, `--output-file=${output}`);
  fontTools(...arguments_);
}

function bitmapFont(source, fontNumber, font, characters, outputName) {
  const subset = join(fontBuildDirectory, `${outputName}.otf`);
  subsetFont(source, fontNumber, characters, subset);
  const codePoints = uniqueCharacters(characters).map((character) => character.codePointAt(0)).join(",");
  // Connect IQ 按灰度读取字形，黑底保留每一笔的抗锯齿亮度。
  execFileSync(process.env.FONTBM ?? join(homedir(), ".local/bin/fontbm"), [
    "--font-file", subset, "--font-size", String(font.size), "--chars", codePoints, "--background-color", "0,0,0",
    "--output", join(fontOutputDirectory, outputName), "--texture-size", "256x256",
    "--texture-crop-width", "--texture-crop-height", "--spacing-horiz", "1", "--spacing-vert", "1",
  ], { stdio: "pipe" });
}

function fontResource(id, filename, scope) {
  const result = { "@_id": id, "@_filename": `fonts/${filename}.fnt`, "@_antialias": "true" };
  if (scope != null) result["@_scope"] = scope;
  return result;
}

const localSans = await localSansFile();
const latinSources = {};
for (const weight of [300, 500]) {
  if (localSans == null) {
    latinSources[weight] = { path: `/usr/share/fonts/opentype/noto/NotoSansCJK-${weight === 300 ? "Regular" : "Bold"}.ttc`, number: 2 };
    continue;
  }
  const instance = join(fontBuildDirectory, `sans-${weight}.ttf`);
  fontTools("fonttools", "varLib.instancer", localSans, `wght=${weight}`, "--static", "-o", instance);
  latinSources[weight] = { path: instance, number: null };
}

const fontResources = [];
for (const font of fonts) {
  const characters = separatedCharacters(font.characters);
  const latinName = characters.cjk.length === 0 ? font.name : `${font.name}-latin`;
  const latinId = characters.cjk.length === 0 ? font.id : `${font.id}Latin`;
  const latinSource = latinSources[font.weight];
  bitmapFont(latinSource.path, latinSource.number, font, characters.latin, latinName);
  fontResources.push(fontResource(latinId, latinName, font.scope));
  if (characters.cjk.length > 0) {
    const cjkName = `${font.name}-cjk`;
    const cjkId = `${font.id}Cjk`;
    bitmapFont("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 2, font, characters.cjk, cjkName);
    fontResources.push(fontResource(cjkId, cjkName, font.scope));
  }
}
await writeFile(join(fontResourceDirectory, "fonts.xml"), builder.build({ resources: { fonts: { font: fontResources } } }));
const variants = [
  { name: "GPT", key: "codex", id: "b9a68e252d4a461d9f2ce6cb6ef8cd10", icon: "gpt.png" },
  { name: "Claude", key: "claude", id: "a1c6278aab4d47b29cd4f162c2b4f113", icon: "cc.png" },
];
const previewArgument = process.argv.find((argument) => argument.startsWith("--preview-case="));
const previewCase = previewArgument?.split("=", 2)[1] ?? "deadline";
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
  const previewConstant = variant.preview ? ` const PREVIEW_CASE = "${previewCase}";` : "";
  await writeFile(join(target, "source/Variant.mc"), `(:glance) module QuotaVariant { const KEY = "${variant.key}"; const TITLE = "${variant.key === "codex" ? "GPT" : "Claude"}";${previewConstant} }\n`);
  if (variant.preview) await copyFile(join(directory, "preview/Announcement.mc"), join(target, "source/Announcement.mc"));
  const jungle = [
    `project.manifest = ${join(target, "manifest.xml")}`,
    `base.sourcePath = ${join(directory, "source")};${join(target, "source")}`,
    `base.resourcePath = ${join(directory, "resources")};${fontResourceDirectory};${join(directory, "private/resources")};${join(target, "resources")}`,
  ].join("\n");
  await writeFile(join(target, "build.jungle"), jungle);
  const packaged = process.argv.includes("--package");
  const output = variant.preview ? join(target, "GPT.prg") : join(directory, "bin", `${variant.name}.${packaged ? "iq" : "prg"}`);
  const args = ["-f", join(target, "build.jungle"), "-o", output, "-y", keyPath, "-w"];
  if (packaged) args.push("-e");
  else args.push("-d", "vivoactive5");
  execFileSync(join(sdk, "bin/monkeyc"), args, { cwd: directory, stdio: "inherit" });
}
