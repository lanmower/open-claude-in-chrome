#!/usr/bin/env node

// gm-browser-verb: drop-in adapter for gm's `browser` spool verb
// (agentplug-host/src/browser.rs), backed by this repo's existing
// extension + native-messaging CDP path instead of a launched Chrome
// process.
//
// gm's contract (see ../gm/agentplug/.gm/config-source-cache-default/prose/browser.md
// and agentplug-host/src/browser.rs::run): watch <cwd>/.gm/exec-spool/in/browser/<N>.txt
// for a plain-text prefix-stacked body, evaluate it in a real page over CDP,
// write <cwd>/.gm/exec-spool/out/browser-<N>.json with the matching envelope.
//
// Known divergences from gm's Chrome-process-per-session model (see README):
//   - There is exactly one shared, already-running, always-headed Chromium
//     (the user's browser with the extension loaded) — "session" here means
//     a tab in the MCP tab group, not a spawned Chrome process.
//   - headless is inapplicable; there is no launch to make headless.
//   - viewport override reuses Emulation.setDeviceMetricsOverride the same
//     way resize_window already does.

import fs from "node:fs";
import path from "node:path";
import { init as runtimeInit, callTool } from "./tool-runtime.js";

const POLL_MS = 300;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 120000;

// --- Session table -----------------------------------------------------
// session_id -> { tabId, lastUsed, seenSessionIds (per cwd) }
const sessionsByCwdAndId = new Map(); // key: `${cwd}\0${sessionId}` -> { tabId, lastUsed }
const seenSessionIdsByCwd = new Map(); // cwd -> Set(sessionId)

function sessionKey(cwd, sessionId) {
  return `${cwd}\0${sessionId}`;
}

function browserStateDir(cwd) {
  return path.join(cwd, ".gm", "browser-state");
}

function sessionsStatePath(cwd) {
  return path.join(browserStateDir(cwd), "browser-sessions.json");
}

function persistSessions(cwd) {
  try {
    fs.mkdirSync(browserStateDir(cwd), { recursive: true });
    const out = {};
    for (const [key, val] of sessionsByCwdAndId) {
      if (!key.startsWith(cwd + "\0")) continue;
      out[key.slice(cwd.length + 1)] = { tabId: val.tabId, lastUsed: val.lastUsed };
    }
    fs.writeFileSync(sessionsStatePath(cwd), JSON.stringify(out));
  } catch {}
}

function loadConfig(cwd) {
  const p = path.join(cwd, ".gm", "browser-config.json");
  const defaults = {
    cdp_poll_timeout_ms: 1000,
    cdp_poll_interval_ms: 250,
    chrome_ready_deadline_ms: 30000,
    eval_timeout_grace_ms: 6000,
    headless: false, // inapplicable in this adapter; documented divergence
    session_idle_timeout_ms: 30 * 60 * 1000,
  };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    return { ...defaults, ...raw };
  } catch {
    return defaults;
  }
}

// --- Body grammar (mirrors browser.rs exactly, prefix-stacking order) --

function stripSessionIdPrefix(body) {
  const trimmed = body.replace(/^\s+/, "");
  if (!trimmed.startsWith("sessionId=")) return [null, body];
  const rest = trimmed.slice("sessionId=".length);
  const nl = rest.indexOf("\n");
  if (nl === -1) return [null, rest.trim() ? rest : ""];
  const id = rest.slice(0, nl).trim();
  const remainder = rest.slice(nl + 1);
  return [id || null, remainder];
}

function parseSessionCommand(body) {
  const trimmed = body.trim();
  if (trimmed === "session new" || trimmed.startsWith("session new\n")) return { cmd: "new" };
  if (trimmed === "session list" || trimmed.startsWith("session list\n")) return { cmd: "list" };
  if (trimmed.startsWith("session close ")) {
    const id = trimmed.slice("session close ".length).split("\n")[0].trim();
    return { cmd: "close", id };
  }
  if (trimmed.startsWith("session reset ")) {
    const id = trimmed.slice("session reset ".length).split("\n")[0].trim();
    return { cmd: "reset", id };
  }
  return { cmd: "none" };
}

function stripTimeoutPrefix(body) {
  const trimmed = body.replace(/^\s+/, "");
  if (!trimmed.startsWith("timeout=")) return [null, body];
  const rest = trimmed.slice("timeout=".length);
  const nl = rest.indexOf("\n");
  if (nl === -1) return [null, body];
  const numStr = rest.slice(0, nl);
  const remainder = rest.slice(nl + 1);
  const ms = parseInt(numStr.trim(), 10);
  if (Number.isNaN(ms)) return [null, body];
  return [ms, remainder];
}

