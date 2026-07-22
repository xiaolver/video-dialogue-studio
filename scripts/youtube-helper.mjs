import http from "node:http";
import { pathToFileURL } from "node:url";
import { extractTranscript } from "./youtube-helper-lib.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.YOUTUBE_HELPER_PORT || 3210);
const MAX_REQUEST_BYTES = 16 * 1024;
const DEFAULT_ORIGINS = [
  "https://dialogue.viagoing.com",
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
  return { browser, probe };
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

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    request.on("data", (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        rejected = true;
        reject(new Error("请求内容过大。"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (rejected) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("请求必须是有效 JSON。"));
      }
    });
    request.on("error", reject);
  });
}

export function createHelperServer({ browser } = {}) {
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
      sendJson(response, 200, { ok: true, service: "youtube-local-helper", browserCookies: browser || null }, origin);
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
    sendJson(response, 404, { error: "Not found" }, origin);
  });
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  if (options.probe) {
    const transcript = await extractTranscript(options.probe, { browser: options.browser });
    process.stdout.write(`${JSON.stringify({ ...transcript, text: `${transcript.text.slice(0, 180)}…` }, null, 2)}\n`);
    return;
  }
  const server = createHelperServer(options);
  server.listen(PORT, HOST, () => {
    process.stdout.write(`\nYouTube 本机字幕助手已启动：http://${HOST}:${PORT}\n`);
    process.stdout.write("请保持此窗口开启，然后在 https://dialogue.viagoing.com 生成文章。\n");
    if (options.browser) process.stdout.write(`已启用本机 ${options.browser} Cookie（Cookie 不会上传到云端）。\n`);
    else process.stdout.write("当前使用本机网络和公开字幕，不读取浏览器 Cookie。\n");
  });
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
