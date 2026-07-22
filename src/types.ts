export interface Env {
  ASSETS: Fetcher;
  GENERATION_CONTEXTS: DurableObjectNamespace;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  WEBSHARE_PROXY_URL?: string;
}

export interface TranscriptResult {
  videoId: string;
  title: string;
  language: string;
  text: string;
  source: "youtube" | "youtube-proxy" | "demo";
}

export interface ArticleSection {
  heading: string;
  body: string;
}

export interface StoredGeneration {
  id: string;
  createdAt: string;
  status: "generating" | "ready" | "failed";
  videoUrl: string;
  videoId: string;
  videoTitle: string;
  transcriptLanguage: string;
  transcriptSource: TranscriptResult["source"];
  transcript: string;
  instruction: string;
  article: string;
  sections: ArticleSection[];
  error?: string;
}

export interface FiveWOneH {
  who: string;
  what: string;
  when: string;
  where: string;
  why: string;
  how: string;
}