function stripModePrefix(body) {
  const trimmed = body.replace(/^\s+/, "");
  const modePrefixes = [
    ["capture\n", "capture"],
    ["trace\n", "trace"],
    ["screenshot\n", "screenshot"],
  ];
  for (const [prefix, mode] of modePrefixes) {
    if (trimmed.startsWith(prefix)) return [mode, "", trimmed.slice(prefix.length)];
  }
  // profile / profile interval=<us> topN=<n>
  if (trimmed === "profile" || trimmed.startsWith("profile\n")) {
    return ["profile", "", trimmed === "profile" ? "" : trimmed.slice("profile\n".length)];
  }
  const profileParamsMatch = trimmed.match(/^profile((?: (?:interval|topN)=\S+)+)\n([\s\S]*)$/);
  if (profileParamsMatch) {
    return ["profile", profileParamsMatch[1].trim(), profileParamsMatch[2]];
  }
  if (trimmed.startsWith("dom=")) {
    const rest = trimmed.slice("dom=".length);
    const nl = rest.indexOf("\n");
    if (nl === -1) return ["dom", rest.trim(), ""];
    return ["dom", rest.slice(0, nl).trim(), rest.slice(nl + 1)];
  }
  return ["default", "", body];
}

function parseProfileParams(paramStr) {
  const out = { interval: 100, topN: 20 };
  if (!paramStr) return out;
  const intervalMatch = paramStr.match(/interval=(\d+)/);
  const topNMatch = paramStr.match(/topN=(\d+)/);
  if (intervalMatch) out.interval = parseInt(intervalMatch[1], 10);
  if (topNMatch) out.topN = parseInt(topNMatch[1], 10);
  return out;
}

function stripViewportPrefix(body) {
  const trimmed = body.replace(/^\s+/, "");
  if (!trimmed.startsWith("viewport=")) return [null, body];
  const rest = trimmed.slice("viewport=".length);
  const nl = rest.indexOf("\n");
  if (nl === -1) return [null, body];
  const spec = rest.slice(0, nl);
  const remainder = rest.slice(nl + 1);
  const mobile = spec.endsWith("!mobile");
  const dimsAndScale = mobile ? spec.slice(0, -"!mobile".length) : spec;
  const [dims, scaleStr] = dimsAndScale.split("@");
  const scale = scaleStr ? parseFloat(scaleStr.trim()) : 1.0;
  const dimsMatch = (dims || "").trim().match(/^(\d+)x(\d+)$/);
  if (!dimsMatch) return [null, body];
  const width = parseInt(dimsMatch[1], 10);
  const height = parseInt(dimsMatch[2], 10);
  if (width <= 0 || height <= 0) return [null, body];
  return [{ width, height, scale: Number.isNaN(scale) ? 1.0 : scale, mobile }, remainder];
}

function parseBody(body) {
  const trimmed = body.replace(/^\s+/, "");
  if (trimmed.startsWith("url=")) {
    const rest = trimmed.slice("url=".length);
    const nl = rest.indexOf("\n");
    if (nl === -1) return [rest.trim(), ""];
    return [rest.slice(0, nl).trim(), rest.slice(nl + 1)];
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const nl = trimmed.indexOf("\n");
    if (nl === -1) return [trimmed.trim(), "return {url: location.href};"];
    return [trimmed.slice(0, nl).trim(), trimmed.slice(nl + 1)];
  }
  return [null, body];
}

