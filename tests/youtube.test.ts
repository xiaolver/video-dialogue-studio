import { describe, expect, it } from "vitest";
import { json3ToTranscript, parseYouTubeVideoId } from "../src/youtube";

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
