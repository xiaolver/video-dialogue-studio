import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { extractTranscript } from "./youtube-helper-lib.mjs";

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
  const browser = browserIndex >= 0 ? argv[browserIndex + 1] : undefined;
  const probe = probeIndex >= 0 ? argv[probeIndex + 1] : undefined;
  if (browser && !["chrome", "edge", "firefox"].includes(browser)) {
    throw new Error("--browser 仅支持 chrome、edge 或 firefox。");
  }
  return { browser, probe, open: !argv.includes("--no-open") };
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
        relayToken: relayState?.token ?? null,
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

function connectCloudRelay({ token, browser, relayState }) {
  let retryDelay = 1_000;
  let extractionQueue = Promise.resolve();
  const endpoint = `wss://dialogue.viagoing.com/api/helper/connect?token=${encodeURIComponent(token)}`;

  const connect = () => {
    if (typeof WebSocket === "undefined") {
      process.stderr.write("当前 Node.js 不支持 WebSocket，请升级到 Node.js 22+。\n");
      return;
    }
    const socket = new WebSocket(endpoint);
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
  const relayState = { token: randomBytes(32).toString("hex"), connected: false };
  const pairingUrl = `https://dialogue.viagoing.com/#helper=${relayState.token}`;
  const server = createHelperServer({ ...options, relayState });
  server.listen(PORT, HOST, () => {
    process.stdout.write(`\nYouTube 本机字幕助手已启动：http://${HOST}:${PORT}\n`);
    process.stdout.write("请保持此窗口开启；线上页面会通过 Cloudflare 中继调用本机字幕。\n");
    process.stdout.write(`配对地址：${pairingUrl}\n`);
    if (options.browser) process.stdout.write(`已启用本机 ${options.browser} Cookie（Cookie 不会上传到云端）。\n`);
    else process.stdout.write("当前使用本机网络和公开字幕，不读取浏览器 Cookie。\n");
    connectCloudRelay({ token: relayState.token, browser: options.browser, relayState });
    if (options.open) openBrowser(pairingUrl);
  });
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
