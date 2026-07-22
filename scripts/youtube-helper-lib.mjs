import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_TRANSCRIPT_LENGTH = 40_000;

export function parseYouTubeVideoId(input) {
  const value = String(input ?? "").trim();
  if (/^[\w-]{11}$/.test(value)) return value;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    let id = null;
    if (host === "youtu.be") id = url.pathname.split("/").filter(Boolean)[0] ?? null;
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      if (url.pathname === "/watch") id = url.searchParams.get("v");
      if (url.pathname.startsWith("/shorts/") || url.pathname.startsWith("/embed/")) {
        id = url.pathname.split("/").filter(Boolean)[1] ?? null;
      }
    }
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function formatTimestamp(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  return `[${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}]`;
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function cleanCaptionText(value) {
  return decodeEntities(String(value ?? "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function json3ToTranscript(payload) {
  const lines = [];
  let lastText = "";
  for (const event of payload?.events ?? []) {
    const text = cleanCaptionText((event?.segs ?? []).map((segment) => segment?.utf8 ?? "").join(""));
    if (!text || text === lastText) continue;
    lastText = text;
    lines.push(`${formatTimestamp(event?.tStartMs)} ${text}`);
  }
  return lines.join("\n");
}

function vttTimestampToMilliseconds(value) {
  const parts = value.trim().replace(",", ".").split(":");
  if (parts.length < 2 || parts.length > 3) return 0;
  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop());
  const hours = parts.length ? Number(parts.pop()) : 0;
  if (![seconds, minutes, hours].every(Number.isFinite)) return 0;
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

export function vttToTranscript(vtt) {
  const blocks = String(vtt ?? "").replace(/\r/g, "").split(/\n{2,}/);
  const lines = [];
  let lastText = "";
  for (const block of blocks) {
    const rows = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timestampIndex = rows.findIndex((line) => line.includes("-->"));
    if (timestampIndex < 0) continue;
    const start = rows[timestampIndex].split("-->")[0].trim();
    const text = cleanCaptionText(rows.slice(timestampIndex + 1).join(" "));
    if (!text || text === lastText) continue;
    lastText = text;
    lines.push(`${formatTimestamp(vttTimestampToMilliseconds(start))} ${text}`);
  }
  return lines.join("\n");
}

function languageTier(language) {
  const value = language.toLowerCase();
  if (/^zh(?:-|$)/.test(value)) return "zh";
  if (/^en(?:-|$)/.test(value)) return "en";
  return "other";
}

function formatScore(format) {
  const ext = String(format?.ext ?? "").toLowerCase();
  if (ext === "json3") return 30;
  if (ext === "vtt") return 20;
  return 0;
}

export function pickCaption(metadata) {
  const candidates = [];
  for (const [language, formats] of Object.entries(metadata?.subtitles ?? {})) {
    for (const format of formats ?? []) candidates.push({ language, automatic: false, format });
  }
  for (const [language, formats] of Object.entries(metadata?.automatic_captions ?? {})) {
    for (const format of formats ?? []) candidates.push({ language, automatic: true, format });
  }
  return candidates
    .filter((candidate) => candidate?.format?.url && formatScore(candidate.format) > 0)
    .sort((a, b) => {
      const priority = (candidate) => {
        const tier = languageTier(candidate.language);
        const category = !candidate.automatic && tier === "zh" ? 500
          : !candidate.automatic && tier === "en" ? 400
            : candidate.automatic && tier === "zh" ? 300
              : candidate.automatic && tier === "en" ? 200
                : !candidate.automatic ? 150 : 100;
        return category + formatScore(candidate.format);
      };
      const scoreA = priority(a);
      const scoreB = priority(b);
      return scoreB - scoreA;
    })[0] ?? null;
}

function friendlyYtDlpError(error) {
  if (error?.code === "ENOENT") {
    return "未找到 yt-dlp。请先运行 `winget install yt-dlp.yt-dlp`，然后重新打开终端。";
  }
  const detail = String(error?.stderr || error?.message || "yt-dlp 执行失败").trim();
  if (/Sign in to confirm|not a bot|captcha/i.test(detail)) {
    return "本机网络也被 YouTube 要求验证。请先在浏览器正常打开视频，或使用 npm run helper:chrome 读取本机 Chrome 登录态。";
  }
  if (/HTTP Error 429|Too Many Requests/i.test(detail)) {
    return "本机网络读取该字幕时被 YouTube 限流（HTTP 429）。请稍后重试，或先在浏览器正常打开视频后使用 npm run helper:chrome。";
  }
  if (/no subtitles|does not have any subtitles/i.test(detail)) return "该视频没有可用的公开字幕。";
  return detail.split("\n").slice(-4).join("\n").slice(0, 800);
}

async function runYtDlp(videoUrl, { browser, binary = process.env.YT_DLP_BIN || "yt-dlp" } = {}) {
  const args = ["--dump-single-json", "--skip-download", "--no-warnings", "--socket-timeout", "20"];
  if (browser) args.push("--cookies-from-browser", browser);
  args.push(videoUrl);
  try {
    const { stdout } = await execFileAsync(binary, args, {
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: 12 * 1024 * 1024,
      windowsHide: true,
    });
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(friendlyYtDlpError(error));
  }
}

async function downloadCaption(videoUrl, caption, { browser, binary = process.env.YT_DLP_BIN || "yt-dlp" } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "youtube-helper-"));
  const extension = String(caption.format.ext).toLowerCase();
  const args = [
    "--skip-download",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs", caption.language,
    "--sub-format", extension,
    "--no-warnings",
    "--socket-timeout", "20",
    "--paths", directory,
    "--output", "caption.%(ext)s",
  ];
  if (browser) args.push("--cookies-from-browser", browser);
  args.push(videoUrl);
  try {
    await execFileAsync(binary, args, {
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    const files = await readdir(directory);
    const subtitleFile = files.find((file) => file.toLowerCase().endsWith(`.${extension}`));
    if (!subtitleFile) throw new Error("yt-dlp 没有生成字幕文件。");
    return await readFile(path.join(directory, subtitleFile), "utf8");
  } catch (error) {
    throw new Error(friendlyYtDlpError(error));
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export async function extractTranscript(videoUrl, options = {}) {
  const videoId = parseYouTubeVideoId(videoUrl);
  if (!videoId) throw new Error("请输入有效的 YouTube 视频链接。");
  const normalizedUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const metadata = await runYtDlp(normalizedUrl, options);
  const caption = pickCaption(metadata);
  if (!caption) throw new Error("该视频没有可用的公开字幕（当前支持 JSON3/VTT 字幕轨道）。");
  const raw = await downloadCaption(normalizedUrl, caption, options);
  let text;
  if (String(caption.format.ext).toLowerCase() === "json3") {
    try {
      text = json3ToTranscript(JSON.parse(raw));
    } catch {
      throw new Error("字幕 JSON3 格式解析失败。");
    }
  } else {
    text = vttToTranscript(raw);
  }
  if (!text) throw new Error("字幕轨道读取成功，但内容为空。");
  return {
    videoId,
    title: String(metadata.title || `YouTube 视频 ${videoId}`).slice(0, 300),
    language: String(caption.language || "unknown").slice(0, 40),
    text: text.slice(0, MAX_TRANSCRIPT_LENGTH),
    source: "local-helper",
  };
}
