import { execFile } from "node:child_process";
import { access, chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tag = "b6.1.1";
const base = `https://github.com/eugeneware/ffmpeg-static/releases/download/${tag}`;

const targets = [
  { os: "mac", arch: "arm64", asset: "ffmpeg-darwin-arm64.gz", exe: "ffmpeg", notice: "darwin-arm64" },
  { os: "mac", arch: "x64", asset: "ffmpeg-darwin-x64.gz", exe: "ffmpeg", notice: "darwin-x64" },
  { os: "win", arch: "x64", asset: "ffmpeg-win32-x64.gz", exe: "ffmpeg.exe", notice: "win32-x64" },
  { os: "linux", arch: "x64", asset: "ffmpeg-linux-x64.gz", exe: "ffmpeg", notice: "linux-x64" },
  { os: "linux", arch: "arm64", asset: "ffmpeg-linux-arm64.gz", exe: "ffmpeg", notice: "linux-arm64" },
];

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function saveBinary(target) {
  const dir = path.join(root, "vendor", "ffmpeg", `${target.os}-${target.arch}`);
  const dest = path.join(dir, target.exe);
  await mkdir(dir, { recursive: true });
  if (!(await exists(dest))) {
    process.stdout.write(`Downloading ${target.asset}\n`);
    const packed = await download(`${base}/${target.asset}`);
    const binary = packed[0] === 0x1f && packed[1] === 0x8b ? gunzipSync(packed) : packed;
    const partial = path.join(tmpdir(), `${target.asset}.part`);
    await writeFile(partial, binary);
    await rename(partial, dest);
    await chmod(dest, 0o755);
  }
  for (const suffix of ["LICENSE", "README"]) {
    const notice = path.join(dir, `${suffix}.txt`);
    if (await exists(notice)) continue;
    const packed = await download(`${base}/${target.notice}.${suffix}.gz`);
    const text = packed[0] === 0x1f && packed[1] === 0x8b ? gunzipSync(packed) : packed;
    await writeFile(notice, text);
  }
  return dest;
}

const current = targets.find((target) => {
  const os = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux";
  return target.os === os && target.arch === process.arch;
});

for (const target of targets) {
  const dest = await saveBinary(target);
  if (current && target.os === current.os && target.arch === current.arch) {
    const { stdout } = await execFileAsync(dest, ["-hide_banner", "-encoders"], { maxBuffer: 2 * 1024 * 1024 });
    if (!stdout.includes("libmp3lame")) {
      throw new Error(`${dest} does not include libmp3lame`);
    }
    process.stdout.write(`libmp3lame ok: ${dest}\n`);
  }
}
