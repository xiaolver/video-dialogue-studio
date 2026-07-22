export interface ProxyConfig {
  hostname: string;
  port: number;
  username: string;
  password: string;
}

export interface ParsedHttpResponse {
  status: number;
  statusText: string;
  headers: Headers;
  body: Uint8Array;
}

const textDecoder = new TextDecoder();

function validateProxyPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("代理端口无效。");
  if ([25, 80, 443].includes(port)) {
    throw new Error("Cloudflare TCP Socket 不支持该代理端口，请在 Webshare 选择非 25/80/443 端口。");
  }
  return port;
}

export function parseProxyUrl(input: string): ProxyConfig {
  const value = input.trim();
  if (!value) throw new Error("Webshare 代理配置为空。");

  if (value.includes("://")) {
    const url = new URL(value);
    if (url.protocol !== "http:") throw new Error("WEBSHARE_PROXY_URL 必须使用 http:// 协议。");
    if (!url.hostname || !url.port || !url.username || !url.password) {
      throw new Error("代理 URL 必须包含主机、端口、用户名和密码。");
    }
    const port = validateProxyPort(Number(url.port));
    return {
      hostname: url.hostname,
      port,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  }

  const [hostname, portText, username, ...passwordParts] = value.split(":");
  const port = Number(portText);
  const password = passwordParts.join(":");
  if (!hostname || !Number.isInteger(port) || port < 1 || port > 65_535 || !username || !password) {
    throw new Error("代理配置应为 IP:端口:用户名:密码，或标准 http:// URL。");
  }
  return { hostname, port: validateProxyPort(port), username, password };
}

export function isAllowedYouTubeHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return ["youtube.com", "youtube-nocookie.com", "googlevideo.com"].some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function findHeaderEnd(bytes: Uint8Array): number {
  for (let i = 0; i <= bytes.length - 4; i += 1) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
  }
  return -1;
}

function findCrlf(bytes: Uint8Array, start: number): number {
  for (let i = start; i <= bytes.length - 2; i += 1) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) return i;
  }
  return -1;
}

export function decodeChunkedBody(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;

  while (offset < bytes.length) {
    const lineEnd = findCrlf(bytes, offset);
    if (lineEnd < 0) throw new Error("代理响应的 chunk size 不完整。");
    const sizeText = textDecoder.decode(bytes.slice(offset, lineEnd)).split(";", 1)[0].trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0) throw new Error("代理响应包含无效的 chunk size。");
    offset = lineEnd + 2;
    if (size === 0) return concatBytes(chunks);
    if (offset + size + 2 > bytes.length) throw new Error("代理响应的 chunk 数据不完整。");
    chunks.push(bytes.slice(offset, offset + size));
    offset += size;
    if (bytes[offset] !== 13 || bytes[offset + 1] !== 10) throw new Error("代理响应的 chunk 结尾无效。");
    offset += 2;
  }
  throw new Error("代理响应缺少结束 chunk。");
}

export function parseRawHttpResponse(raw: Uint8Array): ParsedHttpResponse {
  const headerEnd = findHeaderEnd(raw);
  if (headerEnd < 0) throw new Error("代理返回了无效的 HTTP 响应。");
  const headerText = textDecoder.decode(raw.slice(0, headerEnd));
  const lines = headerText.split("\r\n");
  const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/.exec(lines.shift() ?? "");
  if (!statusMatch) throw new Error("代理返回了无效的 HTTP 状态行。");

  const headers = new Headers();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }

  let body: Uint8Array<ArrayBufferLike> = raw.slice(headerEnd + 4);
  if (headers.get("transfer-encoding")?.toLowerCase().includes("chunked")) {
    body = decodeChunkedBody(body);
    headers.delete("transfer-encoding");
  } else {
    const contentLength = Number(headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength >= 0) {
      if (body.byteLength < contentLength) throw new Error("代理响应正文不完整。");
      body = body.slice(0, contentLength);
    }
  }
  headers.set("content-length", String(body.byteLength));
  return { status: Number(statusMatch[1]), statusText: statusMatch[2] ?? "", headers, body };
}
