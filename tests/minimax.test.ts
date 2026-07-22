import { afterEach, describe, expect, it, vi } from "vitest";
import { streamArticle, summarizeSection, transcribeAudio } from "../src/minimax";
import type { StoredGeneration, TranscriptResult } from "../src/types";

const transcript: TranscriptResult = {
  videoId: "xRh2sVcNXQ8",
  title: "测试视频",
  language: "zh-CN",
  text: "[00:00] 主持人：你好",
  source: "local-helper",
};

afterEach(() => vi.restoreAllMocks());

describe("MiniMax provider", () => {
  it("streams OpenAI-compatible chat completion deltas and ignores reasoning", async () => {
    const body = [
      'data: {"choices":[{"delta":{"reasoning_content":"内部思考"}}]}',
      'data: {"choices":[{"delta":{"content":"你好"}}]}',
      'data: {"choices":[{"delta":{"content":"，世界"}}]}',
      "data: [DONE]",
    ].join("\n\n") + "\n\n";
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));

    let output = "";
    for await (const delta of streamArticle(transcript, "面向初学者", "mini-test", "MiniMax-test")) output += delta;
    expect(output).toBe("你好，世界");
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0]).toBe("https://api.minimaxi.com/v1/chat/completions");
    const [, init] = request.mock.calls[0];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer mini-test");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "MiniMax-test",
      stream: true,
      reasoning_split: true,
    });
  });

  it("requests and parses JSON-only 5W1H output", async () => {
    const summary = { who: "甲", what: "主题", when: "现在", where: "线上", why: "需要", how: "讨论" };
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(summary)}\n\`\`\`` } }],
      base_resp: { status_code: 0, status_msg: "" },
    }));
    const generation: StoredGeneration = {
      id: "generation", createdAt: new Date().toISOString(), status: "ready",
      videoUrl: "https://youtu.be/xRh2sVcNXQ8", videoId: transcript.videoId,
      videoTitle: transcript.title, transcriptLanguage: transcript.language,
      transcriptSource: transcript.source, transcript: transcript.text, instruction: "",
      article: "# 标题\n\n## 章节\n内容", sections: [{ heading: "章节", body: "内容" }],
    };

    await expect(summarizeSection(generation, 0, "mini-test", "MiniMax-test")).resolves.toEqual(summary);
    const [, init] = request.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "MiniMax-test", stream: false, reasoning_split: true });
  });

  it("uses Cloudflare Whisper for compressed MP3 transcription", async () => {
    const run = vi.fn().mockResolvedValue({ text: "转写内容" });
    const audio = {
      videoId: transcript.videoId,
      title: transcript.title,
      duration: 12,
      mimeType: "audio/mpeg",
      data: btoa("fake mp3"),
    };

    await expect(transcribeAudio(audio, { run } as unknown as Ai)).resolves.toBe("转写内容");
    expect(run).toHaveBeenCalledWith("@cf/openai/whisper-large-v3-turbo", expect.objectContaining({
      audio: audio.data,
      task: "transcribe",
      vad_filter: true,
    }));
  });

  it("reports MiniMax rate limiting clearly", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: { message: "rate limit" } }, { status: 429 }));
    const generator = streamArticle(transcript, "", "mini-test", "MiniMax-test");
    await expect(generator.next()).rejects.toThrow("MiniMax 生成请求过于频繁");
  });
});
