import ffmpegPath from "ffmpeg-static";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ytdlp from "yt-dlp-exec";

export const config = {
  runtime: "nodejs",
  maxDuration: 60,
  api: { responseLimit: false },
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const MIME_BY_EXT = {
  aac: "audio/aac",
  flac: "audio/flac",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  mkv: "video/x-matroska",
  wav: "audio/wav",
  webm: "video/webm",
};

const AUDIO_FORMATS = new Set(["MP3", "AAC", "WAV", "FLAC"]);

// ---------------------------------------------------------------------------
// Build-time binary (placed by scripts/download-ytdlp.js at postinstall)
// ---------------------------------------------------------------------------

function getBuildTimeBinaryName() {
  const { platform, arch } = process;
  if (platform === "win32") return "yt-dlp.exe";
  if (platform === "darwin") return "yt-dlp_macos";
  if (platform === "linux") {
    if (arch === "arm64") return "yt-dlp_linux_aarch64";
    if (arch === "arm") return "yt-dlp_linux_armv7l";
    return "yt-dlp_linux";
  }
  return "yt-dlp";
}

const BUILD_TIME_BIN_PATH = path.join(process.cwd(), "bin", getBuildTimeBinaryName());

function getBuildTimeBinary() {
  try {
    fs.accessSync(BUILD_TIME_BIN_PATH, fs.constants.X_OK);
    return BUILD_TIME_BIN_PATH;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Runtime standalone binary fallback
// ---------------------------------------------------------------------------

let standaloneYtDlpPathPromise = null;

async function ensureStandaloneYtDlpPath() {
  if (!standaloneYtDlpPathPromise) {
    standaloneYtDlpPathPromise = (async () => {
      const binDir = path.join(os.tmpdir(), "ytgrab-bin");
      const binaryPath = path.join(binDir, getBuildTimeBinaryName());
      try {
        await fsPromises.access(binaryPath, fs.constants.X_OK);
        return binaryPath;
      } catch { /* not cached */ }

      await fsPromises.mkdir(binDir, { recursive: true });
      const customUrl = String(process.env.YTDLP_STANDALONE_URL || "").trim();
      const url = customUrl ||
        `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${getBuildTimeBinaryName()}`;

      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to download standalone yt-dlp (${response.status})`);

      const payload = Buffer.from(await response.arrayBuffer());
      await fsPromises.writeFile(binaryPath, payload, { mode: 0o755 });
      if (process.platform !== "win32") await fsPromises.chmod(binaryPath, 0o755);
      return binaryPath;
    })().catch((err) => { standaloneYtDlpPathPromise = null; throw err; });
  }
  return standaloneYtDlpPathPromise;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function normalizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function isYouTubeUrl(value) {
  try {
    const host = new URL(value).hostname.replace(/^www\./i, "").toLowerCase();
    return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

function parseCookieJson(raw) {
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : null; }
  catch { return null; }
}

async function readCookieSource() {
  const envBase64 = process.env.YTDL_COOKIES_B64;
  if (envBase64) {
    try {
      const cookies = parseCookieJson(Buffer.from(envBase64, "base64").toString("utf8"));
      if (cookies) return { type: "json", cookies };
    } catch { console.warn("[ytgrab] Failed to decode YTDL_COOKIES_B64."); }
  }

  const envRaw = process.env.YTDL_COOKIES || process.env.YT_COOKIES;
  if (envRaw) {
    const cookies = parseCookieJson(envRaw);
    if (cookies) return { type: "json", cookies };
  }

  const cookiePath = process.env.YTDL_COOKIES_PATH;
  if (!cookiePath) return null;

  const resolvedPath = path.isAbsolute(cookiePath)
    ? cookiePath : path.join(process.cwd(), cookiePath);

  try {
    const content = await fsPromises.readFile(resolvedPath, "utf8");
    const cookies = parseCookieJson(content);
    if (cookies) return { type: "json", cookies };
    return { type: "netscape-file", cookiePath: resolvedPath };
  } catch (err) {
    console.warn("[ytgrab] Failed to read YTDL_COOKIES_PATH:", err?.message);
    return null;
  }
}

function toNetscapeCookieFile(cookies) {
  const lines = ["# Netscape HTTP Cookie File", ""];
  for (const c of cookies || []) {
    if (!c?.name || typeof c.value === "undefined" || !c.domain) continue;
    const domain = String(c.domain);
    lines.push([
      domain,
      domain.startsWith(".") ? "TRUE" : "FALSE",
      c.path || "/",
      c.secure ? "TRUE" : "FALSE",
      Number.isFinite(Number(c.expirationDate)) ? Math.trunc(Number(c.expirationDate)) : 0,
      String(c.name),
      String(c.value),
    ].join("\t"));
  }
  return lines.join("\n");
}

async function prepareCookieFile(tempDir) {
  const source = await readCookieSource();
  if (!source) return null;
  if (source.type === "netscape-file") return source.cookiePath;
  const targetPath = path.join(tempDir, "cookies.txt");
  await fsPromises.writeFile(targetPath, toNetscapeCookieFile(source.cookies), "utf8");
  return targetPath;
}

// ---------------------------------------------------------------------------
// Format selection
// ---------------------------------------------------------------------------

function mapQualityToHeight(quality) {
  const v = String(quality || "").toLowerCase();
  if (!v) return null;
  if (v.includes("4k")) return 2160;
  const m = v.match(/(\d{3,4})p/);
  if (m) return Number(m[1]);
  if (v.includes("1080")) return 1080;
  if (v.includes("720")) return 720;
  if (v.includes("480")) return 480;
  if (v.includes("360")) return 360;
  return null;
}

function buildVideoSelector(quality) {
  const h = mapQualityToHeight(quality);
  const fallbacks = [
    "bestvideo[ext=mp4]+bestaudio[ext=m4a]",
    "bestvideo+bestaudio",
    "best[ext=mp4]",
    "best",
  ];
  if (!h) return fallbacks.join("/");
  return [
    `bestvideo[ext=mp4][height<=${h}]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${h}]+bestaudio`,
    `best[ext=mp4][height<=${h}]`,
    `best[height<=${h}]`,
    ...fallbacks,
  ].join("/");
}

// ---------------------------------------------------------------------------
// yt-dlp invocation
// ---------------------------------------------------------------------------

function buildYtDlpFlags({ outputTemplate, normalizedFormat, quality, cookiePath }) {
  const base = {
    noPlaylist: true,
    noWarnings: true,
    ffmpegLocation: ffmpegPath,
    forceOverwrites: true,
    output: outputTemplate,
    userAgent: DEFAULT_USER_AGENT,
    // Force the web player so all formats are available.
    // Without this, cookies can cause yt-dlp to use the TV/Android client
    // which has fewer formats and causes "format not available" errors.
    extractorArgs: "youtube:player_client=web,default,ios",
  };

  if (cookiePath) base.cookies = cookiePath;

  if (AUDIO_FORMATS.has(normalizedFormat)) {
    return {
      ...base,
      format: "bestaudio/best",
      extractAudio: true,
      audioFormat: normalizedFormat.toLowerCase(),
      audioQuality: "0",
    };
  }

  return {
    ...base,
    format: buildVideoSelector(quality),
    mergeOutputFormat: "mp4",
  };
}

function stringifyError(err) {
  return [err?.stderr, err?.shortMessage, err?.message].filter(Boolean).join("\n");
}

function isMissingPythonError(err) {
  const s = stringifyError(err).toLowerCase();
  return s.includes("python3") && s.includes("no such file or directory");
}

async function runYtDlp(url, flags) {
  // 1. Build-time binary (Vercel deployment)
  const buildBin = getBuildTimeBinary();
  if (buildBin) {
    console.log(`[ytgrab] Using build-time binary: ${buildBin}`);
    await ytdlp.create(buildBin).exec(url, flags, { windowsHide: true, reject: true });
    return;
  }

  // 2. Default yt-dlp-exec binary (local dev with Python)
  try {
    await ytdlp.exec(url, flags, { windowsHide: true, reject: true });
    return;
  } catch (err) {
    if (!isMissingPythonError(err)) throw err;
    console.warn("[ytgrab] Python not found; falling back to runtime standalone download...");
  }

  // 3. Runtime download fallback
  const standalonePath = await ensureStandaloneYtDlpPath();
  try {
    await ytdlp.create(standalonePath).exec(url, flags, { windowsHide: true, reject: true });
  } catch (retryErr) {
    retryErr.stderr = [retryErr?.stderr, stringifyError(retryErr)].filter(Boolean).join("\n");
    throw retryErr;
  }
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

async function findOutputFile(tempDir) {
  const files = await fsPromises.readdir(tempDir);
  const matches = files.filter((f) => f.startsWith("download.")).sort();
  if (!matches.length) throw new Error("yt-dlp did not produce an output file");
  return path.join(tempDir, matches[0]);
}

function getMimeType(filePath, normalizedFormat) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? (AUDIO_FORMATS.has(normalizedFormat) ? "audio/mpeg" : "video/mp4");
}

function getResponseFilename(filePath, normalizedFormat) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return AUDIO_FORMATS.has(normalizedFormat)
    ? `audio.${ext || normalizedFormat.toLowerCase()}`
    : `video.${ext || "mp4"}`;
}

async function streamFileToResponse(filePath, res) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    let settled = false;
    const done = (err) => { if (settled) return; settled = true; err ? reject(err) : resolve(); };
    stream.on("error", done);
    res.on("error", done);
    res.on("finish", () => done());
    res.on("close", () => done());
    stream.pipe(res);
  });
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function classifyError(err) {
  const s = stringifyError(err).toLowerCase();

  if (s.includes("sign in to confirm") || s.includes("confirm you're not a bot"))
    return { status: 403, message: "YouTube requires authentication. Set valid cookies via YTDL_COOKIES_B64." };
  if (s.includes("429") || s.includes("rate limit"))
    return { status: 429, message: "YouTube is rate-limiting this server. Try again later." };
  if (s.includes("requested format is not available"))
    return { status: 422, message: "No downloadable format found for this video." };
  if (s.includes("video unavailable") || s.includes("private video") || s.includes("members-only"))
    return { status: 404, message: "This video is unavailable or private." };
  if (s.includes("http error 403") || s.includes("status code: 403") || s.includes("forbidden"))
    return { status: 403, message: "YouTube denied the request (403). Refresh your cookies." };
  if (s.includes("no space left") || s.includes("enospc"))
    return { status: 507, message: "Server storage is full. Try a lower quality." };
  if (s.includes("timed out") || s.includes("timeout"))
    return { status: 504, message: "Download timed out. Try a lower quality or shorter video." };
  if (s.includes("permission denied") && (s.includes("yt-dlp") || s.includes("ffmpeg")))
    return { status: 500, message: "Binary permission error on server." };
  if (s.includes("enoent") && (s.includes("yt-dlp") || s.includes("spawn")))
    return { status: 500, message: "yt-dlp binary missing. Redeploy the project." };

  return { status: 500, message: "Download failed. Please try again." };
}

async function safeRm(p) {
  try { await fsPromises.rm(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { url, format = "MP4", quality = "1080p" } = req.body || {};
  const normalizedUrl = normalizeUrl(url);
  const normalizedFormat = String(format || "MP4").toUpperCase();

  if (!normalizedUrl || !isYouTubeUrl(normalizedUrl)) {
    return res.status(400).json({ error: "Invalid YouTube URL" });
  }

  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "ytgrab-"));

  try {
    const cookiePath = await prepareCookieFile(tempDir);
    const outputTemplate = path.join(tempDir, "download.%(ext)s");
    const flags = buildYtDlpFlags({ outputTemplate, normalizedFormat, quality, cookiePath });

    await runYtDlp(normalizedUrl, flags);

    const outputPath = await findOutputFile(tempDir);
    const mimeType = getMimeType(outputPath, normalizedFormat);
    const filename = getResponseFilename(outputPath, normalizedFormat);
    const { size } = await fsPromises.stat(outputPath);

    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", String(size));

    await streamFileToResponse(outputPath, res);
  } catch (err) {
    console.error("[ytgrab] Download error:", err);
    const { status, message } = classifyError(err);
    if (!res.headersSent) return res.status(status).json({ error: message });
    if (!res.writableEnded) res.end();
  } finally {
    await safeRm(tempDir);
  }
}