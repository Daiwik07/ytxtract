import ffmpegPath from "ffmpeg-static";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ytdlp from "yt-dlp-exec";

export const config = {
  runtime: "nodejs",
  maxDuration: 60,
  api: {
    responseLimit: false,
  },
};

// ---------------------------------------------------------------------------
// Build-time binary (downloaded by scripts/download-ytdlp.js at postinstall)
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

// Vercel serves files from the project root at runtime.
const BUILD_TIME_BIN_PATH = path.join(
  process.cwd(),
  "bin",
  getBuildTimeBinaryName()
);

function getBuildTimeBinary() {
  try {
    fs.accessSync(BUILD_TIME_BIN_PATH, fs.constants.X_OK);
    return BUILD_TIME_BIN_PATH;
  } catch {
    return null;
  }
}

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
let standaloneYtDlpPathPromise = null;

function stringifyError(error) {
  return [error?.stderr, error?.shortMessage, error?.message].filter(Boolean).join("\n");
}

function isMissingPythonError(error) {
  const normalized = stringifyError(error).toLowerCase();
  return normalized.includes("python3") && normalized.includes("no such file or directory");
}

function getStandaloneAssetName() {
  if (process.platform === "win32") {
    return "yt-dlp.exe";
  }

  if (process.platform === "darwin") {
    return "yt-dlp_macos";
  }

  if (process.platform === "linux") {
    if (process.arch === "arm64") {
      return "yt-dlp_linux_aarch64";
    }
    if (process.arch === "arm") {
      return "yt-dlp_linux_armv7l";
    }
    return "yt-dlp_linux";
  }

  return "yt-dlp";
}

function getStandaloneAssetUrl() {
  const customUrl = String(process.env.YTDLP_STANDALONE_URL || "").trim();
  if (customUrl) {
    return customUrl;
  }

  return `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${getStandaloneAssetName()}`;
}

async function ensureStandaloneYtDlpPath() {
  if (!standaloneYtDlpPathPromise) {
    standaloneYtDlpPathPromise = (async () => {
      const binDir = path.join(os.tmpdir(), "ytgrab-bin");
      const binaryName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
      const binaryPath = path.join(binDir, binaryName);

      try {
        await fsPromises.access(binaryPath, fs.constants.X_OK);
        return binaryPath;
      } catch {
        // Keep going and download a standalone binary.
      }

      await fsPromises.mkdir(binDir, { recursive: true });
      const response = await fetch(getStandaloneAssetUrl());

      if (!response.ok) {
        throw new Error(`Failed to download standalone yt-dlp (${response.status})`);
      }

      const payload = Buffer.from(await response.arrayBuffer());
      await fsPromises.writeFile(binaryPath, payload, { mode: 0o755 });

      if (process.platform !== "win32") {
        await fsPromises.chmod(binaryPath, 0o755);
      }

      return binaryPath;
    })().catch((error) => {
      standaloneYtDlpPathPromise = null;
      throw error;
    });
  }

  return standaloneYtDlpPathPromise;
}

function normalizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function isYouTubeUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

