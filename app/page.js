"use client";

import { useState } from "react";

const features = [
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-6 h-6">
        <path d="M13 10V3L4 14h7v7l9-11h-7z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    title: "Lightning Fast",
    desc: "Download at maximum speed with our optimised servers — no throttling, ever.",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-6 h-6">
        <rect x="2" y="3" width="20" height="14" rx="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M8 21h8M12 17v4" strokeLinecap="round" />
      </svg>
    ),
    title: "Any Format",
    desc: "Export as MP4, MKV, WebM, MP3, AAC, WAV, or FLAC — you choose the codec.",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-6 h-6">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    title: "100% Secure",
    desc: "No sign-up, no tracking, no stored data. Your downloads are completely private.",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-6 h-6">
        <circle cx="12" cy="12" r="10" strokeLinecap="round" />
        <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" strokeLinecap="round" />
      </svg>
    ),
    title: "All Platforms",
    desc: "Works on YouTube, Shorts, Playlists, and embedded videos across the web.",
  },
];

const qualities = ["4K Ultra HD", "1080p Full HD", "720p HD", "480p SD", "360p", "Audio Only"];
const formats = ["MP4", "MKV", "WebM", "MP3", "AAC", "WAV"];

const steps = [
  { num: "01", label: "Paste the URL", desc: "Copy any YouTube video link and paste it in the input above." },
  { num: "02", label: "Choose quality", desc: "Pick your preferred resolution and output format." },
  { num: "03", label: "Hit download", desc: "Click the button and your file starts downloading instantly." },
];