function looksLikeJsonObjectBody(body) {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

// --- Session management (tab-group backed) ------------------------------

async function ensureSession(cwd, sessionId) {
  const key = sessionKey(cwd, sessionId);
  const existing = sessionsByCwdAndId.get(key);
  if (existing) {
    // Verify the tab is still alive.
    try {
      const ctxRaw = await callTool("tabs_context_mcp", {});
      const ctxText = extractText(ctxRaw) || "{}";
      const ctx = JSON.parse(ctxText.split("\n\n")[0]);
      const alive = (ctx.availableTabs || []).some((t) => t.tabId === existing.tabId);
      if (alive) {
        existing.lastUsed = Date.now();
        return { tabId: existing.tabId, relaunched: false };
      }
      process.stderr.write(`[gm-browser-verb] session ${sessionId} tab ${existing.tabId} not in current group (${JSON.stringify(ctx.availableTabs)}); relaunching\n`);
    } catch (e) {
      process.stderr.write(`[gm-browser-verb] liveness check failed for session ${sessionId}: ${e.message}\n`);
    }
    sessionsByCwdAndId.delete(key);
  }

  const seen = seenSessionIdsByCwd.get(cwd) || new Set();
  const multiSessionWarning = seen.size >= 1 && !seen.has(sessionId);
  seen.add(sessionId);
  seenSessionIdsByCwd.set(cwd, seen);

  const wasTracked = !!existing;
  const ctxCreateRaw = await callTool("tabs_context_mcp", { createIfEmpty: true });
  const ctxCreateText = extractText(ctxCreateRaw) || "";
  if (ctxCreateText.startsWith("Error:")) {
    throw new Error(`gm-browser-verb: tabs_context_mcp failed: ${ctxCreateText.slice("Error:".length).trim()}`);
  }
  const createRaw = await callTool("tabs_create_mcp", {});
  const createText = extractText(createRaw) || "";
  if (createText.startsWith("Error:")) {
    throw new Error(`gm-browser-verb: tabs_create_mcp failed: ${createText.slice("Error:".length).trim()}`);
  }
  const m = createText.match(/Tab ID:\s*(\d+)/);
  const tabId = m ? parseInt(m[1], 10) : null;
  if (tabId == null) throw new Error(`gm-browser-verb: tabs_create_mcp did not return a tab id (response: ${createText.slice(0, 200)})`);

  sessionsByCwdAndId.set(key, { tabId, lastUsed: Date.now() });
  persistSessions(cwd);
  return { tabId, relaunched: wasTracked, multiSessionWarning };
}

function extractText(result) {
  const blocks = result?.content;
  if (!Array.isArray(blocks)) return null;
  return blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

async function sessionNew(cwd, sessionId) {
  const key = sessionKey(cwd, sessionId);
  const existing = sessionsByCwdAndId.get(key);
  if (existing) {
    try {
      await callTool("tabs_close_mcp", { tabId: existing.tabId });
    } catch {}
    sessionsByCwdAndId.delete(key);
  }
  try {
    const { tabId } = await ensureSession(cwd, sessionId);
    return { ok: true, stdout: "", exit_code: 0, stderr: "", session_id: sessionId, tabId };
  } catch (e) {
    return { ok: false, stdout: "", exit_code: 1, stderr: String(e && e.message || e) };
  }
}

function sessionList(cwd) {
  const out = [];
  for (const [key, val] of sessionsByCwdAndId) {
    if (!key.startsWith(cwd + "\0")) continue;
    const sessionId = key.slice(cwd.length + 1);
    out.push({
      session_id: sessionId,
      alive: true,
      idle_ms: Date.now() - val.lastUsed,
      tabId: val.tabId,
    });
  }
  return { ok: true, stdout: "", exit_code: 0, stderr: "", sessions: out };
}

async function sessionClose(cwd, targetSessionId, requireFound) {
  const key = sessionKey(cwd, targetSessionId);
  const existing = sessionsByCwdAndId.get(key);
  if (!existing) {
    if (requireFound) {
      return {
        ok: false, stdout: "", exit_code: 1,
        stderr: `no live session found for id '${targetSessionId}'`,
        session_id: targetSessionId, closed: false,
      };
    }
    return { ok: true, stdout: "", exit_code: 0, stderr: "", session_id: targetSessionId, closed: false };
  }
  try {
    await callTool("tabs_close_mcp", { tabId: existing.tabId });
  } catch {}
  sessionsByCwdAndId.delete(key);
  persistSessions(cwd);
  return { ok: true, stdout: "", exit_code: 0, stderr: "", session_id: targetSessionId, closed: true };
}

// --- Idle reaper ---------------------------------------------------------

function startIdleReaper(cwd, cfg) {
  setInterval(async () => {
    const timeout = cfg.session_idle_timeout_ms;
    for (const [key, val] of Array.from(sessionsByCwdAndId)) {
      if (!key.startsWith(cwd + "\0")) continue;
      if (Date.now() - val.lastUsed <= timeout) continue;
      try {
        await callTool("tabs_close_mcp", { tabId: val.tabId });
      } catch {}
      sessionsByCwdAndId.delete(key);
    }
    persistSessions(cwd);
    await sweepUntrackedTabs();
  }, Math.min(cfg.session_idle_timeout_ms, 60000)).unref();
}

// Every tab this adapter has ever created lives in the extension's single
// MCP tab group (shared across every session/cwd this process drives, since
// there is one extension instance). A crash, a bug in the liveness check
// (real one fixed live 2026-08-06 -- extractText() on tabs_context_mcp's
// response included trailing human-readable text after the JSON, breaking
// JSON.parse and silently discarding session tracking every dispatch, so
// EVERY dispatch created a fresh tab instead of reusing one), or simply this
// process restarting without a matching tabs_close_mcp sweep all leave a tab
// with no corresponding entry in sessionsByCwdAndId. Reconcile by closing
// every group tab that isn't presently tracked.
async function sweepUntrackedTabs() {
  try {
    const ctxRaw = await callTool("tabs_context_mcp", {});
    const ctxText = extractText(ctxRaw) || "";
    if (!ctxText.startsWith("{")) return; // "No MCP tab group exists." -- nothing to sweep
    const ctx = JSON.parse(ctxText.split("\n\n")[0]);
    const tracked = new Set(Array.from(sessionsByCwdAndId.values()).map((v) => v.tabId));
    const stray = (ctx.availableTabs || []).map((t) => t.tabId).filter((id) => !tracked.has(id));
    if (stray.length === 0) return;
    process.stderr.write(`[gm-browser-verb] sweeping ${stray.length} untracked tab(s): ${JSON.stringify(stray)}\n`);
    await callTool("tabs_close_mcp", { tabIds: stray });
  } catch (e) {
    process.stderr.write(`[gm-browser-verb] sweepUntrackedTabs failed: ${e.message}\n`);
  }
}

// --- Eval primitive --------------------------------------------------

async function evalInPage(tabId, script, timeoutMs) {
  const wrapped = `(async () => { ${script} })()`;
  const evalPromise = callTool("javascript_tool", {
    action: "javascript_exec",
    text: wrapped,
    tabId,
  });
  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve({ __timedOut: true }), timeoutMs)
  );
  const raced = await Promise.race([evalPromise, timeoutPromise]);
  if (raced && raced.__timedOut) return { timedOut: true };
  const text = extractText(raced) || "";
  if (text.startsWith("Error:")) return { error: text.slice("Error:".length).trim() };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { value: text === "undefined" ? undefined : text };
  }
}

