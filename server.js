import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const HOST = "127.0.0.1";
const MAX_BYTES = 500 * 1024 * 1024;
const BITRATES = new Set(["128", "192", "256", "320"]);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/convert") {
    return handleConvert(req, res, url).catch((error) => {
      console.error(error);
      if (!res.headersSent) sendJson(res, 500, { error: "Umwandlung fehlgeschlagen." });
      else res.destroy();
    });
  }
  if (req.method === "GET") return serveStatic(req, res, url.pathname);
  sendJson(res, 405, { error: "Methode nicht erlaubt." });
});

async function handleConvert(req, res, url) {
  const bitrate = url.searchParams.get("bitrate") ?? "192";
  if (!BITRATES.has(bitrate)) {
    return sendJson(res, 400, { error: "Unbekannte Bitrate." });
  }

  const originalName = safeDownloadName(url.searchParams.get("name") || "audio.wav");
  const mp3Name = originalName.replace(/\.(wav|wave)$/i, "") + ".mp3";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wav-to-mp3-"));
  const inputPath = path.join(dir, "input.wav");
  const outputPath = path.join(dir, "output.mp3");

  try {
    await writeBody(req, inputPath, MAX_BYTES);
    if (!(await looksLikeWav(inputPath))) {
      return sendJson(res, 400, { error: "Das ist keine WAV-Datei." });
    }

    await runFfmpeg(inputPath, outputPath, bitrate, res);
    const stat = await fs.stat(outputPath);
    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Content-Length": stat.size,
      "Content-Disposition": contentDisposition(mp3Name),
      "Cache-Control": "no-store",
    });
    const stream = createReadStream(outputPath);
    res.on("close", () => {
      if (!res.writableEnded) stream.destroy();
    });
    await new Promise((resolve, reject) => {
      stream.on("error", reject);
      res.on("finish", resolve);
      res.on("close", resolve);
      stream.pipe(res);
    });
    console.log(`${originalName} → ${mp3Name} (${formatBytes(stat.size)}, ${bitrate} kbps)`);
  } catch (error) {
    if (error.ffmpeg || error.code === "ENOENT") console.error(error.message);
    if (res.headersSent || res.writableEnded) return;
    const status = error.status ?? 500;
    const message =
      error.code === "ENOENT"
        ? "ffmpeg wurde nicht gefunden."
        : status === 413
          ? "Die Datei ist zu groß (maximal 500 MB)."
          : status === 400
            ? "Die Datei ist leer."
            : error.ffmpeg
              ? "ffmpeg konnte die Datei nicht umwandeln."
              : "Umwandlung fehlgeschlagen.";
    sendJson(res, status, { error: message });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeBody(req, dest, maxBytes) {
  const declared = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    const error = new Error("too large");
    error.status = 413;
    throw error;
  }

  let received = 0;
  const out = createWriteStream(dest);
  try {
    for await (const chunk of req) {
      received += chunk.length;
      if (received > maxBytes) {
        const error = new Error("too large");
        error.status = 413;
        throw error;
      }
      if (!out.write(chunk)) await once(out, "drain");
    }
    out.end();
    await once(out, "finish");
  } catch (error) {
    out.destroy();
    throw error;
  }

  if (received === 0) {
    const error = new Error("empty");
    error.status = 400;
    throw error;
  }
}

async function looksLikeWav(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buffer, 0, 12, 0);
    if (bytesRead < 12) return false;
    const id = buffer.toString("ascii", 0, 4);
    const wave = buffer.toString("ascii", 8, 12);
    return (id === "RIFF" || id === "RIFX" || id === "RF64") && wave === "WAVE";
  } finally {
    await handle.close();
  }
}

function runFfmpeg(inputPath, outputPath, bitrate, res) {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-i",
        inputPath,
        "-vn",
        "-codec:a",
        "libmp3lame",
        "-b:a",
        `${bitrate}k`,
        "-map_metadata",
        "0",
        "-id3v2_version",
        "3",
        outputPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    let stderr = "";
    ff.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    const timer = setTimeout(() => ff.kill("SIGKILL"), 15 * 60 * 1000);
    const stop = () => {
      if (!res.writableEnded) ff.kill("SIGKILL");
    };
    res.on("close", stop);

    ff.on("error", (error) => {
      clearTimeout(timer);
      res.off("close", stop);
      if (error.code === "ENOENT") {
        error.message = "ffmpeg fehlt";
      }
      reject(error);
    });

    ff.on("close", (code) => {
      clearTimeout(timer);
      res.off("close", stop);
      if (code === 0) resolve();
      else {
        const error = new Error(stderr.trim() || `ffmpeg beendet mit Code ${code}`);
        error.ffmpeg = true;
        reject(error);
      }
    });
  });
}

async function serveStatic(_req, res, pathname) {
  const requested = (pathname === "/" ? "index.html" : pathname).replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, decodeURIComponent(requested));
  if (filePath !== path.join(PUBLIC_DIR, "index.html") && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: "Zugriff verweigert." });
  }

  try {
    const data = await fs.readFile(filePath);
    const type = MIME[path.extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": data.length,
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch {
    if (!res.headersSent) sendJson(res, 404, { error: "Nicht gefunden." });
  }
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function safeDownloadName(name) {
  const base = path.basename(name).replace(/[\r\n"]/g, "").trim();
  const cleaned = base.replace(/[^\w.\- ()äöüÄÖÜß]+/g, "_").slice(0, 180);
  return cleaned || "audio.wav";
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ffmpegReady() {
  return new Promise((resolve) => {
    execFile("ffmpeg", ["-hide_banner", "-encoders"], (error, stdout) => {
      resolve(!error && stdout.includes("libmp3lame"));
    });
  });
}

const preferredPort = Number(process.env.PORT) || 3847;

if (!(await ffmpegReady())) {
  console.error("ffmpeg mit libmp3lame wurde nicht gefunden. Installiere es mit: brew install ffmpeg");
  process.exit(1);
}

server.listen(preferredPort, HOST, () => {
  const { port } = server.address();
  const url = `http://${HOST}:${port}`;
  console.log(`WAV zu MP3 läuft auf ${url}`);
  if (process.env.OPEN !== "0") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  }
});
