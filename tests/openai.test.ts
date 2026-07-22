import { afterEach, describe, expect, it, vi } from "vitest";
import { streamArticle, summarizeSection, transcribeAudio } from "../src/openai";
import type { StoredGeneration, TranscriptResult } from "../src/types";

const transcript: TranscriptResult = {
  videoId: "xRh2sVcNXQ8",
  title: "测试视频",
  language: "zh-CN",
  text: "[00:00] 主持人：你好",
  source: "local-helper",
};

afterEach(() => vi.restoreAllMocks());

describe("OpenAI provider", () => {
  it("streams Responses API text deltas", async () => {
    const body = [
      'data: {"type":"response.created"}',
      'data: {"type":"response.output_text.delta","delta":"你好"}',
      'data: {"type":"response.output_text.delta","delta":"，世界"}',
      'data: {"type":"response.completed"}',
    ].join("\n\n") + "\n\n";
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));

    let output = "";
    for await (const delta of streamArticle(transcript, "面向初学者", "sk-test", "gpt-test")) output += delta;
    expect(output).toBe("你好，世界");
    expect(request).toHaveBeenCalledOnce();
    const [, init] = request.mock.calls[0];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-test");
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "gpt-test", stream: true, store: false });
  });

  it("requests schema-constrained 5W1H output", async () => {
    const summary = { who: "甲", what: "主题", when: "现在", where: "线上", why: "需要", how: "讨论" };
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(summary) }] }],
    }));
    const generation: StoredGeneration = {
      id: "generation", createdAt: new Date().toISOString(), status: "ready",
      videoUrl: "https://youtu.be/xRh2sVcNXQ8", videoId: transcript.videoId,
      videoTitle: transcript.title, transcriptLanguage: transcript.language,
      transcriptSource: transcript.source, transcript: transcript.text, instruction: "",
      article: "# 标题\n\n## 章节\n内容", sections: [{ heading: "章节", body: "内容" }],
    };

    await expect(summarizeSection(generation, 0, "sk-test", "gpt-test")).resolves.toEqual(summary);
    const [, init] = request.mock.calls[0];
    const payload = JSON.parse(String(init?.body));
    expect(payload.text.format).toMatchObject({ type: "json_schema", name: "five_w_one_h", strict: true });
    expect(payload.text.format.schema.additionalProperties).toBe(false);
  });

  it("uploads compressed MP3 audio to the transcription endpoint", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ text: "转写内容" }));
    const audio = {
      videoId: transcript.videoId,
      title: transcript.title,
      duration: 12,
      mimeType: "audio/mpeg",
      data: btoa("fake mp3"),
    };

    await expect(transcribeAudio(audio, "sk-test", "gpt-transcribe-test")).resolves.toBe("转写内容");
    const [, init] = request.mock.calls[0];
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get("model")).toBe("gpt-transcribe-test");
  });
});