async function snapshotDebug(tabId) {
  try {
    const consoleRaw = await callTool("read_console_messages", { tabId, pattern: ".*", limit: 50, clear: true });
    const consoleText = extractText(consoleRaw) || "";
    const consoleLines = consoleText.startsWith("No console")
      ? []
      : consoleText.split("\n").slice(1).filter(Boolean).slice(0, 50);

    const netRaw = await callTool("read_network_requests", { tabId, limit: 30, clear: true });
    const netText = extractText(netRaw) || "";
    const netLines = netText.startsWith("No network")
      ? []
      : netText.split("\n").slice(1).filter(Boolean).slice(0, 30);

    const glRaw = await evalInPage(
      tabId,
      "return JSON.stringify({errors: Object.values(window.__gmGlErrors||{}), drawCalls: window.__gmGlDrawCalls||{}, errorTotalCount: window.__gmGlErrorTotalCount||0});",
      5000
    );
    let gl = { errors: [], drawCalls: {}, errorTotalCount: 0 };
    try {
      if (glRaw && glRaw.value) gl = JSON.parse(glRaw.value);
    } catch {}

    return { console: consoleLines, pageErrors: [], network: netLines, performance: null, gl };
  } catch {
    return { console: [], pageErrors: [], network: [], performance: null, gl: { errors: [], drawCalls: {}, errorTotalCount: 0 } };
  }
}

const GL_INIT_SCRIPT = `
(() => {
  const MAX_SIGNATURES = 40;
  window.__gmGlErrors = window.__gmGlErrors || {};
  window.__gmGlDrawCalls = window.__gmGlDrawCalls || {};
  window.__gmGlErrorTotalCount = window.__gmGlErrorTotalCount || 0;
  window.__gmGlLastDrainedError = null;
  const drawFns = ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced'];
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const gl = origGetContext.call(this, type, ...rest);
    if (!gl || (!/^webgl/.test(type) && type !== 'experimental-webgl')) return gl;
    for (const fnName of drawFns) {
      const orig = gl[fnName];
      if (typeof orig !== 'function' || orig.__gmWrapped) continue;
      const wrapped = function (...args) {
        const result = orig.apply(this, args);
        window.__gmGlDrawCalls[fnName] = (window.__gmGlDrawCalls[fnName] || 0) + 1;
        const err = gl.getError();
        window.__gmGlLastDrainedError = err;
        if (err !== gl.NO_ERROR) {
          window.__gmGlErrorTotalCount += 1;
          const mode = args[0];
          const isArrays = fnName === 'drawArrays' || fnName === 'drawArraysInstanced';
          const count = isArrays ? args[2] : args[1];
          const instanceCount = isArrays ? args[3] : args[4];
          const sig = fnName + '|' + err + '|' + mode + '|' + count + '|' + (instanceCount || 0);
          const existing = window.__gmGlErrors[sig];
          if (existing) {
            existing.occurrenceCount += 1;
            existing.lastDrawCallIndex = window.__gmGlDrawCalls[fnName];
          } else if (Object.keys(window.__gmGlErrors).length < MAX_SIGNATURES) {
            window.__gmGlErrors[sig] = {
              fn: fnName, error: err, mode, count, instanceCount: instanceCount || 0,
              occurrenceCount: 1, lastDrawCallIndex: window.__gmGlDrawCalls[fnName],
              stack: new Error().stack,
            };
          }
        }
        return result;
      };
      wrapped.__gmWrapped = true;
      gl[fnName] = wrapped;
    }
    return gl;
  };
})();
`;

