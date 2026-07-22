import { describe, expect, it } from "vitest";
import {
  json3ToTranscript,
  parseYouTubeVideoId,
  pickCaption,
  vttToTranscript,
} from "../scripts/youtube-helper-lib.mjs";
import { createHelperServer } from "../scripts/youtube-helper.mjs";

describe("YouTube local helper", () => {
  it("accepts standard YouTube URLs and rejects unrelated hosts", () => {
    expect(parseYouTubeVideoId("https://www.youtube.com/watch?v=xRh2sVcNXQ8")).toBe("xRh2sVcNXQ8");
    expect(parseYouTubeVideoId("https://youtu.be/xRh2sVcNXQ8?t=3")).toBe("xRh2sVcNXQ8");
    expect(parseYouTubeVideoId("https://example.com/watch?v=xRh2sVcNXQ8")).toBeNull();
    expect(parseYouTubeVideoId("https://notyoutube.com/watch?v=xRh2sVcNXQ8")).toBeNull();
  });

  it("prefers manual Chinese JSON3 captions", () => {
    const picked = pickCaption({
      subtitles: {
        en: [{ ext: "json3", url: "https://www.youtube.com/en" }],
        "zh-Hans": [{ ext: "vtt", url: "https://www.youtube.com/zh-vtt" }, { ext: "json3", url: "https://www.youtube.com/zh" }],
      },
      automatic_captions: {
        "zh-Hans": [{ ext: "json3", url: "https://www.youtube.com/auto-zh" }],
      },
    });
    expect(picked.language).toBe("zh-Hans");
    expect(picked.automatic).toBe(false);
    expect(picked.format.ext).toBe("json3");
  });

  it("prefers manual English over automatically translated Chinese", () => {
    const picked = pickCaption({
      subtitles: { en: [{ ext: "json3", url: "https://www.youtube.com/manual-en" }] },
      automatic_captions: { "zh-Hans": [{ ext: "json3", url: "https://www.youtube.com/auto-zh" }] },
    });
    expect(picked.language).toBe("en");
    expect(picked.automatic).toBe(false);
  });

  it("converts JSON3 captions to timestamped plain text", () => {
    expect(json3ToTranscript({ events: [
      { tStartMs: 1_250, segs: [{ utf8: "Hello" }, { utf8: " world" }] },
      { tStartMs: 62_000, segs: [{ utf8: "Next" }] },
    ] })).toBe("[00:01] Hello world\n[01:02] Next");
  });

  it("converts VTT captions and removes markup", () => {
    const vtt = `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<c>Hello &amp; world</c>\n\n00:01:03.000 --> 00:01:05.000\nNext line`;
    expect(vttToTranscript(vtt)).toBe("[00:01] Hello & world\n[01:03] Next line");
  });

  it("exposes a loopback health endpoint with restricted CORS", async () => {
    const server = createHelperServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      const response = await fetch(`http://127.0.0.1:${address.port}/health`, {
        headers: { Origin: "https://dialogue.viagoing.com" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("https://dialogue.viagoing.com");
      expect(await response.json()).toMatchObject({ ok: true, service: "youtube-local-helper" });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
