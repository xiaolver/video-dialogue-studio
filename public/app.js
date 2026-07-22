const form = document.querySelector("#generate-form");
const videoInput = document.querySelector("#video-url");
const instructionInput = document.querySelector("#instruction");
const generateButton = document.querySelector("#generate-button");
const progressPanel = document.querySelector("#progress-panel");
const progressTitle = document.querySelector("#progress-title");
const progressDetail = document.querySelector("#progress-detail");
const progressBar = document.querySelector("#progress-bar");
const progressEstimate = document.querySelector("#progress-estimate");
const progressElapsed = document.querySelector("#progress-elapsed");
const progressStageElements = new Map([...document.querySelectorAll("[data-progress-stage]")]
  .map((element) => [element.dataset.progressStage, element]));
const errorPanel = document.querySelector("#error-panel");
const errorMessage = document.querySelector("#error-message");
const resultShell = document.querySelector("#result-shell");
const articleElement = document.querySelector("#article");
const sourceBadge = document.querySelector("#source-badge");
const videoTitle = document.querySelector("#video-title");
const helperStatus = document.querySelector("#helper-status");
const helperStatusText = document.querySelector("#helper-status-text");
const helperRetry = document.querySelector("#helper-retry");

const isLoopbackHost = ["127.0.0.1", "localhost"].includes(window.location.hostname);
const isLocalHelperPage = isLoopbackHost && window.location.port === "3210";
const API_URL = isLocalHelperPage ? "https://dialogue.viagoing.com" : "";
const apiUrl = (path) => `${API_URL}${path}`;

const state = {
  markdown: "",
  generationId: "",
  complete: false,
  summaries: new Map(),
  loadingSummaries: new Set(),
  renderQueued: false,
  helperAvailable: false,
  progressStartedAt: 0,
  progressTimer: null,
  progressStage: "subtitle",
  progressPercent: 0,
  audioUsed: false,
};

function setHelperStatus(status, message) {
  state.helperAvailable = status === "ready";
  helperStatus.className = `helper-status is-${status}`;
  helperStatusText.textContent = message;
}

async function detectHelper() {
  setHelperStatus("checking", "正在检测共享字幕助手…");
  try {
    const response = await fetch(apiUrl("/api/helper/status"));
    const payload = await response.json();
    if (!response.ok || !payload.connected) throw new Error("not ready");
    setHelperStatus("ready", "共享字幕助手已连接");
    return true;
  } catch {
    setHelperStatus("error", "共享字幕助手未启动，将回退云端");
    return false;
  }
}

async function getLocalTranscript(videoUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6 * 60_000);
  try {
    const response = await fetch(apiUrl("/api/helper/extract"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoUrl }),
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "共享字幕助手提取失败。");
    return payload.transcript;
  } finally {
    clearTimeout(timeout);
  }
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function summaryMarkup(index) {
  if (state.loadingSummaries.has(index)) {
    return `<div class="summary-card summary-loading"><span class="spinner"></span><div><span>正在结合服务端保存的全文上下文梳理这一章…</span><small>预计 5～15 秒</small><span class="summary-progress"><span></span></span></div></div>`;
  }
  const summary = state.summaries.get(index);
  if (!summary) return "";
  const labels = [["Who", "谁", summary.who], ["What", "什么", summary.what], ["When", "何时", summary.when], ["Where", "何地", summary.where], ["Why", "为何", summary.why], ["How", "如何", summary.how]];
  return `<div class="summary-card"><div class="summary-kicker">5W1H · 章节速览</div><div class="summary-grid">${labels.map(([en, zh, text]) => `<div class="summary-item"><span><b>${en}</b>${zh}</span><p>${escapeHtml(text)}</p></div>`).join("")}</div></div>`;
}

