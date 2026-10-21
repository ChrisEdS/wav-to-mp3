const drop = document.querySelector("#drop");
const input = document.querySelector("#file");
const list = document.querySelector("#list");
const banner = document.querySelector("#banner");
const clearButton = document.querySelector("#clear");
const downloadAllButton = document.querySelector("#download-all");

const jobs = [];
const queue = [];
let busy = false;
let dragDepth = 0;
let lang = "en";

const copy = {
  en: {
    title: "WAV to MP3",
    eyebrow: "On this Mac",
    lede: "Drop one or more WAV files here. Conversion stays on this computer, and you download the MP3s when they are ready.",
    quality: "Quality",
    drop: "Drop WAV files here",
    choose: "or choose files",
    download: "Download",
    downloadAll: "All as ZIP",
    zipping: "Creating ZIP…",
    clear: "Clear list",
    waiting: "Waiting",
    uploading: "Uploading",
    converting: "Converting",
    done: "Done",
    wavOnly: "WAV files only.",
    "not-wav": "This is not a WAV file.",
    empty: "The file is empty.",
    "too-large": "The file is too large (maximum 500 MB).",
    "bad-bitrate": "Unknown bitrate.",
    "ffmpeg-missing": "ffmpeg was not found.",
    "ffmpeg-failed": "ffmpeg could not convert the file.",
    failed: "Conversion failed.",
    connection: "Lost the connection to the local server.",
    zipFailed: "The ZIP could not be created.",
    serverDown: "The local server is not responding.",
    langLabel: "Language",
  },
  de: {
    title: "WAV zu MP3",
    eyebrow: "Lokal auf diesem Mac",
    lede: "Zieh eine oder mehrere WAV-Dateien hierher. Die Umwandlung bleibt auf diesem Rechner, die MP3s lädst du danach herunter.",
    quality: "Qualität",
    drop: "WAV-Dateien hierher ziehen",
    choose: "oder auswählen",
    download: "Herunterladen",
    downloadAll: "Alle als ZIP",
    zipping: "ZIP wird erstellt…",
    clear: "Liste leeren",
    waiting: "Wartet",
    uploading: "Hochladen",
    converting: "Umwandeln",
    done: "Fertig",
    wavOnly: "Nur WAV-Dateien.",
    "not-wav": "Das ist keine WAV-Datei.",
    empty: "Die Datei ist leer.",
    "too-large": "Die Datei ist zu groß (maximal 500 MB).",
    "bad-bitrate": "Unbekannte Bitrate.",
    "ffmpeg-missing": "ffmpeg wurde nicht gefunden.",
    "ffmpeg-failed": "ffmpeg konnte die Datei nicht umwandeln.",
    failed: "Umwandlung fehlgeschlagen.",
    connection: "Verbindung zum lokalen Server verloren.",
    zipFailed: "Das ZIP konnte nicht erstellt werden.",
    serverDown: "Der lokale Server antwortet nicht.",
    langLabel: "Sprache",
  },
};

function t(key) {
  return copy[lang][key] ?? copy.en[key] ?? key;
}

function applyLanguage() {
  document.documentElement.lang = lang;
  document.title = t("title");
  document.querySelector("#lang").setAttribute("aria-label", t("langLabel"));
  for (const node of document.querySelectorAll("[data-i18n]")) {
    if (node.id === "download-all" && node.disabled) node.textContent = t("zipping");
    else node.textContent = t(node.dataset.i18n);
  }
  for (const button of document.querySelectorAll("[data-lang]")) {
    button.setAttribute("aria-pressed", button.dataset.lang === lang ? "true" : "false");
  }
  if (banner.dataset.i18n) banner.textContent = t(banner.dataset.i18n);
  for (const job of jobs) paintJob(job);
}

function setLang(next) {
  lang = next === "de" ? "de" : "en";
  localStorage.setItem("wav-to-mp3-lang", lang);
  applyLanguage();
}

function selectedBitrate() {
  return document.querySelector('input[name="bitrate"]:checked')?.value ?? "320";
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isWav(file) {
  return /\.(wav|wave)$/i.test(file.name);
}

function addFiles(fileList) {
  for (const file of fileList) {
    const job = createJob(file);
    jobs.push(job);
    list.append(job.element);
    if (!isWav(file)) {
      setJobState(job, "error", "wavOnly");
      continue;
    }
    job.bitrate = selectedBitrate();
    job.meta.textContent = `${formatBytes(file.size)} · ${job.bitrate} kbps`;
    queue.push(job);
  }
  updateActions();
  pump();
}

function createJob(file) {
  const element = document.createElement("li");
  element.className = "item";
  element.innerHTML = `
    <div class="item-top">
      <strong></strong>
      <span class="status"></span>
    </div>
    <div class="item-meta">
      <span class="meta"></span>
      <a class="download" hidden download></a>
    </div>
    <div class="track"><div class="fill"></div></div>
  `;
  element.querySelector("strong").textContent = file.name;
  const job = {
    file,
    element,
    status: element.querySelector(".status"),
    meta: element.querySelector(".meta"),
    link: element.querySelector(".download"),
    fill: element.querySelector(".fill"),
    url: "",
    bitrate: selectedBitrate(),
    state: "waiting",
    messageKey: "waiting",
  };
  job.meta.textContent = formatBytes(file.size);
  paintJob(job);
  return job;
}

function setJobState(job, state, messageKey) {
  job.state = state;
  job.messageKey = messageKey;
  paintJob(job);
  updateActions();
}

function paintJob(job) {
  const failed = job.state === "error";
  const done = job.state === "done";
  job.status.textContent = t(job.messageKey);
  job.status.classList.toggle("done", done);
  job.status.classList.toggle("error", failed);
  job.link.textContent = t("download");
  if (done || failed) {
    job.fill.classList.remove("busy");
    job.fill.style.width = "100%";
    job.fill.style.background = failed ? "var(--danger)" : "";
  }
}

function setProgress(job, ratio, messageKey, indeterminate) {
  job.state = indeterminate ? "converting" : "uploading";
  job.messageKey = messageKey;
  job.status.textContent = t(messageKey);
  job.status.classList.remove("done", "error");
  job.fill.style.background = "";
  job.fill.classList.toggle("busy", indeterminate);
  if (!indeterminate) job.fill.style.width = `${Math.round(ratio * 100)}%`;
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) await convertJob(queue.shift());
  } finally {
    busy = false;
    if (queue.length) pump();
  }
}

