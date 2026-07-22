import type { TranscriptResult } from "./types";

const DEMO_VIDEO_ID = "xRh2sVcNXQ8";

const DEMO_TRANSCRIPT = `[00:00] 主持人：今天我们讨论 AI 革命最核心的商业问题：它会创造多大的市场，又会怎样改变软件产业？
[01:18] Mark：这轮变化并不只是模型能力提升。AI 已经借助互联网和云基础设施，拥有几乎即时触达全球用户的分发能力。
[03:42] 主持人：消费者为什么愿意付费？
[04:05] Mark：因为产品能直接替用户节省时间、提高产出，甚至帮助个人赚到更多钱。价值足够明确时，订阅模式会非常自然。
[07:31] Mark：企业市场会并存多种计费方式，包括按 token、按席位、按任务量，以及最终按创造的业务价值计费。
[11:08] 主持人：高昂的 GPU 成本会不会限制市场？
[11:42] Mark：短期供给紧张确实推高成本，但芯片、数据中心和推理软件都在快速改善。单位智能成本下降，反而会释放更多需求。
[15:20] Mark：我们正在看到收入快速上升与单位成本快速下降同时发生，这在新技术平台早期非常典型。
[19:16] 主持人：创业公司与大公司分别有什么机会？
[19:44] Mark：大公司掌握分发和数据，创业公司则能围绕新的工作流重做产品。胜负取决于谁能把模型能力转化为真正的用户价值。
[24:08] Mark：未来十年，消费者 AI、企业软件、云服务和数据中心会形成相互推动的智能经济。商业模式不会只有一种。
[28:32] 主持人：所以万亿美元问题的答案是什么？
[28:48] Mark：关键不是预测单一数字，而是理解成本曲线、需求弹性和价值捕获。智能越便宜、越普及，可被重新设计的行业就越多。`;

export class TranscriptError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "TranscriptError";
  }
}

export function parseYouTubeVideoId(input: string): string | null {
  const value = input.trim();
  if (/^[\w-]{11}$/.test(value)) return value;

  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    let id: string | null = null;

    if (host === "youtu.be") id = url.pathname.split("/").filter(Boolean)[0] ?? null;
    if (host.endsWith("youtube.com")) {
      if (url.pathname === "/watch") id = url.searchParams.get("v");
      if (url.pathname.startsWith("/shorts/") || url.pathname.startsWith("/embed/")) {
        id = url.pathname.split("/").filter(Boolean)[1] ?? null;
      }
    }

    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function extractBalancedJson(source: string, marker: string): unknown | null {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = source.indexOf("{", markerIndex + marker.length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  name?: { simpleText?: string; runs?: Array<{ text: string }> };
}

interface PlayerResponse {
  videoDetails?: { title?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] };
  };
  playabilityStatus?: { status?: string; reason?: string };
}

export interface Json3Caption {
  events?: Array<{
    tStartMs?: number;
    segs?: Array<{ utf8?: string }>;
  }>;
}

export function json3ToTranscript(payload: Json3Caption): string {
  return (payload.events ?? [])
    .map((event) => {
      const text = (event.segs ?? []).map((segment) => segment.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
      if (!text) return "";
      const totalSeconds = Math.floor((event.tStartMs ?? 0) / 1000);
      const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
      const seconds = (totalSeconds % 60).toString().padStart(2, "0");
      return `[${minutes}:${seconds}] ${text}`;
    })
    .filter(Boolean)
    .join("\n");
}

function pickCaptionTrack(tracks: CaptionTrack[]): CaptionTrack {
  const score = (track: CaptionTrack): number => {
    const lang = track.languageCode.toLowerCase();
    const languageScore = lang.startsWith("zh") ? 30 : lang.startsWith("en") ? 20 : 10;
    return languageScore + (track.kind === "asr" ? 0 : 2);
  };
  return [...tracks].sort((a, b) => score(b) - score(a))[0];
}

async function fetchLiveTranscript(videoId: string): Promise<TranscriptResult> {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}&hl=en`;
  const response = await fetch(watchUrl, {
    headers: {
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": "Mozilla/5.0 (compatible; VideoDialogueStudio/1.0)",
    },
    cf: { cacheTtl: 900, cacheEverything: true },
  });
  if (!response.ok) throw new TranscriptError("YouTube 页面暂时不可访问。", "YOUTUBE_UNAVAILABLE");

  const html = await response.text();
  const player = (extractBalancedJson(html, "ytInitialPlayerResponse") ?? {}) as PlayerResponse;
  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (!tracks.length) {
    const reason = player.playabilityStatus?.reason;
    throw new TranscriptError(reason || "该视频没有公开字幕，或 YouTube 要求验证码。", "CAPTIONS_UNAVAILABLE");
  }

  const track = pickCaptionTrack(tracks);
  const separator = track.baseUrl.includes("?") ? "&" : "?";
  const captionsResponse = await fetch(`${track.baseUrl}${separator}fmt=json3`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; VideoDialogueStudio/1.0)" },
  });
  if (!captionsResponse.ok) throw new TranscriptError("字幕轨道读取失败。", "CAPTION_FETCH_FAILED");

  const transcript = json3ToTranscript(await captionsResponse.json<Json3Caption>());
  if (!transcript) throw new TranscriptError("字幕轨道为空。", "EMPTY_CAPTIONS");

  return {
    videoId,
    title: player.videoDetails?.title || `YouTube 视频 ${videoId}`,
    language: track.languageCode,
    // Durable Object values are stored separately, but keeping the transcript
    // under ~120 KiB also leaves predictable headroom for UTF-8 content.
    text: transcript.slice(0, 40_000),
    source: "youtube",
  };
}

export async function getYouTubeTranscript(input: string): Promise<TranscriptResult> {
  const videoId = parseYouTubeVideoId(input);
  if (!videoId) throw new TranscriptError("请输入有效的 YouTube 视频链接。", "INVALID_URL");

  try {
    return await fetchLiveTranscript(videoId);
  } catch (error) {
    if (videoId === DEMO_VIDEO_ID) {
      return {
        videoId,
        title: "对话安德森：AI 革命的万亿美金之问",
        language: "zh-CN",
        text: DEMO_TRANSCRIPT,
        source: "demo",
      };
    }
    throw error;
  }
}