function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const output = [];
  let paragraph = [];
  let listType = "";
  let sectionIndex = -1;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join(" ").trim();
    const dialogue = /^\*\*([^*：:]+[：:])\*\*\s*(.*)$/.exec(text);
    output.push(dialogue
      ? `<p class="dialogue"><strong>${escapeHtml(dialogue[1])}</strong><span>${inlineMarkdown(dialogue[2])}</span></p>`
      : `<p>${inlineMarkdown(text)}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!listType) return;
    output.push(`</${listType}>`);
    listType = "";
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const list = /^([-*]|\d+\.)\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph(); flushList();
      const level = heading[1].length;
      const text = inlineMarkdown(heading[2].replace(/\s*\[5W1H\]\s*$/i, ""));
      if (level === 2) {
        sectionIndex += 1;
        const disabled = state.complete ? "" : "disabled";
        output.push(`<section class="article-section"><div class="section-heading"><h2>${text}</h2><button class="summary-button" data-section-index="${sectionIndex}" ${disabled}><span>5W1H</span><svg viewBox="0 0 20 20"><path d="M10 3v14M3 10h14"/></svg></button></div>${summaryMarkup(sectionIndex)}`);
        if (sectionIndex > 0) output[output.length - 1] = `</section>${output[output.length - 1]}`;
      } else output.push(`<h${level}>${text}</h${level}>`);
    } else if (list) {
      flushParagraph();
      const nextType = list[1] === "-" || list[1] === "*" ? "ul" : "ol";
      if (listType !== nextType) { flushList(); listType = nextType; output.push(`<${listType}>`); }
      output.push(`<li>${inlineMarkdown(list[2])}</li>`);
    } else if (line.startsWith(">")) {
      flushParagraph(); flushList(); output.push(`<blockquote>${inlineMarkdown(line.slice(1).trim())}</blockquote>`);
    } else if (!line) {
      flushParagraph(); flushList();
    } else paragraph.push(line);
  }
  flushParagraph(); flushList();
  if (sectionIndex >= 0) output.push("</section>");
  return output.join("");
}

function queueRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    articleElement.innerHTML = renderMarkdown(state.markdown);
    state.renderQueued = false;
  });
}

function setProgress(title, detail, percent) {
  progressTitle.textContent = title;
  progressDetail.textContent = detail;
  state.progressPercent = Math.max(state.progressPercent, percent);
  progressBar.style.width = `${state.progressPercent}%`;
}

function formatElapsed(totalSeconds) {
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  return `${Math.floor(totalSeconds / 60)} 分 ${String(totalSeconds % 60).padStart(2, "0")} 秒`;
}

function setProgressStage(stage, { audioUsed = state.audioUsed } = {}) {
  state.progressStage = stage;
  state.audioUsed = audioUsed;
  const statuses = stage === "subtitle"
    ? { subtitle: "active", audio: "pending", article: "pending" }
    : stage === "article"
      ? { subtitle: "done", audio: audioUsed ? "done" : "skipped", article: "active" }
      : { subtitle: "done", audio: audioUsed ? "done" : "skipped", article: "done" };
  for (const [name, element] of progressStageElements) {
    element.classList.remove("is-active", "is-done", "is-skipped");
    const status = statuses[name];
    if (status && status !== "pending") element.classList.add(`is-${status}`);
  }
  progressEstimate.textContent = stage === "subtitle"
    ? "总计约 30 秒～3 分钟"
    : stage === "article" ? "预计剩余 20～60 秒" : "已完成";
}

function stopProgressClock() {
  if (state.progressTimer) clearInterval(state.progressTimer);
  state.progressTimer = null;
}

function startProgressClock() {
  stopProgressClock();
  state.progressStartedAt = Date.now();
  state.progressPercent = 0;
  state.audioUsed = false;
  progressElapsed.textContent = "已用时 0 秒";
  setProgressStage("subtitle");
  state.progressTimer = setInterval(() => {
    const seconds = Math.floor((Date.now() - state.progressStartedAt) / 1_000);
    progressElapsed.textContent = `已用时 ${formatElapsed(seconds)}`;
    const ceiling = state.progressStage === "subtitle" ? 32 : state.progressStage === "article" ? 94 : 100;
    if (state.progressPercent < ceiling) {
      state.progressPercent = Math.min(ceiling, state.progressPercent + Math.max(.35, (ceiling - state.progressPercent) * .025));
      progressBar.style.width = `${state.progressPercent}%`;
    }
  }, 1_000);
}

function showError(message) {
  stopProgressClock();
  errorMessage.textContent = message;
  errorPanel.hidden = false;
  progressPanel.hidden = true;
}

function resetResult() {
  state.markdown = "";
  state.generationId = "";
  state.complete = false;
  state.summaries.clear();
  state.loadingSummaries.clear();
  articleElement.innerHTML = "";
  resultShell.hidden = true;
  errorPanel.hidden = true;
}

async function generate(event) {
  event.preventDefault();
  resetResult();
  generateButton.disabled = true;
  generateButton.classList.add("is-loading");
  progressPanel.hidden = false;
  startProgressClock();
  setProgress("正在获取字幕", "连接 YouTube 并选择最合适的字幕轨道", 16);

  try {
    let localTranscript;
    let localError = "";
    if (state.helperAvailable || await detectHelper()) {
      setProgress("本机正在提取字幕", "没有公开字幕时会自动下载音频并由 OpenAI 转写", 16);
      try {
        localTranscript = await getLocalTranscript(videoInput.value);
        const audioTranscribed = localTranscript.language === "audio-transcription";
        state.audioUsed = audioTranscribed;
        setHelperStatus("ready", audioTranscribed ? "无字幕视频已完成 OpenAI 音频转写" : "本机字幕已提取，只向云端提交字幕文本");
        setProgress(audioTranscribed ? "音频转写已就绪" : "本机字幕已就绪", "正在安全提交文本并生成文章", 28);
      } catch (error) {
        localError = error instanceof Error ? error.message : "本机字幕提取失败。";
        setHelperStatus("error", `本机提取失败：${localError}`);
        setProgress("本机提取失败，正在回退云端", "将尝试 Worker 直连和 Webshare 代理池", 20);
      }
    }
    const response = await fetch(apiUrl("/api/generate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoUrl: videoInput.value, instruction: instructionInput.value, localTranscript }),
    });
    if (!response.ok) {
      const payload = await response.json();
      const message = payload.error || "请求失败，请稍后再试。";
      const helperHint = !state.helperAvailable && /YouTube|验证码|代理|字幕/.test(message)
        ? " 请在运行助手的电脑上执行 `npm run helper` 并保持窗口开启。"
        : "";
      const localDetail = localError ? ` 本机助手错误：${localError}` : "";
      throw new Error(`${message}${helperHint}${localDetail}`);
    }
    if (!response.body) throw new Error("浏览器不支持流式响应。");

    setProgress("字幕已就绪，正在构思", "文章会在下方实时出现", 38);
    setProgressStage("article", { audioUsed: state.audioUsed });
    resultShell.hidden = false;
    resultShell.scrollIntoView({ behavior: "smooth", block: "start" });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "meta") {
          state.generationId = event.generationId;
          videoTitle.textContent = event.videoTitle;
          sourceBadge.textContent = event.transcriptLanguage === "audio-transcription"
            ? "本机音频转写"
            : event.transcriptSource === "demo"
            ? "内置字幕"
            : event.transcriptSource === "youtube-proxy"
              ? "Webshare 代理字幕"
              : event.transcriptSource === "local-helper" ? "本机字幕" : "YouTube 字幕";
          sourceBadge.className = `source-badge ${event.transcriptSource === "demo" ? "is-demo" : event.transcriptSource === "youtube-proxy" ? "is-proxy" : event.transcriptSource === "local-helper" ? "is-local" : ""}`;
          setProgress("正在流式撰写", event.provider === "openai" ? "OpenAI GPT 正在组织章节与对话" : "演示模式 · 配置 API Key 后使用 OpenAI GPT", 62);
        } else if (event.type === "delta") {
          state.markdown += event.text;
          queueRender();
        } else if (event.type === "done") {
          state.complete = true;
          queueRender();
          setProgress("文章生成完成", `已整理为 ${event.sectionCount} 个章节，可点击 5W1H 继续探索`, 100);
          setProgressStage("done", { audioUsed: state.audioUsed });
          stopProgressClock();
          progressElapsed.textContent = `总用时 ${formatElapsed(Math.floor((Date.now() - state.progressStartedAt) / 1_000))}`;
          setTimeout(() => { progressPanel.hidden = true; }, 1300);
        } else if (event.type === "error") throw new Error(event.message);
      }
      if (done) break;
    }
  } catch (error) {
    showError(error instanceof Error ? error.message : "生成失败，请稍后再试。");
  } finally {
    generateButton.disabled = false;
    generateButton.classList.remove("is-loading");
  }
}

async function loadSummary(index, button) {
  if (!state.generationId || state.loadingSummaries.has(index)) return;
  if (state.summaries.has(index)) {
    button.closest(".article-section")?.querySelector(".summary-card")?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  state.loadingSummaries.add(index);
  queueRender();
  try {
    const response = await fetch(apiUrl("/api/summary"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generationId: state.generationId, sectionIndex: index }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "总结失败。");
    state.summaries.set(index, payload.summary);
  } catch (error) {
    showError(error instanceof Error ? error.message : "总结失败。");
  } finally {
    state.loadingSummaries.delete(index);
    queueRender();
  }
}

form.addEventListener("submit", generate);
document.querySelector("#sample-button").addEventListener("click", () => {
  videoInput.value = "https://www.youtube.com/watch?v=xRh2sVcNXQ8";
  instructionInput.focus();
});
document.querySelectorAll("[data-suggestion]").forEach((button) => button.addEventListener("click", () => {
  instructionInput.value = button.dataset.suggestion;
  instructionInput.focus();
}));
articleElement.addEventListener("click", (event) => {
  const button = event.target.closest(".summary-button");
  if (button) loadSummary(Number(button.dataset.sectionIndex), button);
});
helperRetry.addEventListener("click", detectHelper);
detectHelper();
