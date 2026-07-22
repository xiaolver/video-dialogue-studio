import { describe, expect, it } from "vitest";
import { buildTranscriptParams, json3ToTranscript, parseYouTubeVideoId, transcriptEndpointToTranscript } from "../src/youtube";

describe("parseYouTubeVideoId", () => {
  it.each([
    ["https://www.youtube.com/watch?v=xRh2sVcNXQ8", "xRh2sVcNXQ8"],
    ["https://youtu.be/xRh2sVcNXQ8?t=20", "xRh2sVcNXQ8"],
    ["https://youtube.com/shorts/xRh2sVcNXQ8", "xRh2sVcNXQ8"],
    ["xRh2sVcNXQ8", "xRh2sVcNXQ8"],
  ])("parses %s", (input, expected) => expect(parseYouTubeVideoId(input)).toBe(expected));

  it("rejects non-YouTube URLs", () => expect(parseYouTubeVideoId("https://example.com/watch?v=xRh2sVcNXQ8")).toBeNull());
});

describe("json3ToTranscript", () => {
  it("joins segments and includes a stable timestamp", () => {
    expect(json3ToTranscript({ events: [{ tStartMs: 65_000, segs: [{ utf8: "Hello " }, { utf8: "world" }] }] }))
      .toBe("[01:05] Hello world");
  });
});

describe("YouTube transcript endpoint", () => {
  it("builds Android transcript params", () => {
    expect(buildTranscriptParams("dQw4w9WgXcQ", "en")).toBe(
      "CgtkUXc0dzlXZ1hjURIOQ2dBU0FtVnVHZ0ElM0QYASozZW5nYWdlbWVudC1wYW5lbC1zZWFyY2hhYmxlLXRyYW5zY3JpcHQtc2VhcmNoLXBhbmVsMAE4AUAB",
    );
    expect(buildTranscriptParams("dQw4w9WgXcQ", "en", true)).not.toBe(buildTranscriptParams("dQw4w9WgXcQ", "en"));
  });

  it("parses web and Android transcript segment text", () => {
    expect(transcriptEndpointToTranscript({ actions: [{ segments: [
      { transcriptSegmentRenderer: { startMs: "1200", snippet: { runs: [{ text: "Hello" }] } } },
      { transcriptSegmentRenderer: { startMs: "62000", snippet: { elementsAttributedString: { content: "World" } } } },
    ] }] })).toBe("[00:01] Hello\n[01:02] World");
  });
});
