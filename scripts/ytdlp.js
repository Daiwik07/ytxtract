#!/usr/bin/env node
/**
 * Downloads the correct yt-dlp standalone binary for the current platform
 * into ./bin/ so Vercel (and other serverless runtimes without Python) can
 * use it directly without a runtime network call.
 *
 * Run automatically via the "postinstall" npm hook.
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const RELEASE_BASE =
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/";

function getBinaryName() {
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

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) {
      return reject(new Error("Too many redirects"));
    }

    const proto = url.startsWith("https") ? https : http;

    proto
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(download(res.headers.location, dest, redirects + 1));
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }

        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
        file.on("error", (err) => {
          fs.unlink(dest, () => {});
          reject(err);
        });
      })
      .on("error", reject);
  });
}

async function main() {
  const binDir = path.join(__dirname, "..", "bin");
  fs.mkdirSync(binDir, { recursive: true });

  const binaryName = getBinaryName();
  const destPath = path.join(binDir, binaryName);

  // Skip if already present (e.g. local dev re-installs)
  if (fs.existsSync(destPath)) {
    console.log(`[download-ytdlp] Binary already exists at ${destPath}, skipping.`);
    return;
  }

  const url = RELEASE_BASE + binaryName;
  console.log(`[download-ytdlp] Downloading ${url} → ${destPath}`);

  try {
    await download(url, destPath);

    if (process.platform !== "win32") {
      fs.chmodSync(destPath, 0o755);
    }

    console.log("[download-ytdlp] Done.");
  } catch (err) {
    // Non-fatal: the API will fall back to the runtime download approach.
    console.warn(`[download-ytdlp] WARNING: Could not download yt-dlp binary: ${err.message}`);
    console.warn("[download-ytdlp] The API will attempt a runtime download as a fallback.");
  }
}

main();