async function installGlTracking(tabId) {
  try {
    await callTool("_gm_cdp_raw", {
      tabId,
      method: "Page.addScriptToEvaluateOnNewDocument",
      params: { source: GL_INIT_SCRIPT },
    });
  } catch {}
}

async function maybeNavigate(tabId, url) {
  if (!url) return;
  await callTool("navigate", { url, tabId });
}

function defaultDebug() {
  return { console: [], pageErrors: [], network: [], performance: null, gl: { errors: [], drawCalls: {}, errorTotalCount: 0 } };
}

// --- Mode handlers -----------------------------------------------------

async function runDefault(tabId, url, script, timeoutMs) {
  await installGlTracking(tabId);
  await maybeNavigate(tabId, url);
  const evalResult = await evalInPage(tabId, script, timeoutMs);
  const debug = await snapshotDebug(tabId);
  if (evalResult.timedOut) return { ok: false, timed_out: true, stderr: "eval timed out", debug };
  if (evalResult.error) return { ok: false, stderr: evalResult.error, result: null, debug };
  return { ok: true, result: evalResult.value ?? null, debug };
}

async function runDom(tabId, selector, url) {
  await maybeNavigate(tabId, url);
  const domScript = `
    try {
      const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).slice(0, 20);
      return els.map((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const attrs = {};
        for (const a of el.attributes) attrs[a.name] = a.value;
        return {
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().slice(0, 200),
          attrs,
          visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      });
    } catch (e) {
      return { __domError: String(e && e.message || e) };
    }
  `;
  const evalResult = await evalInPage(tabId, domScript, 20000);
  const debug = await snapshotDebug(tabId);
  if (evalResult.timedOut) return { ok: false, timed_out: true, stderr: "dom eval timed out", selector, match_count: 0, elements: [], debug };
  if (evalResult.error) return { ok: false, stderr: evalResult.error, selector, match_count: 0, elements: [], debug };
  const value = evalResult.value;
  if (value && value.__domError) {
    return { ok: true, selector, match_count: 0, elements: [], result: { error: value.__domError }, debug };
  }
  const elements = Array.isArray(value) ? value : [];
  return { ok: true, selector, match_count: elements.length, elements, debug };
}

async function runScreenshot(cwd, tabId, url, script, timeoutMs) {
  await maybeNavigate(tabId, url);
  const evalResult = await evalInPage(tabId, script, timeoutMs);
  const debug = await snapshotDebug(tabId);
  if (evalResult.timedOut) return { ok: false, timed_out: true, stderr: "eval timed out", debug };
  if (evalResult.error) return { ok: false, stderr: evalResult.error, result: null, debug };

  const shotRaw = await callTool("computer", { action: "screenshot", tabId });
  const imageBlock = (shotRaw.content || []).find((b) => b.type === "image");
  if (!imageBlock) {
    return { ok: true, result: evalResult.value ?? null, screenshot_error: "no screenshot image returned", debug };
  }
  const dir = path.join(cwd, ".gm", "witness");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `screenshot-${Date.now()}.jpg`);
  fs.writeFileSync(filePath, Buffer.from(imageBlock.data, "base64"));
  return { ok: true, result: evalResult.value ?? null, screenshot_path: filePath, debug };
}

async function runProfile(cwd, tabId, url, script, timeoutMs, params) {
  // Navigate BEFORE starting the profiler: a top-level chrome.tabs.update
  // navigation (unlike an in-page CDP Page.navigate on a stable target)
  // resets the renderer's execution context and silently discards any
  // Profiler session started against the pre-navigation context -- observed
  // live (2026-08-06) as a real dispatch succeeding with a non-empty eval
  // result but profile:{timeframe:null,culprits:[]} every time navigation
  // happened after Profiler.start. Starting the profiler AFTER navigation
  // means gm's own documented behavior (sampling init/script-parse too) is
  // not reproduced here -- a named, accepted divergence, not silently lost.
  await maybeNavigate(tabId, url);
  try {
    await callTool("_gm_cdp_raw", { tabId, method: "Profiler.enable", params: {} });
    await callTool("_gm_cdp_raw", { tabId, method: "Profiler.setSamplingInterval", params: { interval: params.interval } });
    await callTool("_gm_cdp_raw", { tabId, method: "Profiler.start", params: {} });
  } catch (e) {
    return { ok: false, stderr: `profiler start failed: ${e.message}`, profile: { timeframe: null, culprits: [] }, debug: defaultDebug() };
  }

  const evalResult = await evalInPage(tabId, script, timeoutMs);

  let stopRes;
  try {
    const raw = await callTool("_gm_cdp_raw", { tabId, method: "Profiler.stop", params: {} });
    stopRes = JSON.parse(extractText(raw) || "null");
  } catch {
    stopRes = null;
  }
  const debug = await snapshotDebug(tabId);
  if (evalResult.timedOut) return { ok: false, timed_out: true, stderr: "eval timed out", profile: { timeframe: null, culprits: [] }, debug };
  if (evalResult.error) return { ok: false, stderr: evalResult.error, profile: { timeframe: null, culprits: [] }, debug };

  const agg = aggregateCpuProfile(stopRes && stopRes.profile, params.topN);
  let profileFile = null;
  if (stopRes && stopRes.profile) {
    const dir = path.join(cwd, ".gm", "browser-profiles");
    fs.mkdirSync(dir, { recursive: true });
    profileFile = path.join(dir, `profile-${Date.now()}.profile.json`);
    fs.writeFileSync(profileFile, JSON.stringify(stopRes.profile));
  }
  const out = { ok: true, result: evalResult.value ?? null, profile: agg, debug };
  if (profileFile) out.profile_file = profileFile;
  return out;
}

