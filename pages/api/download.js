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

const YOUTUBE_EXTRACTOR_PROFILES = [
  "youtube:player_client=web,default,ios",
  "youtube:player_client=android,ios",
  "youtube:player_client=tv,ios,android",
  "youtube:player_client=android,ios;player_skip=webpage,configs",
];

// ---------------------------------------------------------------------------
// Build-time binary
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

function isNetscapeFormat(text) {
  return (
    text.includes("# Netscape HTTP Cookie File") ||
    text.includes("# HTTP Cookie File") ||
    text.split("\n").some((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return false;
      return trimmed.split("\t").length >= 6;
    })
  );
}

// BOM, CRLF, CR sab clean karo — yt-dlp strict hai
function cleanNetscapeContent(content) {
  const cleaned = content
    .replace(/^\uFEFF/, "")      // UTF-8 BOM remove
    .replace(/\r\n/g, "\n")      // Windows CRLF → LF
    .replace(/\r/g, "\n")        // old Mac CR → LF
    .trim();

  // Some exporters omit the header; yt-dlp expects Netscape header.
  if (!cleaned) return "# Netscape HTTP Cookie File\n";
  if (cleaned.startsWith("# Netscape HTTP Cookie File") || cleaned.startsWith("# HTTP Cookie File")) {
    return cleaned;
  }
  return `# Netscape HTTP Cookie File\n${cleaned}`;
}

function resolveCookiePath(cookiePath) {
  const raw = String(cookiePath || "").trim();
  if (!raw) return "";
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

async function readCookieSource() {
  // 1. Base64 encoded env var
  const envBase64 = process.env.YTDL_COOKIES_B64;
  if (envBase64) {
    try {
      const decoded = Buffer.from(envBase64, "base64").toString("utf8");

      // JSON array format (Cookie-Editor extension)
      const cookies = parseCookieJson(decoded);
      if (cookies) {
        console.log("[ytgrab] Cookies loaded from YTDL_COOKIES_B64 (JSON format)");
        return { type: "json", cookies };
      }

      // Netscape format (cookies.txt export)
      if (isNetscapeFormat(decoded)) {
        console.log("[ytgrab] Cookies loaded from YTDL_COOKIES_B64 (Netscape format)");
        return { type: "netscape-raw", content: decoded };
      }

      console.warn("[ytgrab] Invalid YTDL_COOKIES_B64 — not JSON or Netscape format.");
    } catch {
      console.warn("[ytgrab] Failed to decode YTDL_COOKIES_B64.");
    }
  }

  // 2. Raw JSON env var
  const envRaw = process.env.YTDL_COOKIES || process.env.YT_COOKIES;
  if (envRaw) {
    const rawValue = String(envRaw).trim();
    const cookies = parseCookieJson(rawValue);
    if (cookies) {
      console.log("[ytgrab] Cookies loaded from YTDL_COOKIES env var");
      return { type: "json", cookies };
    }

    // Backward compatibility: allow Netscape cookies directly in YTDL_COOKIES.
    if (isNetscapeFormat(rawValue)) {
      console.log("[ytgrab] Cookies loaded from YTDL_COOKIES env var (Netscape format)");
      return { type: "netscape-raw", content: rawValue };
    }

    // Backward compatibility: some setups put a file path in YTDL_COOKIES.
    const legacyCookiePath = resolveCookiePath(rawValue);
    if (legacyCookiePath) {
      try {
        await fsPromises.access(legacyCookiePath, fs.constants.R_OK);
        console.log("[ytgrab] YTDL_COOKIES treated as cookie file path; prefer YTDL_COOKIES_PATH");
        return { type: "netscape-file", cookiePath: legacyCookiePath };
      } catch {
        // Fall through to warning below.
      }
    }

    console.warn("[ytgrab] Invalid YTDL_COOKIES JSON.");
  }

  // 3. Path to cookies file
  const cookiePath = process.env.YTDL_COOKIES_PATH;
  if (!cookiePath) return null;

  const resolvedPath = resolveCookiePath(cookiePath);

  try {
    const content = await fsPromises.readFile(resolvedPath, "utf8");
    const cookies = parseCookieJson(content);
    if (cookies) {
      console.log("[ytgrab] Cookies loaded from file (JSON format)");
      return { type: "json", cookies };
    }
    console.log("[ytgrab] Cookies loaded from file (Netscape format)");
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
  if (!source) {
    console.warn("[ytgrab] No cookies found — downloads may fail.");
    return null;
  }

  const targetPath = path.join(tempDir, "cookies.txt");

  if (source.type === "netscape-file") {
    // File se read karke clean karke likho
    const raw = await fsPromises.readFile(source.cookiePath, "utf8");
    await fsPromises.writeFile(targetPath, cleanNetscapeContent(raw), "utf8");
    return targetPath;
  }

  if (source.type === "netscape-raw") {
    // Clean karke likho — BOM aur CRLF hata do
    await fsPromises.writeFile(targetPath, cleanNetscapeContent(source.content), "utf8");
    return targetPath;
  }

  // JSON array — Netscape format mein convert karo
  await fsPromises.writeFile(targetPath, toNetscapeCookieFile(source.cookies), "utf8");
  return targetPath;
  
}

  // ... baaki code same
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
    extractorArgs: YOUTUBE_EXTRACTOR_PROFILES[0],
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

function isBotChallengeError(err) {
  const s = stringifyError(err).toLowerCase();
  return s.includes("sign in to confirm") || s.includes("confirm you're not a bot") || s.includes("confirm you’re not a bot");
}

async function execWithSelectedBinary(url, flags, { forceStandalone = false } = {}) {
  if (forceStandalone) {
    const standalonePath = await ensureStandaloneYtDlpPath();
    console.log(`[ytgrab] Using runtime standalone binary: ${standalonePath}`);
    await ytdlp.create(standalonePath).exec(url, flags, { windowsHide: true, reject: true });
    return;
  }

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
  await ytdlp.create(standalonePath).exec(url, flags, { windowsHide: true, reject: true });
}

async function runYtDlp(url, flags) {
  const profileOrder = [
    flags.extractorArgs,
    ...YOUTUBE_EXTRACTOR_PROFILES.filter((p) => p !== flags.extractorArgs),
  ];

  const tryProfiles = async ({ forceStandalone = false } = {}) => {
    let lastErr = null;

    for (let i = 0; i < profileOrder.length; i += 1) {
      const extractorArgs = profileOrder[i];
      const attemptFlags = { ...flags, extractorArgs };

      try {
        await execWithSelectedBinary(url, attemptFlags, { forceStandalone });
        return null;
      } catch (err) {
        lastErr = err;
        if (!isBotChallengeError(err) || i === profileOrder.length - 1) {
          return err;
        }
        console.warn(`[ytgrab] Bot challenge with profile '${extractorArgs}', retrying...`);
      }
    }

    return lastErr;
  };

  let err = await tryProfiles();
  if (!err) return;

  if (isBotChallengeError(err)) {
    console.warn("[ytgrab] Retrying bot challenge with runtime standalone binary...");
    err = await tryProfiles({ forceStandalone: true });
    if (!err) return;
  }

  err.stderr = [err?.stderr, stringifyError(err)].filter(Boolean).join("\n");
  throw err;
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

  if (isBotChallengeError(err))
    return { status: 403, message: "YouTube bot-check blocked this request. Re-export fresh YouTube cookies from a logged-in browser session and try again." };
  if (s.includes("does not look like a netscape"))
    return { status: 500, message: "Cookie file format invalid. Re-export cookies and try again." };
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
