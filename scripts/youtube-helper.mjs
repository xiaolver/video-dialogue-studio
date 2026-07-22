import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { extractAudioForTranscription, extractTranscript, NoCaptionsError } from "./youtube-helper-lib.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.YOUTUBE_HELPER_PORT || 3210);
const MAX_REQUEST_BYTES = 16 * 1024;
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);
const DEFAULT_ORIGINS = [
  "https://dialogue.viagoing.com",
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  "http://localhost:8787",
  "http://127.0.0.1:8787",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

function argumentsFrom(argv) {
  const browserIndex = argv.indexOf("--browser");
  const probeIndex = argv.indexOf("--probe");
  const probeAudioIndex = argv.indexOf("--probe-audio");
  const browser = browserIndex >= 0 ? argv[browserIndex + 1] : undefined;
  const probe = probeIndex >= 0 ? argv[probeIndex + 1] : undefined;
  const probeAudio = probeAudioIndex >= 0 ? argv[probeAudioIndex + 1] : undefined;
  if (browser && !["chrome", "edge", "firefox"].includes(browser)) {
    throw new Error("--browser 仅支持 chrome、edge 或 firefox。");
  }
  return { browser, probe, probeAudio, open: !argv.includes("--no-open") };
}

function allowedOrigins() {
  const extra = String(process.env.YOUTUBE_HELPER_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ORIGINS, ...extra]);
}