function convertJob(job) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    job.xhr = xhr;
    const name = encodeURIComponent(job.file.name);
    xhr.open("POST", `/api/convert?name=${name}&bitrate=${job.bitrate}`);
    xhr.responseType = "blob";
    xhr.setRequestHeader("Content-Type", "application/octet-stream");

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      setProgress(job, event.loaded / event.total, "uploading", false);
    };
    xhr.upload.onload = () => setProgress(job, 1, "converting", true);

    xhr.onload = async () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const blob = xhr.response;
        job.blob = blob;
        job.mp3Name = mp3NameFor(job.file.name);
        job.url = URL.createObjectURL(blob);
        job.link.href = job.url;
        job.link.download = job.mp3Name;
        job.link.hidden = false;
        job.meta.textContent = `${formatBytes(job.file.size)} → ${formatBytes(blob.size)} · ${job.bitrate} kbps`;
        setJobState(job, "done", "done");
      } else {
        setJobState(job, "error", await readError(xhr.response));
      }
      resolve();
    };

    xhr.onerror = () => {
      setJobState(job, "error", "connection");
      resolve();
    };
    xhr.onabort = () => resolve();
    xhr.send(job.file);
  });
}

async function readError(blob) {
  try {
    const data = JSON.parse(await blob.text());
    return data.error || "failed";
  } catch {
    return "failed";
  }
}

function updateActions() {
  const finished = jobs.some((job) => job.blob);
  const any = jobs.length > 0;
  downloadAllButton.hidden = !finished;
  clearButton.hidden = !any;
}

function mp3NameFor(filename) {
  return filename.replace(/\.(wav|wave)$/i, "") + ".mp3";
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let crc = n;
  for (let k = 0; k < 8; k += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  crcTable[n] = crc >>> 0;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function uniqueZipName(name, used) {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 180) || "audio.mp3";
  if (!used.has(clean)) {
    used.add(clean);
    return clean;
  }
  const dot = clean.lastIndexOf(".");
  const base = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : "";
  let n = 2;
  let next = `${base} (${n})${ext}`;
  while (used.has(next)) {
    n += 1;
    next = `${base} (${n})${ext}`;
  }
  used.add(next);
  return next;
}

async function buildZip(entries) {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const used = new Set();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(uniqueZipName(entry.name, used));
    const data = new Uint8Array(await entry.blob.arrayBuffer());
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);

    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 20, true);
    header.setUint16(8, 0x0800, true);
    header.setUint16(12, dosTime, true);
    header.setUint16(14, dosDate, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, data.length, true);
    header.setUint32(24, data.length, true);
    header.setUint16(28, nameBytes.length, true);
    header.setUint32(42, offset, true);

    parts.push(new Uint8Array(local.buffer), nameBytes, data);
    central.push(new Uint8Array(header.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
}

async function downloadAll() {
  const ready = jobs.filter((job) => job.blob);
  if (!ready.length || downloadAllButton.disabled) return;
  downloadAllButton.disabled = true;
  downloadAllButton.textContent = t("zipping");
  try {
    const zip = await buildZip(ready.map((job) => ({ name: job.mp3Name, blob: job.blob })));
    const url = URL.createObjectURL(zip);
    const link = document.createElement("a");
    link.href = url;
    link.download = "mp3s.zip";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    showBanner("zipFailed");
  } finally {
    downloadAllButton.disabled = false;
    downloadAllButton.textContent = t("downloadAll");
  }
}

function showBanner(key) {
  banner.hidden = false;
  banner.dataset.i18n = key;
  banner.textContent = t(key);
}

function clearJobs() {
  for (const job of jobs) {
    job.xhr?.abort();
    if (job.url) URL.revokeObjectURL(job.url);
  }
  jobs.length = 0;
  queue.length = 0;
  list.replaceChildren();
  updateActions();
}

input.addEventListener("change", () => {
  addFiles(input.files);
  input.value = "";
});

drop.addEventListener("click", (event) => {
  if (event.target.closest("label")) return;
  input.click();
});

drop.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    input.click();
  }
});

window.addEventListener("dragenter", (event) => {
  if (![...event.dataTransfer.types].includes("Files")) return;
  dragDepth += 1;
  drop.classList.add("hot");
});

window.addEventListener("dragover", (event) => {
  event.preventDefault();
});

window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) drop.classList.remove("hot");
});

window.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  drop.classList.remove("hot");
  if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files);
});

downloadAllButton.addEventListener("click", downloadAll);
clearButton.addEventListener("click", clearJobs);
document.querySelector("#lang").addEventListener("click", (event) => {
  const button = event.target.closest("[data-lang]");
  if (!button) return;
  setLang(button.dataset.lang);
});

const savedLang = localStorage.getItem("wav-to-mp3-lang");
setLang(savedLang === "de" ? "de" : "en");

fetch("/api/health").catch(() => {
  showBanner("serverDown");
});
