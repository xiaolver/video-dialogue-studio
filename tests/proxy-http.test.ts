import { describe, expect, it } from "vitest";
import { decodeChunkedBody, isAllowedYouTubeHost, parseProxyPool, parseProxyUrl, parseRawHttpResponse } from "../src/proxy-http";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("parseProxyUrl", () => {
  it("parses a standard authenticated HTTP proxy URL", () => {
    expect(parseProxyUrl("http://demo%40user:p%3Ass@1.2.3.4:4321")).toEqual({
      hostname: "1.2.3.4", port: 4321, username: "demo@user", password: "p:ss",
    });
  });

  it("parses Webshare's colon-separated export format", () => {
    expect(parseProxyUrl("1.2.3.4:4321:demo-user:secret:part")).toEqual({
      hostname: "1.2.3.4", port: 4321, username: "demo-user", password: "secret:part",
    });
  });

  it("rejects incomplete credentials", () => expect(() => parseProxyUrl("1.2.3.4:4321")).toThrow());

  it("rejects ports blocked or reserved by Cloudflare TCP sockets", () => {
    expect(() => parseProxyUrl("1.2.3.4:80:demo-user:secret")).toThrow(/非 25\/80\/443/);
    expect(() => parseProxyUrl("http://demo-user:secret@1.2.3.4:443")).toThrow(/非 25\/80\/443/);
  });
});

describe("parseProxyPool", () => {
  it("accepts comma and newline separated proxies and removes duplicates", () => {
    expect(parseProxyPool("one:1000:u:p,two:2000:u:p\none:1000:u:p")).toEqual([
      "one:1000:u:p",
      "two:2000:u:p",
    ]);
  });
});

describe("YouTube proxy target allowlist", () => {
  it("allows YouTube resources and rejects unrelated hosts", () => {
    expect(isAllowedYouTubeHost("www.youtube.com")).toBe(true);
    expect(isAllowedYouTubeHost("rr1---sn.googlevideo.com")).toBe(true);
    expect(isAllowedYouTubeHost("youtube.com.evil.example")).toBe(false);
    expect(isAllowedYouTubeHost("example.com")).toBe(false);
  });
});

describe("HTTP proxy response parsing", () => {
  it("decodes a chunked response", () => {
    expect(decoder.decode(decodeChunkedBody(encoder.encode("5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n"))))
      .toBe("hello world");
  });

  it("parses status, headers and content-length body", () => {
    const response = parseRawHttpResponse(encoder.encode("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nOKtrailing"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(decoder.decode(response.body)).toBe("OK");
  });
});