export default function YouTubeDownloaderPage() {
  const [url, setUrl] = useState("");
  const [quality, setQuality] = useState("1080p Full HD");
  const [format, setFormat] = useState("MP4");
  const [loading, setLoading] = useState(false);
  const [downloadLoading, setDownloadLoading] = useState(false);
  const [fetched, setFetched] = useState(false);
  const [error, setError] = useState("");

  const getYouTubeVideoId = (value) => {
    const raw = String(value || "").trim();
    if (!raw) {
      return null;
    }

    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

    try {
      const parsed = new URL(withScheme);
      const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();

      if (host === "youtu.be") {
        const id = parsed.pathname.split("/").filter(Boolean)[0] || "";
        return id.length === 11 ? id : null;
      }

      if (host === "youtube.com" || host.endsWith(".youtube.com")) {
        const watchId = parsed.searchParams.get("v") || "";
        if (watchId.length === 11) {
          return watchId;
        }

        const segments = parsed.pathname.split("/").filter(Boolean);
        if (segments.length >= 2) {
          const [kind, id] = segments;
          if (["shorts", "embed", "live", "v"].includes(kind) && id.length === 11) {
            return id;
          }
        }
      }
    } catch {
      return null;
    }

    return null;
  };

  const isValidYouTubeUrl = (val) => Boolean(getYouTubeVideoId(val));

  const handleAnalyse = () => {
    setError("");
    if (!url.trim()) { setError("Please paste a YouTube URL first."); return; }
    if (!isValidYouTubeUrl(url)) { setError("That doesn't look like a valid YouTube URL. Try again."); return; }
    setLoading(true);
    setTimeout(() => { setLoading(false); setFetched(true); }, 1800);
  };

  const handleDownload = async () => {
    setError("");

    if (!url.trim()) {
      setError("Please paste a YouTube URL first.");
      return;
    }

    if (!isValidYouTubeUrl(url)) {
      setError("That doesn't look like a valid YouTube URL. Try again.");
      return;
    }

    try {
      setDownloadLoading(true);

      const response = await fetch("/api/download", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url, quality, format }),
      });

      if (!response.ok) {
        let message = "Download failed. Please try again.";

        try {
          const payload = await response.json();
          message = payload.error || message;
        } catch {
          // Keep default message when response is not JSON.
        }

        throw new Error(message);
      }

      const blob = await response.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const contentDisposition = response.headers.get("Content-Disposition") || "";
      const filenameMatch = contentDisposition.match(/filename="?([^\";]+)"?/i);
      const filename = filenameMatch?.[1] || "video-download.mp4";

      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(objectUrl);
    } catch (downloadError) {
      setError(downloadError.message || "Download failed. Please try again.");
    } finally {
      setDownloadLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen text-white"
      style={{
        background: "linear-gradient(135deg, #0a0a0f 0%, #0f0f1a 40%, #0a0a0f 100%)",
        fontFamily: "'Syne', sans-serif",
      }}
    >
      {/* Google Font */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=DM+Sans:wght@300;400;500&display=swap');
        * { box-sizing: border-box; }
        .dm { font-family: 'DM Sans', sans-serif; }
        .glow-red { box-shadow: 0 0 40px rgba(220, 38, 38, 0.35), 0 0 80px rgba(220, 38, 38, 0.1); }
        .card-glass {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.07);
          backdrop-filter: blur(12px);
        }
        .btn-primary {
          background: linear-gradient(135deg, #dc2626, #b91c1c);
          transition: transform 0.15s ease, box-shadow 0.15s ease;
        }
        .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 8px 30px rgba(220,38,38,0.5); }
        .btn-primary:active { transform: translateY(0); }
        .input-url {
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          transition: border-color 0.2s;
        }
        .input-url:focus { outline: none; border-color: rgba(220,38,38,0.6); box-shadow: 0 0 0 3px rgba(220,38,38,0.12); }
        .quality-pill {
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.08);
          transition: all 0.15s;
          cursor: pointer;
        }
        .quality-pill:hover { border-color: rgba(220,38,38,0.4); background: rgba(220,38,38,0.08); }
        .quality-pill.active { background: rgba(220,38,38,0.15); border-color: rgba(220,38,38,0.7); color: #fca5a5; }
        .noise::before {
          content: '';
          position: fixed; inset: 0; pointer-events: none; z-index: 0;
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
          opacity: 0.4;
        }
        .section-label {
          font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase;
          color: rgba(220,38,38,0.8); font-family: 'DM Sans', sans-serif; font-weight: 500;
        }
        @keyframes pulse-ring {
          0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(220,38,38,0.4); }
          70% { transform: scale(1); box-shadow: 0 0 0 12px rgba(220,38,38,0); }
          100% { transform: scale(0.95); }
        }
        .pulse { animation: pulse-ring 2s infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .spin { animation: spin 0.8s linear infinite; }
        .grid-bg {
          position: fixed; inset: 0; pointer-events: none; z-index: 0;
          background-image: 
            linear-gradient(rgba(220,38,38,0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(220,38,38,0.03) 1px, transparent 1px);
          background-size: 60px 60px;
        }
      `}</style>

      <div className="noise" />
      <div className="grid-bg" />

      {/* NAV */}
      <nav className="relative z-10 flex items-center justify-between px-6 py-5 max-w-6xl mx-auto">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center pulse" style={{ background: "#dc2626" }}>
            <svg viewBox="0 0 24 24" fill="white" className="w-4 h-4">
              <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34V8.7a8.24 8.24 0 0 0 4.83 1.55V6.79a4.85 4.85 0 0 1-1.06-.1z"/>
            </svg>
          </div>
          <span className="font-bold text-lg tracking-tight">YTGrab</span>
        </div>
        <div className="hidden md:flex items-center gap-8 dm text-sm text-white/50">
          <a href="#" className="hover:text-white transition-colors">Features</a>
          <a href="#" className="hover:text-white transition-colors">How it works</a>
          <a href="#" className="hover:text-white transition-colors">FAQ</a>
        </div>
        <button className="dm text-sm px-4 py-2 rounded-full btn-primary font-medium hidden md:block">
          Get Started
        </button>
      </nav>

      {/* HERO */}
      <section className="relative z-10 max-w-4xl mx-auto px-6 pt-16 pb-12 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full mb-8 dm text-xs"
          style={{ background: "rgba(220,38,38,0.1)", border: "1px solid rgba(220,38,38,0.25)", color: "#fca5a5" }}>
          <span className="w-1.5 h-1.5 rounded-full bg-red-400 inline-block" />
          Free · No sign-up · Unlimited downloads
        </div>

        <h1 className="text-5xl md:text-7xl mb-6" style={{fontWeight:"700"}}
          >
          Download Any{" "}
          <span style={{
            background: "linear-gradient(90deg, #dc2626, #f87171)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}> <br />
            YouTube
          </span>
          <br />Video Instantly.
        </h1>

        <p className="dm text-white/50 text-lg md:text-xl max-w-xl mx-auto mb-12 leading-relaxed">
          Paste a link. Pick your quality. Download in seconds — MP4, MP3, 4K, and more.
          No account needed.
        </p>

        {/* MAIN CARD */}
        <div className="card-glass rounded-2xl p-6 md:p-8 glow-red text-left">
          {/* URL Input */}
          <div className="flex flex-col md:flex-row gap-3 mb-6">
            <div className="flex-1 relative">
              <div className="absolute left-4 top-1/2 -translate-y-1/2 text-white/30">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-5 h-5">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <input
                type="text"
                value={url}
                onChange={(e) => { setUrl(e.target.value); setFetched(false); setError(""); }}
                placeholder="https://www.youtube.com/watch?v=..."
                className="w-full pl-12 pr-4 py-4 rounded-xl text-white placeholder-white/25 input-url dm text-sm"
              />
            </div>
            <button
              onClick={handleAnalyse}
              disabled={loading}
              className="btn-primary px-8 py-4 rounded-xl font-semibold text-sm whitespace-nowrap flex items-center gap-2 justify-center"
            >
              {loading ? (
                <>
                  <svg className="w-4 h-4 spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round" />
                  </svg>
                  Analysing…
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                    <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" strokeLinecap="round" />
                  </svg>
                  Analyse
                </>
              )}
            </button>
          </div>

          {error && (
            <p className="dm text-red-400 text-sm mb-4 flex items-center gap-2">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 shrink-0">
                <circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" strokeLinecap="round" />
              </svg>
              {error}
            </p>
          )}

          {/* Video info mock */}
          {fetched && (
            <div className="mb-6 p-4 rounded-xl flex items-center gap-4"
              style={{ background: "rgba(220,38,38,0.07)", border: "1px solid rgba(220,38,38,0.2)" }}>
              <div className="w-20 h-14 rounded-lg shrink-0 flex items-center justify-center"
                style={{ background: "rgba(220,38,38,0.15)" }}>
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-7 h-7 text-red-400">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-sm truncate">Video detected · Ready to download</p>
                <p className="dm text-white/40 text-xs mt-1">Duration: 10:32 · 1080p available · HD audio</p>
              </div>
              <div className="ml-auto shrink-0">
                <span className="text-xs px-2 py-1 rounded-full dm" style={{ background: "rgba(52,211,153,0.15)", color: "#6ee7b7" }}>
                  ✓ Valid
                </span>
              </div>
            </div>
          )}

          {/* Quality + Format */}
          <div className="grid md:grid-cols-2 gap-6 mb-6">
            <div>
              <p className="section-label mb-3">Quality</p>
              <div className="flex flex-wrap gap-2">
                {qualities.map((q) => (
                  <button key={q} onClick={() => setQuality(q)}
                    className={`quality-pill text-xs dm px-3 py-1.5 rounded-full ${quality === q ? "active" : "text-white/50"}`}>
                    {q}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="section-label mb-3">Format</p>
              <div className="flex flex-wrap gap-2">
                {formats.map((f) => (
                  <button key={f} onClick={() => setFormat(f)}
                    className={`quality-pill text-xs dm px-3 py-1.5 rounded-full ${format === f ? "active" : "text-white/50"}`}>
                    {f}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Download CTA */}
          <button
            onClick={handleDownload}
            disabled={!fetched || downloadLoading}
            className="w-full py-4 rounded-xl font-bold text-base flex items-center justify-center gap-3 transition-all"
            style={{
              background: fetched && !downloadLoading
                ? "linear-gradient(135deg, #dc2626, #b91c1c)"
                : "rgba(255,255,255,0.05)",
              color: fetched && !downloadLoading ? "white" : "rgba(255,255,255,0.2)",
              cursor: fetched && !downloadLoading ? "pointer" : "not-allowed",
              boxShadow: fetched && !downloadLoading ? "0 8px 30px rgba(220,38,38,0.35)" : "none",
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" strokeLinecap="round" strokeLinejoin="round" />
              <polyline points="7 10 12 15 17 10" strokeLinecap="round" strokeLinejoin="round" />
              <line x1="12" y1="15" x2="12" y2="3" strokeLinecap="round" />
            </svg>
            {downloadLoading
              ? "Downloading..."
              : fetched
                ? `Download · ${quality} · ${format}`
                : "Analyse a URL to start downloading"}
          </button>
        </div>
      </section>

      {/* STATS */}
      <section className="relative z-10 max-w-4xl mx-auto px-6 py-8">
        <div className="grid grid-cols-3 gap-4">
          {[["50M+", "Downloads served"], ["4K", "Max resolution"], ["99.9%", "Uptime SLA"]].map(([val, lbl]) => (
            <div key={lbl} className="card-glass rounded-xl p-4 md:p-6 text-center">
              <p className="text-2xl md:text-4xl font-extrabold" style={{ color: "#f87171" }}>{val}</p>
              <p className="dm text-white/40 text-xs md:text-sm mt-1">{lbl}</p>
            </div>
          ))}
        </div>
      </section>

      {/* FEATURES */}
      <section className="relative z-10 max-w-4xl mx-auto px-6 py-16">
        <div className="text-center mb-12">
          <p className="section-label mb-3">Why YTGrab</p>
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight">Built different.</h2>
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          {features.map(({ icon, title, desc }) => (
            <div key={title} className="card-glass rounded-xl p-6 flex gap-4 items-start group"
              style={{ transition: "border-color 0.2s" }}
              onMouseEnter={e => e.currentTarget.style.borderColor = "rgba(220,38,38,0.3)"}
              onMouseLeave={e => e.currentTarget.style.borderColor = "rgba(255,255,255,0.07)"}>
              <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                style={{ background: "rgba(220,38,38,0.12)", color: "#f87171" }}>
                {icon}
              </div>
              <div>
                <p className="font-semibold text-sm mb-1">{title}</p>
                <p className="dm text-white/45 text-sm leading-relaxed">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="relative z-10 max-w-4xl mx-auto px-6 py-16">
        <div className="text-center mb-12">
          <p className="section-label mb-3">How it works</p>
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight">Three steps. Done.</h2>
        </div>
        <div className="grid md:grid-cols-3 gap-6">
          {steps.map(({ num, label, desc }) => (
            <div key={num} className="relative">
              <p className="text-6xl font-extrabold mb-4 select-none"
                style={{ color: "rgba(220,38,38,0.12)", letterSpacing: "-0.04em" }}>{num}</p>
              <h3 className="font-bold text-lg mb-2">{label}</h3>
              <p className="dm text-white/45 text-sm leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA BANNER */}
      <section className="relative z-10 max-w-4xl mx-auto px-6 pb-20">
        <div className="rounded-2xl p-8 md:p-12 text-center relative overflow-hidden"
          style={{ background: "linear-gradient(135deg, rgba(220,38,38,0.2), rgba(185,28,28,0.1))", border: "1px solid rgba(220,38,38,0.25)" }}>
          <div className="absolute inset-0 pointer-events-none"
            style={{
              background: "radial-gradient(ellipse at 50% 100%, rgba(220,38,38,0.15) 0%, transparent 70%)",
            }} />
          <h2 className="text-3xl md:text-5xl font-extrabold mb-4 relative z-10" style={{ letterSpacing: "-0.03em" }}>
            Start downloading for free.
          </h2>
          <p className="dm text-white/50 mb-8 relative z-10">No account, no limits. Just paste and go.</p>
          <button
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            className="btn-primary px-10 py-4 rounded-xl font-bold text-sm relative z-10 inline-flex items-center gap-2">
            Try it now — it&apos;s free
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path d="M5 12h14M12 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="relative z-10 border-t max-w-6xl mx-auto px-6 py-8"
        style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md flex items-center justify-center" style={{ background: "#dc2626" }}>
              <svg viewBox="0 0 24 24" fill="white" className="w-3 h-3">
                <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34V8.7a8.24 8.24 0 0 0 4.83 1.55V6.79a4.85 4.85 0 0 1-1.06-.1z"/>
              </svg>
            </div>
            <span className="font-bold text-sm">YTGrab</span>
          </div>
          <p className="dm text-white/30 text-xs text-center">
            © 2025 YTGrab. For personal use only. Respect copyright laws and YouTube&apos;s Terms of Service.
          </p>
          <div className="flex gap-6 dm text-xs text-white/30">
            <a href="#" className="hover:text-white/60 transition-colors">Privacy</a>
            <a href="#" className="hover:text-white/60 transition-colors">Terms</a>
            <a href="#" className="hover:text-white/60 transition-colors">Contact</a>
          </div>
        </div>
      </footer>
    </div>
  )
}