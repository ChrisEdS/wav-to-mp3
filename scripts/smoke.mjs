import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { startServer, stopServer } from "../server.js";

const execFileAsync = promisify(execFile);
const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";

function wavBytes() {
  const samples = 2000;
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

const started = await startServer({ ffmpegPath, openBrowser: false, port: 0 });
const dir = await mkdtemp(path.join(tmpdir(), "wav-to-mp3-smoke-"));
try {
  const response = await fetch(`${started.url}/api/convert?name=Smoke.wav&bitrate=320`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: wavBytes(),
  });
  if (!response.ok) throw new Error(await response.text());
  const mp3 = Buffer.from(await response.arrayBuffer());
  const file = path.join(dir, "smoke.mp3");
  await writeFile(file, mp3);
  if (mp3.subarray(0, 3).toString() !== "ID3" && mp3[0] !== 0xff) {
    throw new Error("response is not an MP3");
  }
  const { stdout } = await execFileAsync(ffmpegPath, ["-hide_banner", "-i", file], { maxBuffer: 1024 * 1024 }).catch(
    (error) => ({ stdout: `${error.stdout || ""}\n${error.stderr || ""}` }),
  );
  if (!stdout.includes("Audio: mp3")) throw new Error(stdout);
  process.stdout.write(`smoke ok ${mp3.length} bytes on ${started.url}\n`);
} finally {
  await stopServer();
  await rm(dir, { recursive: true, force: true });
}
