const form = document.querySelector("#generate-form");
const videoInput = document.querySelector("#video-url");
const instructionInput = document.querySelector("#instruction");
const generateButton = document.querySelector("#generate-button");
const progressPanel = document.querySelector("#progress-panel");
const progressTitle = document.querySelector("#progress-title");
const progressDetail = document.querySelector("#progress-detail");
const progressBar = document.querySelector("#progress-bar");
const errorPanel = document.querySelector("#error-panel");
const errorMessage = document.querySelector("#error-message");
const resultShell = document.querySelector("#result-shell");
const articleElement = document.querySelector("#article");
const sourceBadge = document.querySelector("#source-badge");
const videoTitle = document.querySelector("#video-title");

const state = {
  markdown: "",
  generationId: "",
  complete: false,
  summaries: new Map(),
  loadingSummaries: new Set(),
  renderQueued: false,
};

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
    return `<div class="summary-card summary-loading"><span class="spinner"></span><span>正在结合全文梳理这一章…</span></div>`;
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
  progressBar.style.width = `${percent}%`;
}

function showError(message) {
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
  setProgress("正在获取字幕", "连接 YouTube 并选择最合适的字幕轨道", 16);

  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoUrl: videoInput.value, instruction: instructionInput.value }),
    });
    if (!response.ok) {
      const payload = await response.json();
      throw new Error(payload.error || "请求失败，请稍后再试。");
    }
    if (!response.body) throw new Error("浏览器不支持流式响应。");

    setProgress("字幕已就绪，正在构思", "文章会在下方实时出现", 38);
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
          sourceBadge.textContent = event.transcriptSource === "demo" ? "内置字幕" : "YouTube 字幕";
          sourceBadge.className = `source-badge ${event.transcriptSource === "demo" ? "is-demo" : ""}`;
          setProgress("正在流式撰写", event.provider === "gemini" ? "Gemini 正在组织章节与对话" : "演示模式 · 配置 API Key 后使用 Gemini", 62);
        } else if (event.type === "delta") {
          state.markdown += event.text;
          queueRender();
        } else if (event.type === "done") {
          state.complete = true;
          queueRender();
          setProgress("文章生成完成", `已整理为 ${event.sectionCount} 个章节，可点击 5W1H 继续探索`, 100);
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
    const response = await fetch("/api/summary", {
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
