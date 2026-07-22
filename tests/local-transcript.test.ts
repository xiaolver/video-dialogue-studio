import { describe, expect, it } from "vitest";
import { validateLocalTranscript } from "../src/local-transcript";

describe("local transcript validation", () => {
  const videoUrl = "https://www.youtube.com/watch?v=xRh2sVcNXQ8";

  it("accepts a matching helper transcript", () => {
    expect(validateLocalTranscript({
      videoId: "xRh2sVcNXQ8",
      title: "Example",
      language: "en",
      text: "[00:00] Hello",
      source: "local-helper",
    }, videoUrl)).toMatchObject({ videoId: "xRh2sVcNXQ8", source: "local-helper" });
  });

  it("rejects transcripts for another video", () => {
    expect(() => validateLocalTranscript({
      videoId: "dQw4w9WgXcQ",
      title: "Wrong video",
      language: "en",
      text: "[00:00] Wrong",
      source: "local-helper",
    }, videoUrl)).toThrow("不匹配");
  });
});
