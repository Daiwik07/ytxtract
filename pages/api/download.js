import ffmpegPath from "ffmpeg-static";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ytdlp from "yt-dlp-exec";

export const config = {
  api: {
    responseLimit: false,
  },
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

  try {
    const content = await fsPromises.readFile(cookiePath, "utf8");
    const cookies = parseCookieJson(content);
    if (cookies) {
      return { type: "json", cookies };
    }
    return { type: "netscape-file", cookiePath };
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
    return "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/bestvideo+bestaudio/best";
  }

  return `bestvideo[ext=mp4][height<=${maxHeight}]+bestaudio[ext=m4a]/best[ext=mp4][height<=${maxHeight}]/bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/best`;
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
  await ytdlp.exec(url, flags, {
    windowsHide: true,
    reject: true,
  });
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
  const raw = [error?.stderr, error?.shortMessage, error?.message]
    .filter(Boolean)
    .join("\n");
  const normalized = raw.toLowerCase();

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