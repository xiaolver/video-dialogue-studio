import type { TranscriptResult } from "./types";
import { parseYouTubeVideoId, TranscriptError } from "./youtube";

const MAX_TRANSCRIPT_LENGTH = 40_000;

interface LocalTranscriptInput {
  videoId?: unknown;
  title?: unknown;
  language?: unknown;
  text?: unknown;
  source?: unknown;
}

export function validateLocalTranscript(input: unknown, videoUrl: string): TranscriptResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TranscriptError("本机字幕数据格式无效。", "INVALID_LOCAL_TRANSCRIPT");
  }
  const value = input as LocalTranscriptInput;
  const expectedVideoId = parseYouTubeVideoId(videoUrl);
  const videoId = typeof value.videoId === "string" ? value.videoId.trim() : "";
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const language = typeof value.language === "string" ? value.language.trim() : "";
  const text = typeof value.text === "string" ? value.text.trim() : "";

  if (!expectedVideoId) throw new TranscriptError("请输入有效的 YouTube 视频链接。", "INVALID_URL");
  if (value.source !== "local-helper" || videoId !== expectedVideoId) {
    throw new TranscriptError("本机字幕与当前视频不匹配。", "INVALID_LOCAL_TRANSCRIPT");
  }
  if (!text || text.length > MAX_TRANSCRIPT_LENGTH) {
    throw new TranscriptError(`本机字幕必须为 1-${MAX_TRANSCRIPT_LENGTH} 字。`, "INVALID_LOCAL_TRANSCRIPT");
  }
  if (title.length > 300 || language.length > 40) {
    throw new TranscriptError("本机字幕元数据超出长度限制。", "INVALID_LOCAL_TRANSCRIPT");
  }

  return {
    videoId,
    title: title || `YouTube 视频 ${videoId}`,
    language: language || "unknown",
    text,
    source: "local-helper",
  };
}