function aggregateCpuProfile(profile, topN) {
  if (!profile || !Array.isArray(profile.nodes) || !Array.isArray(profile.samples)) {
    return { timeframe: null, culprits: [] };
  }
  const byId = new Map();
  for (const node of profile.nodes) byId.set(node.id, node);
  const deltas = Array.isArray(profile.timeDeltas) ? profile.timeDeltas : [];
  const selfUs = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]);
    if (!node) continue;
    const delta = deltas[i + 1] || deltas[i] || 0;
    selfUs.set(node.id, (selfUs.get(node.id) || 0) + Math.abs(delta));
  }
  const totalUs = Array.from(selfUs.values()).reduce((a, b) => a + b, 0);
  const acc = new Map();
  for (const [id, us] of selfUs.entries()) {
    const node = byId.get(id);
    if (!node || !node.callFrame) continue;
    const cf = node.callFrame;
    const fn = cf.functionName || "(anonymous)";
    const loc = `${cf.url || ""}:${cf.lineNumber != null ? cf.lineNumber + 1 : 0}:${cf.columnNumber != null ? cf.columnNumber + 1 : 0}`;
    const key = `${fn}@${loc}`;
    const prior = acc.get(key) || { location: loc, function: fn, self_us: 0, hits: 0 };
    prior.self_us += us;
    prior.hits += 1;
    acc.set(key, prior);
  }
  const culprits = Array.from(acc.values())
    .map((c) => ({ ...c, self_pct: totalUs > 0 ? Math.round((c.self_us / totalUs) * 10000) / 100 : 0 }))
    .sort((a, b) => b.self_us - a.self_us)
    .slice(0, topN);
  let gpuHint;
  const top = culprits[0];
  if (top && /\(program\)|\(native\)/.test(top.function) && top.self_pct >= 40) {
    gpuHint = "top culprit is unattributed (program)/(native) time — dispatch trace\\n<script> to see real GPU-process activity the CPU sampler cannot see.";
  }
  return {
    timeframe: {
      start_us: typeof profile.startTime === "number" ? profile.startTime : 0,
      end_us: typeof profile.endTime === "number" ? profile.endTime : 0,
      total_us: totalUs,
      sample_count: profile.samples.length,
    },
    culprits,
    ...(gpuHint ? { gpu_hint: gpuHint } : {}),
  };
}