function parseCookieJson(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readCookieSource() {
  const envBase64 = process.env.YTDL_COOKIES_B64;
  if (envBase64) {
    try {
      const decoded = Buffer.from(envBase64, "base64").toString("utf8");
      const cookies = parseCookieJson(decoded);
      if (cookies) {
        return { type: "json", cookies };
      }
      console.warn("Invalid YTDL_COOKIES_B64 payload.");
    } catch {
      console.warn("Failed to decode YTDL_COOKIES_B64.");
    }
  }

  const envRaw = process.env.YTDL_COOKIES || process.env.YT_COOKIES;
  if (envRaw) {
    const cookies = parseCookieJson(envRaw);
    if (cookies) {
      return { type: "json", cookies };
    }
    console.warn("Invalid YTDL_COOKIES JSON. Ignoring cookie env content.");
  }

  const cookiePath = process.env.YTDL_COOKIES_PATH;
  if (!cookiePath) {
    return null;
  }

  const resolvedPath = path.isAbsolute(cookiePath)
    ? cookiePath
    : path.join(process.cwd(), cookiePath);

  try {
    const content = await fsPromises.readFile(resolvedPath, "utf8");
    const cookies = parseCookieJson(content);
    if (cookies) {
      return { type: "json", cookies };
    }
    return { type: "netscape-file", cookiePath: resolvedPath };
  } catch (error) {
    console.warn("Failed to read YTDL_COOKIES_PATH", error?.message || error);
    return null;
  }
}

function toNetscapeCookieFile(cookies) {
  const lines = ["# Netscape HTTP Cookie File", ""];

  for (const cookie of cookies || []) {
    if (!cookie || !cookie.name || typeof cookie.value === "undefined" || !cookie.domain) {
      continue;
    }

    const domain = String(cookie.domain);
    const includeSubdomains = domain.startsWith(".") ? "TRUE" : "FALSE";
    const cookiePath = cookie.path || "/";
    const secure = cookie.secure ? "TRUE" : "FALSE";
    const expires = Number.isFinite(Number(cookie.expirationDate))
      ? Math.trunc(Number(cookie.expirationDate))
      : 0;

    lines.push(
      [
        domain,
        includeSubdomains,
        cookiePath,
        secure,
        String(expires),
        String(cookie.name),
        String(cookie.value),
      ].join("\t"),
    );
  }

  return lines.join("\n");
}

async function prepareCookieFile(tempDir) {
  const cookieSource = await readCookieSource();
  if (!cookieSource) {
    return null;
  }

  if (cookieSource.type === "netscape-file") {
    return cookieSource.cookiePath;
  }

  const targetPath = path.join(tempDir, "cookies.txt");
  const netscapeContent = toNetscapeCookieFile(cookieSource.cookies);
  await fsPromises.writeFile(targetPath, netscapeContent, "utf8");
  return targetPath;
}

function mapQualityToHeight(quality) {
  const value = String(quality || "").toLowerCase();
  if (!value) {
    return null;
  }

  if (value.includes("4k")) {
    return 2160;
  }

  const explicitMatch = value.match(/(\d{3,4})p/);
  if (explicitMatch) {
    return Number(explicitMatch[1]);
  }

  if (value.includes("1080")) {
    return 1080;
  }
  if (value.includes("720")) {
    return 720;
  }
  if (value.includes("480")) {
    return 480;
  }
  if (value.includes("360")) {
    return 360;
  }

  return null;
}

function buildVideoSelector(quality) {
  const maxHeight = mapQualityToHeight(quality);
  if (!maxHeight) {
    return "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best";
  }

  // Try preferred quality first, then progressively relax so we always
  // get something rather than failing with "format not available".
  return [
    `bestvideo[ext=mp4][height<=${maxHeight}]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${maxHeight}]+bestaudio`,
    `best[ext=mp4][height<=${maxHeight}]`,
    `best[height<=${maxHeight}]`,
    `bestvideo[ext=mp4]+bestaudio[ext=m4a]`,
    `bestvideo+bestaudio`,
    `best[ext=mp4]`,
    `best`,
  ].join("/");
}

function buildYtDlpFlags({ outputTemplate, normalizedFormat, quality, cookiePath }) {
  const base = {
    noPlaylist: true,
    noWarnings: true,
    ffmpegLocation: ffmpegPath,
    forceOverwrites: true,
    output: outputTemplate,
    userAgent: DEFAULT_USER_AGENT,
  };

  if (cookiePath) {
    base.cookies = cookiePath;
  }

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

async function runYtDlp(url, flags) {
  // 1. Prefer the binary bundled at build time (populated by postinstall script).
  const buildBin = getBuildTimeBinary();
  if (buildBin) {
    console.log(`[ytgrab] Using build-time yt-dlp binary: ${buildBin}`);
    const builtYtDlp = ytdlp.create(buildBin);
    await builtYtDlp.exec(url, flags, { windowsHide: true, reject: true });
    return;
  }

  // 2. Try the default yt-dlp-exec binary (works when Python is available).
  try {
    await ytdlp.exec(url, flags, { windowsHide: true, reject: true });
    return;
  } catch (error) {
    if (!isMissingPythonError(error)) {
      throw error;
    }
    console.warn("[ytgrab] Python not found; falling back to standalone yt-dlp download…");
  }

  // 3. Last resort: download standalone binary at runtime into /tmp.
  const standalonePath = await ensureStandaloneYtDlpPath();
  const standaloneYtDlp = ytdlp.create(standalonePath);

  try {
    await standaloneYtDlp.exec(url, flags, { windowsHide: true, reject: true });
  } catch (retryError) {
    retryError.stderr = [retryError?.stderr, stringifyError(retryError)].filter(Boolean).join("\n");
    throw retryError;
  }
}

async function findOutputFile(tempDir) {
  const files = await fsPromises.readdir(tempDir);
  const matches = files
    .filter((name) => name.startsWith("download."))
    .sort((a, b) => a.localeCompare(b));

  if (!matches.length) {
    throw new Error("yt-dlp did not produce an output file");
  }

  return path.join(tempDir, matches[0]);
}

function getMimeType(filePath, normalizedFormat) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (MIME_BY_EXT[ext]) {
    return MIME_BY_EXT[ext];
  }
  return AUDIO_FORMATS.has(normalizedFormat) ? "audio/mpeg" : "video/mp4";
}

function getResponseFilename(filePath, normalizedFormat) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (AUDIO_FORMATS.has(normalizedFormat)) {
    return `audio.${ext || normalizedFormat.toLowerCase()}`;
  }
  return `video.${ext || "mp4"}`;
}

