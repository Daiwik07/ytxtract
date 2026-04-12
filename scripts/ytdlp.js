#!/usr/bin/env node
/**
 * Downloads the correct yt-dlp standalone binary for the current platform
 * into ./bin/ at install time so Vercel (no Python) can use it directly.
 *
 * This script is intentionally non-fatal: if the download fails for any
 * reason the script exits 0 so `npm install` always succeeds.
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

function download(url, dest, redirects) {
  redirects = redirects || 0;
  return new Promise(function (resolve, reject) {
    if (redirects > 10) {
      return reject(new Error("Too many redirects"));
    }

    const proto = url.startsWith("https") ? https : http;

    proto
      .get(url, function (res) {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          return resolve(download(res.headers.location, dest, redirects + 1));
        }

        if (res.statusCode !== 200) {
          res.resume(); // drain so socket is released
          return reject(new Error("HTTP " + res.statusCode + " for " + url));
        }

        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on("finish", function () {
          file.close(function (closeErr) {
            if (closeErr) reject(closeErr);
            else resolve();
          });
        });
        file.on("error", function (err) {
          try { fs.unlinkSync(dest); } catch (_) {}
          reject(err);
        });
      })
      .on("error", reject);
  });
}

async function main() {
  const binDir = path.join(__dirname, "..", "bin");

  try {
    fs.mkdirSync(binDir, { recursive: true });
  } catch (err) {
    console.warn("[download-ytdlp] Could not create bin/ dir:", err.message);
    return; // non-fatal
  }

  const binaryName = getBinaryName();
  const destPath = path.join(binDir, binaryName);

  if (fs.existsSync(destPath)) {
    console.log("[download-ytdlp] Binary already exists at " + destPath + ", skipping.");
    return;
  }

  const url = RELEASE_BASE + binaryName;
  console.log("[download-ytdlp] Downloading " + url + " → " + destPath);

  try {
    await download(url, destPath);

    if (process.platform !== "win32") {
      fs.chmodSync(destPath, 0o755);
    }

    console.log("[download-ytdlp] Done.");
  } catch (err) {
    try { fs.unlinkSync(destPath); } catch (_) {}
    console.warn("[download-ytdlp] WARNING: Could not download yt-dlp binary:", err.message);
    console.warn("[download-ytdlp] The API will attempt a runtime download as a fallback.");
    // Do NOT re-throw — npm install must not fail.
  }
}

// Top-level catch: process always exits 0 regardless of what happens.
main().catch(function (err) {
  console.warn("[download-ytdlp] Unexpected error:", err.message);
  process.exit(0);
});