async function runTrace(cwd, tabId, url, script, timeoutMs) {
  // Same navigation-before-instrumentation ordering as runProfile (see its
  // comment): a top-level chrome.tabs.update navigation resets the CDP
  // session's active domains, so Tracing.start must run AFTER navigation or
  // every trace comes back empty.
  await maybeNavigate(tabId, url);
  try {
    await callTool("_gm_cdp_drain_events", { tabId }); // clear stale
    await callTool("_gm_cdp_raw", {
      tabId,
      method: "Tracing.start",
      params: { categories: "disabled-by-default-devtools.timeline,devtools.timeline,disabled-by-default-devtools.timeline.frame", transferMode: "ReportEvents" },
    });
  } catch (e) {
    return { ok: false, stderr: `tracing start failed: ${e.message}`, trace: { wall_us: 0, gpu_us: 0, viz_us: 0, cc_us: 0, by_category: {} }, debug: defaultDebug() };
  }

  const w0 = Date.now();
  const evalResult = await evalInPage(tabId, script, timeoutMs);
  const wallUs = (Date.now() - w0) * 1000;

  try {
    await callTool("_gm_cdp_raw", { tabId, method: "Tracing.end", params: {} });
  } catch {}
  await new Promise((r) => setTimeout(r, 500));

  let traceEvents = [];
  try {
    const raw = await callTool("_gm_cdp_drain_events", { tabId });
    const events = JSON.parse(extractText(raw) || "[]");
    for (const e of events) {
      if (e.method === "Tracing.dataCollected" && Array.isArray(e.params?.value)) {
        traceEvents.push(...e.params.value);
      }
    }
  } catch {}

  const debug = await snapshotDebug(tabId);
  if (evalResult.timedOut) return { ok: false, timed_out: true, stderr: "eval timed out", trace: { wall_us: wallUs, gpu_us: 0, viz_us: 0, cc_us: 0, by_category: {} }, debug };
  if (evalResult.error) return { ok: false, stderr: evalResult.error, trace: { wall_us: wallUs, gpu_us: 0, viz_us: 0, cc_us: 0, by_category: {} }, debug };

  const byCategory = {};
  let gpuUs = 0, vizUs = 0, ccUs = 0;
  for (const e of traceEvents) {
    const cat = e.cat || "unknown";
    const dur = e.dur || 0;
    byCategory[cat] = (byCategory[cat] || 0) + dur;
    if (/gpu/i.test(e.name || "") || /GPU/.test(cat)) gpuUs += dur;
    if (/composit/i.test(e.name || "")) ccUs += dur;
    if (/raster|paint|layer/i.test(e.name || "")) vizUs += dur;
  }
  const cappedByCategory = Object.fromEntries(
    Object.entries(byCategory).sort((a, b) => b[1] - a[1]).slice(0, 15)
  );

  let traceFile = null;
  if (traceEvents.length) {
    const dir = path.join(cwd, ".gm", "browser-profiles");
    fs.mkdirSync(dir, { recursive: true });
    traceFile = path.join(dir, `trace-${Date.now()}.trace.json`);
    fs.writeFileSync(traceFile, JSON.stringify(traceEvents));
  }

  const out = {
    ok: true,
    result: evalResult.value ?? null,
    trace: { wall_us: wallUs, gpu_us: gpuUs, viz_us: vizUs, cc_us: ccUs, event_count: traceEvents.length, complete: true, by_category: cappedByCategory },
    debug,
  };
  if (traceFile) out.trace_file = traceFile;
  return out;
}

// --- Main dispatch -------------------------------------------------------

