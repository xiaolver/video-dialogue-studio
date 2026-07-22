import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = resolve(root, "node_modules", "wrangler", "bin", "wrangler.js");
const publicUrl = "https://dialogue.viagoing.com";

function fail(message) {
  console.error(`\n部署终止：${message}`);
  process.exit(1);
}

let localVars;

function loadLocalVars() {
  if (localVars) return localVars;
  const varsPath = resolve(root, ".dev.vars");
  if (!existsSync(varsPath)) {
    fail("未找到 .dev.vars。请复制 .dev.vars.example 并配置 GEMINI_API_KEY。");
  }
  localVars = new Map();
  for (const rawLine of readFileSync(varsPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    localVars.set(name, value);
  }
  return localVars;
}

function loadSecret(name, required = false) {
  const value = process.env[name]?.trim() || loadLocalVars().get(name)?.trim();
  if (required && !value) fail(`.dev.vars 中没有有效的 ${name}。`);
  return value;
}

function printWranglerResult(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function runWrangler(args, input, print = true) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: root,
    encoding: "utf8",
    input,
    windowsHide: false,
    env: process.env,
  });
  if (result.error) fail(result.error.message);
  const wrapped = {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
  if (print) printWranglerResult(wrapped);
  return wrapped;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function runWranglerWithRetry(args, input, attempts = 3) {
  let result;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = runWrangler(args, input, false);
    if (result.status === 0) {
      printWranglerResult(result);
      return result;
    }
    const transient = /timed out|fetch failed|connect timeout|network connectivity/i.test(result.output);
    if (!transient || attempt === attempts) {
      printWranglerResult(result);
      return result;
    }
    console.warn(`\nCloudflare 网络请求超时，正在重试（${attempt}/${attempts}）…`);
    sleep(2_500);
  }
  return result;
}

async function verifyDeployment(expectYoutubeProxy) {
  console.log(`\n[4/4] 验证 ${publicUrl}/api/health`);
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const response = await fetch(`${publicUrl}/api/health`, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) {
        const health = await response.json();
        if (health.mode === "gemini" && (!expectYoutubeProxy || health.youtubeProxy)) {
          console.log(`部署完成：${publicUrl}`);
          console.log(`运行模式：${health.mode}`);
          console.log(`YouTube 代理：${health.youtubeProxy ? `已启用（${health.youtubeProxyCount ?? 1} 个节点）` : "未配置"}`);
          return;
        }
      }
    } catch {
      // DNS and the custom-domain certificate may need a short propagation window.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000));
  }
  fail(`部署已提交，但 Gemini 或代理 Secret 暂未完成传播。请稍后再次运行健康检查。`);
}

if (!existsSync(wrangler)) fail("依赖尚未安装，请先运行 npm install。");
const geminiKey = loadSecret("GEMINI_API_KEY", true);
const webshareProxyUrls = loadSecret("WEBSHARE_PROXY_URLS") || loadSecret("WEBSHARE_PROXY_URL");

console.log("[1/4] 检查 Cloudflare 登录状态");
const identity = runWranglerWithRetry(["whoami"]);
if (/not authenticated/i.test(identity.output)) {
  console.log("\n尚未登录，正在启动 Cloudflare OAuth…");
  const login = runWrangler(["login"]);
  if (login.status !== 0) fail("Cloudflare 登录失败。");
}
if (identity.status !== 0 && !/not authenticated/i.test(identity.output)) {
  fail("无法连接 Cloudflare API 检查登录状态，请稍后重试。");
}

console.log("\n[2/4] 上传 Worker、静态资源和 Durable Object");
const deployment = runWranglerWithRetry(["deploy"]);
if (deployment.status !== 0) {
  if (/workers\.dev subdomain|code:\s*10063/i.test(deployment.output)) {
    fail("Cloudflare 账户尚未完成 Workers onboarding。请先打开 https://dash.cloudflare.com/?to=/:account/workers-and-pages 完成一次子域名注册，然后重新运行本命令。");
  }
  fail("Wrangler 部署失败，请查看上方错误信息。");
}

console.log("\n[3/4] 更新线上 Secrets");
const geminiSecret = runWranglerWithRetry(["secret", "put", "GEMINI_API_KEY"], `${geminiKey}\n`);
if (geminiSecret.status !== 0) fail("Worker 已部署，但 Gemini Secret 更新失败。");
if (webshareProxyUrls) {
  const proxySecret = runWranglerWithRetry(
    ["secret", "put", "WEBSHARE_PROXY_URLS"],
    `${webshareProxyUrls}\n`,
  );
  if (proxySecret.status !== 0) fail("Worker 已部署，但 Webshare Secret 更新失败。");
} else {
  console.log("未配置 WEBSHARE_PROXY_URLS，本次不更新线上 YouTube 代理 Secret。");
}

await verifyDeployment(Boolean(webshareProxyUrls));
