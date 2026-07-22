import { connect } from "cloudflare:sockets";
import {
  concatBytes,
  findHeaderEnd,
  isAllowedYouTubeHost,
  parseProxyUrl,
  parseRawHttpResponse,
} from "./proxy-http";

const MAX_HEADER_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 12_000;
const READ_TIMEOUT_MS = 20_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readConnectResponse(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total <= MAX_HEADER_BYTES) {
    const { value, done } = await withTimeout(reader.read(), READ_TIMEOUT_MS, "Webshare CONNECT 响应超时。");
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
      const combined = concatBytes(chunks);
      const end = findHeaderEnd(combined);
      if (end >= 0) return decoder.decode(combined.slice(0, end));
    }
  }
  throw new Error("Webshare CONNECT 响应无效或过大。");
}

async function readHttpResponse(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total <= MAX_RESPONSE_BYTES) {
    const { value, done } = await withTimeout(reader.read(), READ_TIMEOUT_MS, "YouTube 代理响应读取超时。");
    if (done) return concatBytes(chunks);
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  throw new Error("YouTube 代理响应超过 8 MiB 限制。");
}

function proxyAuthorization(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

async function singleProxyRequest(target: URL, proxyValue: string, headers?: HeadersInit): Promise<Response> {
  if (target.protocol !== "https:" || !isAllowedYouTubeHost(target.hostname)) {
    throw new Error("TCP 代理仅允许访问 HTTPS YouTube 资源。");
  }
  const proxy = parseProxyUrl(proxyValue);
  const socket = connect(
    { hostname: proxy.hostname, port: proxy.port },
    { secureTransport: "starttls", allowHalfOpen: false },
  );
  let activeSocket = socket;

  try {
    await withTimeout(socket.opened, CONNECT_TIMEOUT_MS, "连接 Webshare 代理超时。");
    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();
    const authority = `${target.hostname}:443`;
    await writer.write(encoder.encode(
      `CONNECT ${authority} HTTP/1.1\r\n` +
      `Host: ${authority}\r\n` +
      `Proxy-Authorization: ${proxyAuthorization(proxy.username, proxy.password)}\r\n` +
      "Proxy-Connection: Keep-Alive\r\n\r\n",
    ));
    const connectHeaders = await readConnectResponse(reader);
    const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(connectHeaders)?.[1];
    reader.releaseLock();
    writer.releaseLock();
    if (status !== "200") {
      if (status === "407") throw new Error("Webshare 代理认证失败，请检查用户名和密码。");
      throw new Error(`Webshare CONNECT 失败（HTTP ${status ?? "unknown"}）。`);
    }

    const secureSocket = socket.startTls({ expectedServerHostname: target.hostname });
    activeSocket = secureSocket;
    await withTimeout(secureSocket.opened, CONNECT_TIMEOUT_MS, "YouTube TLS 握手超时。");
    const secureWriter = secureSocket.writable.getWriter();
    const secureReader = secureSocket.readable.getReader();
    const requestHeaders = new Headers(headers);
    requestHeaders.set("Host", target.hostname);
    requestHeaders.set("Connection", "close");
    requestHeaders.set("Accept-Encoding", "identity");
    if (!requestHeaders.has("User-Agent")) requestHeaders.set("User-Agent", "Mozilla/5.0 (compatible; VideoDialogueStudio/1.0)");

    const serializedHeaders = [...requestHeaders].map(([name, value]) => `${name}: ${value}\r\n`).join("");
    await secureWriter.write(encoder.encode(`GET ${target.pathname}${target.search} HTTP/1.1\r\n${serializedHeaders}\r\n`));
    secureWriter.releaseLock();
    const raw = await readHttpResponse(secureReader);
    secureReader.releaseLock();
    await secureSocket.close().catch(() => undefined);

    const parsed = parseRawHttpResponse(raw);
    const contentEncoding = parsed.headers.get("content-encoding")?.toLowerCase();
    if (contentEncoding && contentEncoding !== "identity") {
      throw new Error(`代理响应使用了不支持的压缩格式：${contentEncoding}`);
    }
    return new Response(parsed.body, {
      status: parsed.status,
      statusText: parsed.statusText,
      headers: parsed.headers,
    });
  } catch (error) {
    await activeSocket.close().catch(() => undefined);
    throw error;
  }
}

export async function webshareProxyFetch(input: string | URL, proxyValue: string, headers?: HeadersInit): Promise<Response> {
  let target = new URL(input.toString());
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response = await singleProxyRequest(target, proxyValue, headers);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    target = new URL(location, target);
    if (!isAllowedYouTubeHost(target.hostname)) throw new Error("YouTube 重定向到了未允许的代理目标。");
  }
  throw new Error("YouTube 代理请求重定向次数过多。");
}