async function handleBrowserBody(cwd, rawBody, defaultSessionId) {
  if (looksLikeJsonObjectBody(rawBody)) {
    return {
      ok: false, stdout: "", exit_code: 1,
      stderr: "browser dispatch body must be one of the plain-text shapes (session new/list/close/reset, sessionId=, timeout=, url=, capture/profile/trace/screenshot/dom=, or a bare JS expression) -- never a JSON object body.",
    };
  }

  const [explicitSessionId, afterSession] = stripSessionIdPrefix(rawBody);
  const sessionId = explicitSessionId || defaultSessionId || "default";

  const sessionCmd = parseSessionCommand(afterSession);
  if (sessionCmd.cmd === "new") return sessionNew(cwd, sessionId);
  if (sessionCmd.cmd === "list") return sessionList(cwd);
  if (sessionCmd.cmd === "close") {
    if (!sessionCmd.id) return { ok: false, stdout: "", exit_code: 1, stderr: "session close/reset requires an explicit id, e.g. 'session close default'" };
    return sessionClose(cwd, sessionCmd.id, true);
  }
  if (sessionCmd.cmd === "reset") {
    if (!sessionCmd.id) return { ok: false, stdout: "", exit_code: 1, stderr: "session close/reset requires an explicit id, e.g. 'session close default'" };
    return sessionClose(cwd, sessionCmd.id, false);
  }

  const [timeoutOverride, afterTimeout] = stripTimeoutPrefix(afterSession);
  const timeoutMs = Math.min(timeoutOverride || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  const [mode, modeArg, afterMode] = stripModePrefix(afterTimeout);
  const [viewport, afterViewport] = stripViewportPrefix(afterMode);
  const [url, script] = parseBody(afterViewport);

  if (mode !== "dom" && !script.trim()) {
    return {
      ok: false, stdout: "", exit_code: 1,
      stderr: "browser dispatch resolved to an empty script body after prefix parsing -- nothing would be evaluated, refusing rather than silently launching/reusing a session and returning a false success",
      start_url: url,
    };
  }

  const t0 = Date.now();
  const { tabId, relaunched, multiSessionWarning } = await ensureSession(cwd, sessionId);

  if (viewport) {
    try {
      await callTool("resize_window", { width: viewport.width, height: viewport.height, tabId });
    } catch {}
  }

  let landedOnBlank = false;
  if (!url) {
    try {
      const ctxRaw = await callTool("tabs_context_mcp", {});
      const ctx = JSON.parse(extractText(ctxRaw) || "{}");
      const tab = (ctx.availableTabs || []).find((t) => t.tabId === tabId);
      landedOnBlank = !tab || tab.url === "about:blank" || tab.url === "";
    } catch {}
  }

  let modeResult;
  switch (mode) {
    case "dom":
      modeResult = await runDom(tabId, modeArg, url);
      break;
    case "screenshot":
      modeResult = await runScreenshot(cwd, tabId, url, script, timeoutMs);
      break;
    case "profile":
      modeResult = await runProfile(cwd, tabId, url, script, timeoutMs, parseProfileParams(modeArg));
      break;
    case "trace":
      modeResult = await runTrace(cwd, tabId, url, script, timeoutMs);
      break;
    case "capture":
    case "default":
    default:
      modeResult = await runDefault(tabId, url, script, timeoutMs);
      break;
  }

  const envelope = {
    ...modeResult,
    session_id: sessionId,
    navigation_requested: !!url,
    duration_ms: Date.now() - t0,
    timeout_ms_used: timeoutMs,
  };
  if (landedOnBlank) {
    envelope.landed_on_blank = true;
    envelope.hint = "the session was never navigated -- prefix the dispatch with url=<target> or a bare https:// URL";
  }
  if (relaunched) {
    envelope.session_relaunched = true;
    envelope.relaunch_note = "the tracked tab was gone (idle reap or externally closed); a fresh tab was created under the same session_id -- in-page window.* state was reset";
  }
  if (multiSessionWarning) {
    envelope.multi_session_warning = "a second distinct sessionId opened its own tab in this run -- pick one sessionId and reuse it, or you leak one tab per name";
  }

  // False-success guard, matching browser.rs: ok=true with no evidence a
  // real page was ever reached is treated as a failure, not a silent no-op.
  if (envelope.ok && mode === "dom") {
    // dom mode is inherently evidence-bearing (match_count present) even at 0.
  } else if (envelope.ok && envelope.result === undefined) {
    envelope.ok = false;
    envelope.stderr = `browser dispatch returned success with no evidence a page was ever reached (empty result envelope, mode=${mode}) -- treating as a false success rather than a silent no-op`;
  }

  return envelope;
}

// --- Spool watcher ---------------------------------------------------------

function listPendingInputs(inDir) {
  try {
    return fs.readdirSync(inDir).filter((f) => f.endsWith(".txt"));
  } catch {
    return [];
  }
}

async function processOne(cwd, inDir, outDir, file) {
  const inPath = path.join(inDir, file);
  const n = file.replace(/\.txt$/, "");
  const outPath = path.join(outDir, `browser-${n}.json`);
  let raw;
  try {
    raw = fs.readFileSync(inPath, "utf-8");
  } catch {
    return; // picked up by a racing watcher tick
  }
  try {
    fs.unlinkSync(inPath);
  } catch {}

  let bodyStr = raw;
  let sessionIdHint = null;
  try {
    const asJson = JSON.parse(raw);
    if (asJson && typeof asJson === "object" && typeof asJson.body === "string") {
      bodyStr = asJson.body;
      sessionIdHint = asJson.sessionId || null;
    }
  } catch {
    // raw is the plain-text body itself
  }

  let envelope;
  try {
    envelope = await handleBrowserBody(cwd, bodyStr, sessionIdHint);
  } catch (e) {
    envelope = { ok: false, stdout: "", exit_code: 1, stderr: `gm-browser-verb internal error: ${e && e.stack || e}` };
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(envelope));
}

async function watchLoop(cwd) {
  const inDir = path.join(cwd, ".gm", "exec-spool", "in", "browser");
  const outDir = path.join(cwd, ".gm", "exec-spool", "out");
  fs.mkdirSync(inDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const cfg = loadConfig(cwd);
  startIdleReaper(cwd, cfg);
  // A fresh process has an empty sessionsByCwdAndId, so a startup sweep
  // closes every tab a PREVIOUS crashed/killed instance left behind in the
  // shared MCP group before this run creates any new ones -- otherwise tabs
  // accumulate across restarts indefinitely.
  await sweepUntrackedTabs();

  process.stderr.write(`[gm-browser-verb] watching ${inDir}\n`);
  for (;;) {
    const files = listPendingInputs(inDir).sort();
    for (const f of files) {
      await processOne(cwd, inDir, outDir, f);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function main() {
  const cwdArg = process.argv.find((a) => a.startsWith("--cwd="));
  const cwd = cwdArg ? path.resolve(cwdArg.slice("--cwd=".length)) : process.env.CLAUDE_PROJECT_DIR || process.cwd();
  await runtimeInit();
  await watchLoop(cwd);
}

main().catch((e) => {
  process.stderr.write(`[gm-browser-verb] fatal: ${e && e.stack || e}\n`);
  process.exit(1);
});