async function streamFileToResponse(filePath, res) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    let settled = false;

    const done = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    stream.on("error", done);
    res.on("error", done);
    res.on("finish", () => done());
    res.on("close", () => done());
    stream.pipe(res);
  });
}

function classifyYtDlpError(error) {
  const raw = stringifyError(error);
  const normalized = raw.toLowerCase();

  if (normalized.includes("failed to download standalone yt-dlp")) {
    return {
      status: 500,
      message: "Server failed to fetch standalone yt-dlp binary. Check network access during function runtime.",
    };
  }

  if (normalized.includes("python3") && normalized.includes("no such file or directory")) {
    return {
      status: 500,
      message: "Server runtime is missing Python and standalone yt-dlp fallback did not complete.",
    };
  }

  if (
    normalized.includes("enoent") &&
    (normalized.includes("yt-dlp") || normalized.includes("spawn"))
  ) {
    return {
      status: 500,
      message: "yt-dlp binary is unavailable in this deployment. Redeploy and verify install logs.",
    };
  }

  if (normalized.includes("permission denied") && (normalized.includes("yt-dlp") || normalized.includes("ffmpeg"))) {
    return {
      status: 500,
      message: "Execution permission error for yt-dlp/ffmpeg in server runtime.",
    };
  }

  if (normalized.includes("no space left on device") || normalized.includes("enospc")) {
    return {
      status: 507,
      message: "Server temporary storage is full. Try a lower quality or shorter video.",
    };
  }

  if (normalized.includes("timed out") || normalized.includes("function invocation timeout")) {
    return {
      status: 504,
      message: "Download timed out on server. Try lower quality or shorter video.",
    };
  }

  if (
    normalized.includes("http error 403") ||
    normalized.includes("status code: 403") ||
    normalized.includes("forbidden") ||
    normalized.includes("access denied")
  ) {
    return {
      status: 403,
      message: "YouTube denied access (403). Refresh cookies and retry.",
    };
  }

  if (normalized.includes("confirm you're not a bot") || normalized.includes("429")) {
    return {
      status: 429,
      message: "YouTube rate-limited this request. Retry later or use fresh cookies.",
    };
  }

  if (
    normalized.includes("video unavailable") ||
    normalized.includes("private video") ||
    normalized.includes("members-only") ||
    normalized.includes("this video is unavailable")
  ) {
    return {
      status: 404,
      message: "This video is unavailable for download.",
    };
  }

  return {
    status: 500,
    message: "Download failed",
  };
}

async function safeRm(targetPath) {
  try {
    await fsPromises.rm(targetPath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors.
  }
}

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
    const ytDlpFlags = buildYtDlpFlags({
      outputTemplate,
      normalizedFormat,
      quality,
      cookiePath,
    });

    await runYtDlp(normalizedUrl, ytDlpFlags);

    const finalOutputPath = await findOutputFile(tempDir);

    const mimeType = getMimeType(finalOutputPath, normalizedFormat);
    const filename = getResponseFilename(finalOutputPath, normalizedFormat);
    const stats = await fsPromises.stat(finalOutputPath);

    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", String(stats.size));

    await streamFileToResponse(finalOutputPath, res);
  } catch (error) {
    console.error("Download error:", error);
    const failure = classifyYtDlpError(error);

    if (!res.headersSent) {
      return res.status(failure.status).json({ error: failure.message });
    }

    if (!res.writableEnded) {
      res.end();
    }
  } finally {
    await safeRm(tempDir);
  }
}
