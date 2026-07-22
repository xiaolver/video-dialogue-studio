import { connect } from "cloudflare:sockets";
import {
  concatBytes,
  isAllowedYouTubeHost,
  parseProxyUrl,
  parseRawHttpResponse,
} from "./proxy-http";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 12_000;
const READ_TIMEOUT_MS = 20_000;
const encoder = new TextEncoder();

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

export interface ProxyRequestOptions {
  method?: "GET" | "POST";
  headers?: HeadersInit;
  body?: string;
}

async function singleProxyRequest(target: URL, proxyValue: string, options: ProxyRequestOptions): Promise<Response> {
  if (target.protocol !== "https:" || !isAllowedYouTubeHost(target.hostname)) {
    throw new Error("TCP 代理仅允许访问 HTTPS YouTube 资源。");
  }
  const proxy = parseProxyUrl(proxyValue);
  const socket = connect(
    { hostname: proxy.hostname, port: proxy.port },
    { secureTransport: "off", allowHalfOpen: false },
  );

  try {
    await withTimeout(socket.opened, CONNECT_TIMEOUT_MS, "连接 Webshare 代理超时。");
    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();
    const method = options.method ?? "GET";
    const requestHeaders = new Headers(options.headers);
    requestHeaders.set("Host", target.hostname);
    requestHeaders.set("Connection", "close");
    requestHeaders.set("Proxy-Connection", "close");
    requestHeaders.set("Proxy-Authorization", proxyAuthorization(proxy.username, proxy.password));
    requestHeaders.set("Accept-Encoding", "identity");
    if (!requestHeaders.has("User-Agent")) requestHeaders.set("User-Agent", "Mozilla/5.0 (compatible; VideoDialogueStudio/1.0)");
    const bodyBytes = encoder.encode(options.body ?? "");
    if (bodyBytes.byteLength) requestHeaders.set("Content-Length", String(bodyBytes.byteLength));

    const serializedHeaders = [...requestHeaders].map(([name, value]) => `${name}: ${value}\r\n`).join("");
    const requestHead = encoder.encode(`${method} ${target.toString()} HTTP/1.1\r\n${serializedHeaders}\r\n`);
    await writer.write(concatBytes(bodyBytes.byteLength ? [requestHead, bodyBytes] : [requestHead]));
    writer.releaseLock();
    const raw = await readHttpResponse(reader);
    reader.releaseLock();
    await socket.close().catch(() => undefined);

    const parsed = parseRawHttpResponse(raw);
    if (parsed.status === 407) throw new Error("Webshare 代理认证失败，请检查用户名和密码。");
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
    await socket.close().catch(() => undefined);
    throw error;
  }
}

export async function webshareProxyFetch(
  input: string | URL,
  proxyValue: string,
  options: ProxyRequestOptions = {},
): Promise<Response> {
  let target = new URL(input.toString());
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response = await singleProxyRequest(target, proxyValue, options);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    target = new URL(location, target);
    if (!isAllowedYouTubeHost(target.hostname)) throw new Error("YouTube 重定向到了未允许的代理目标。");
  }
  throw new Error("YouTube 代理请求重定向次数过多。");
}