function corsHeaders(origin) {
  const headers = {
    "Cache-Control": "no-store",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Private-Network": "true",
    Vary: "Origin",
  };
  if (origin && allowedOrigins().has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function sendJson(response, status, payload, origin) {
  response.writeHead(status, { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readBody(request, maximumBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    request.on("data", (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maximumBytes) {
        rejected = true;
        reject(new Error("请求内容过大。"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (rejected) return;
      resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

async function readJson(request) {
  try {
    return JSON.parse((await readBody(request, MAX_REQUEST_BYTES)).toString("utf8"));
  } catch (error) {
    if (error instanceof Error && error.message === "请求内容过大。") throw error;
    throw new Error("请求必须是有效 JSON。");
  }
}

async function serveStatic(pathname, response) {
  const entry = STATIC_FILES.get(pathname);
  if (!entry) return false;
  const [fileName, contentType] = entry;
  const body = await readFile(new URL(`../public/${fileName}`, import.meta.url));
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
  return true;
}

export function createHelperServer({ browser, relayState } = {}) {
  return http.createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (origin && !allowedOrigins().has(origin)) {
      sendJson(response, 403, { error: "不允许的网页来源。" });
      return;
    }
    const url = new URL(request.url || "/", `http://${HOST}:${PORT}`);
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders(origin));
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        service: "youtube-local-helper",
        browserCookies: browser || null,
        relayConnected: relayState?.connected ?? false,
      }, origin);
      return;
    }
    if (request.method === "POST" && url.pathname === "/transcript") {
      try {
        const body = await readJson(request);
        const transcript = await extractTranscript(body?.videoUrl, { browser });
        sendJson(response, 200, transcript, origin);
      } catch (error) {
        sendJson(response, 422, { error: error instanceof Error ? error.message : "字幕提取失败。" }, origin);
      }
      return;
    }
    if (request.method === "GET" && await serveStatic(url.pathname, response)) return;
    sendJson(response, 404, { error: "Not found" }, origin);
  });
}

function openBrowser(url) {
  try {
    const child = process.platform === "win32"
      ? spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true })
      : process.platform === "darwin"
        ? spawn("open", [url], { detached: true, stdio: "ignore" })
        : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // The pairing URL is also printed for environments without a desktop.
  }
}

async function loadRelayProtocol() {
  let apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    try {
      const variables = await readFile(new URL("../.dev.vars", import.meta.url), "utf8");
      for (const rawLine of variables.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const separator = line.indexOf("=");
        if (separator < 1 || line.slice(0, separator).trim() !== "OPENAI_API_KEY") continue;
        apiKey = line.slice(separator + 1).trim().replace(/^(\"|')(.*)\1$/, "$2");
        break;
      }
    } catch {
      // Report the missing key below.
    }
  }
  if (!apiKey) throw new Error(".dev.vars 中缺少 OPENAI_API_KEY，本机助手无法连接线上 Worker。");
  return `helper-${createHash("sha256").update(apiKey).digest("hex")}`;
}

function connectCloudRelay({ protocol, browser, relayState }) {
  let retryDelay = 1_000;
  let extractionQueue = Promise.resolve();
  const endpoint = "wss://dialogue.viagoing.com/api/helper/connect";

  const connect = () => {
    if (typeof WebSocket === "undefined") {
      process.stderr.write("当前 Node.js 不支持 WebSocket，请升级到 Node.js 22+。\n");
      return;
    }
    const socket = new WebSocket(endpoint, protocol);
    socket.addEventListener("open", () => {
      relayState.connected = true;
      retryDelay = 1_000;
      process.stdout.write("本机助手已连接 Cloudflare 字幕中继。\n");
    });
    socket.addEventListener("message", (event) => {
      extractionQueue = extractionQueue.then(async () => {
        let payload;
        try { payload = JSON.parse(String(event.data)); } catch { return; }
        if (payload?.type !== "extract" || typeof payload.requestId !== "string") return;
        try {
          const transcript = await extractTranscript(payload.videoUrl, { browser });
          socket.send(JSON.stringify({ type: "result", requestId: payload.requestId, transcript }));
        } catch (error) {
          if (error instanceof NoCaptionsError) {
            try {
              process.stdout.write("视频没有公开字幕，正在下载并压缩音频交给 OpenAI 转写。\n");
              const audio = await extractAudioForTranscription(error.videoUrl, error.metadata, { browser: error.browser || browser });
              socket.send(JSON.stringify({ type: "audio", requestId: payload.requestId, audio }));
              return;
            } catch (audioError) {
              socket.send(JSON.stringify({
                type: "result",
                requestId: payload.requestId,
                error: audioError instanceof Error ? audioError.message : "音频转写准备失败。",
              }));
              return;
            }
          }
          socket.send(JSON.stringify({
            type: "result",
            requestId: payload.requestId,
            error: error instanceof Error ? error.message : "字幕提取失败。",
          }));
        }
      }).catch(() => {});
    });
    socket.addEventListener("close", () => {
      relayState.connected = false;
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30_000);
    });
    socket.addEventListener("error", () => {
      relayState.connected = false;
    });
  };
  connect();
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  if (options.probe) {
    const transcript = await extractTranscript(options.probe, { browser: options.browser });
    process.stdout.write(`${JSON.stringify({ ...transcript, text: `${transcript.text.slice(0, 180)}…` }, null, 2)}\n`);
    return;
  }
  if (options.probeAudio) {
    try {
      await extractTranscript(options.probeAudio, { browser: options.browser });
      throw new Error("该视频存在公开字幕，不需要音频兜底。");
    } catch (error) {
      if (!(error instanceof NoCaptionsError)) throw error;
      const audio = await extractAudioForTranscription(error.videoUrl, error.metadata, { browser: options.browser });
      process.stdout.write(`${JSON.stringify({
        videoId: audio.videoId,
        title: audio.title,
        duration: audio.duration,
        mimeType: audio.mimeType,
        audioBytes: Buffer.byteLength(audio.data, "base64"),
      }, null, 2)}\n`);
      return;
    }
  }
  const relayState = { connected: false };
  const relayProtocol = await loadRelayProtocol();
  const publicUrl = "https://dialogue.viagoing.com/";
  const server = createHelperServer({ ...options, relayState });
  server.listen(PORT, HOST, () => {
    process.stdout.write(`\nYouTube 本机字幕助手已启动：http://${HOST}:${PORT}\n`);
    process.stdout.write("请保持此窗口开启；所有网页和手机访问都会共用这个字幕助手。\n");
    if (options.browser) process.stdout.write(`已启用本机 ${options.browser} Cookie（Cookie 不会上传到云端）。\n`);
    else process.stdout.write("默认先读取公开字幕；遇到 429 或验证码时会自动尝试本机 Chrome、Edge 登录态。\n");
    connectCloudRelay({ protocol: relayProtocol, browser: options.browser, relayState });
    if (options.open) openBrowser(publicUrl);
  });
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
