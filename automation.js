"use strict";

const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { configDotenv } = require("dotenv");
const tough = require("tough-cookie");
configDotenv()

const VTU_API = process.env.VTU_API_BASE_URL 


/** Pause execution for `ms` milliseconds. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the full VTU course automation for a given user/course.
 *
 * @param {object} config
 * @param {string} config.email
 * @param {string} config.password
 * @param {string} config.courseSlug  e.g. "1-social-networks"
 * @param {number} [config.batchSize=10]
 * @param {number} [config.maxAttempts=50]
 * @param {(type: string, data: object) => void} [onProgress]
 * @returns {Promise<{success: boolean, completed: number, skipped: number, total: number, error?: string}>}
 */
async function runAutomation(
  { email, password, courseSlug, batchSize = 10, maxAttempts = 50, retryDelay = 2000, requestDelay = 500, maxRetries = 10 },
  onProgress
) {
  const emit = (type, data) => { try { onProgress?.(type, data); } catch (_) {} };

  const jar = new tough.CookieJar();
  const http = wrapper(axios.create({ jar, timeout: 30_000 }));
  let sessionValid = false;
  let completed = 0;
  let skipped = 0;

  // ── Auth ─────────────────────────────────────────────────────────────────
  async function login(retriesLeft = maxRetries) {
    try {
      const res = await http.post(`${VTU_API}/auth/login`, { email, password });
      sessionValid = true;
      emit("log", { text: `✓ Logged in as ${res.data.data.name}`, level: "success" });
    } catch (err) {
      const s = err.response?.status;
      if (retriesLeft > 0 && (s === 500 || s === 503 || s === 429)) {
        const wait = retryDelay > 0 ? retryDelay : 2000;
        console.warn(`[vtu] login ${s} — backing off ${wait}ms (${retriesLeft} retries left)`);
        await sleep(wait);
        return login(retriesLeft - 1);
      }
      throw err;
    }
  }

  async function request(cfg, retriesLeft = maxRetries) {
    if (!sessionValid) await login();
    try {
      return await http(cfg);
    } catch (err) {
      const s = err.response?.status;
      if (retriesLeft > 0 && (s === 401 || s === 419 || s === 403)) {
        sessionValid = false;
        await login();
        return request(cfg, retriesLeft - 1);
      }
      // VTU server is overloaded — back off and retry
      if (retriesLeft > 0 && (s === 500 || s === 503 || s === 429)) {
        const wait = retryDelay > 0 ? retryDelay : 2000;
        console.warn(`[vtu] ${s} — backing off ${wait}ms (${retriesLeft} retries left)`);
        await sleep(wait);
        return request(cfg, retriesLeft - 1);
      }
      throw err;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function parseDuration(str) {
    if (!str) return 0;
    const p = str.replace(" mins", "").trim().split(":").map(Number);
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2) return p[0] * 60 + p[1];
    return 0;
  }

  // ── Step 1: Login ─────────────────────────────────────────────────────────
  emit("phase", { message: "Sneaking past VTU's login page..." });
  try {
    await login();
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.errors?.[0] || "Invalid credentials";
    emit("failed", { message: msg });
    return { success: false, error: msg };
  }

  // ── Step 2: Fetch course structure ────────────────────────────────────────
  emit("phase", { message: "Loading course structure..." });
  let courseTitle, lectures;
  try {
    const res = await request({
      method: "GET",
      url: `${VTU_API}/student/my-courses/${courseSlug}`,
    });
    const d = res.data.data;
    courseTitle = d.title;
    lectures = [];
    (d.lessons || []).forEach((lesson) => {
      (lesson.lectures || []).forEach((lec) => {
        lectures.push({ id: lec.id, title: lec.title, week: lesson.name, is_completed: lec.is_completed === true });
      });
    });
    emit("log", { text: `✓ "${courseTitle}" — ${lectures.length} lectures found`, level: "success" });
    emit("course_info", { title: courseTitle, total: lectures.length });
  } catch (err) {
    const msg =
      err.response?.status === 404
        ? "Course not found — double-check the slug."
        : err.response?.data?.message || err.message;
    emit("failed", { message: msg });
    return { success: false, error: msg };
  }

  // ── Step 3: Complete each lecture ─────────────────────────────────────────
  emit("phase", { message: `Nuking ${lectures.length} lectures into oblivion...` });

  const total = lectures.length;
  const durationCache = new Map(); // lec.id → seconds (fetched once, reused across rounds)

  // Separate already-done from lectures that need work
  let pending = [];
  for (let i = 0; i < lectures.length; i++) {
    const lec = lectures[i];
    if (lec.is_completed) {
      skipped++;
      emit("lecture_done", { idx: i + 1, total, title: lec.title, status: "skip", reason: "Already completed", completed, skipped });
    } else {
      pending.push({ lec, idx: i + 1 });
    }
  }

  /**
   * Send exactly ONE progress POST for a lecture.
   * Duration is fetched on first call and cached for all subsequent rounds.
   * Returns: "done" | "skip" | "retry"
   */
  async function tryOnce({ lec, idx }) {
    try {
      // Fetch + cache duration on first encounter
      if (!durationCache.has(lec.id)) {
        const detailRes = await request({
          method: "GET",
          url: `${VTU_API}/student/my-courses/${courseSlug}/lectures/${lec.id}`,
        }, 1);
        durationCache.set(lec.id, parseDuration(detailRes.data.data.duration));
      }
      const secs = durationCache.get(lec.id);
      if (!secs) {
        // Zero duration — VTU has no watchable content; skip permanently.
        skipped++;
        emit("lecture_done", { idx, total, title: lec.title, status: "skip", reason: "VTU reported zero duration — no video content available for this lecture", completed, skipped });
        return "skip";
      }

      if (requestDelay > 0) await sleep(requestDelay);
      // Pass retriesLeft=1 so the round-robin handles retries, not request() internally
      const r = await request({
        method: "POST",
        url: `${VTU_API}/student/my-courses/${courseSlug}/lectures/${lec.id}/progress`,
        data: { current_time_seconds: secs, total_duration_seconds: secs, seconds_just_watched: secs },
        headers: { "Content-Type": "application/json" },
      }, 1);
      const { percent, is_completed } = r.data.data || {};
      if (percent === 100 && is_completed) {
        completed++;
        emit("lecture_done", { idx, total, title: lec.title, status: "done", completed, skipped });
        return "done";
      }
      // VTU accepted the request but hasn't marked it complete yet — retry next round
      return "retry";
    } catch (_err) {
      // Network/server error — retry next round silently
      return "retry";
    }
  }

  // ── Round-robin: one request per lecture per round ────────────────────────
  // Each round sweeps ALL pending lectures once (in batches of batchSize).
  // Lectures that complete or are skipped are dropped from pending.
  // The full sweep of all other batches acts as the natural delay before
  // VTU sees the same lecture again — no artificial sleeps between rounds needed.
  //
  // maxAttempts = maximum number of complete sweeps through pending lectures.
  for (let round = 0; round < maxAttempts && pending.length > 0; round++) {
    const nextPending = [];
    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(item => tryOnce(item)));
      for (let j = 0; j < batch.length; j++) {
        if (results[j] === "retry") nextPending.push(batch[j]);
      }
    }
    pending = nextPending;
  }

  // Anything still pending after maxAttempts rounds — VTU refused to cooperate
  if (pending.length > 0) {
    emit("phase", { message: `${pending.length} lecture(s) couldn't be marked complete after ${maxAttempts} round(s). VTU is VTU.` });
    for (const { lec, idx } of pending) {
      emit("lecture_done", { idx, total, title: lec.title, status: "maxed", reason: `Did not reach 100% after ${maxAttempts} round(s)`, completed, skipped });
    }
  }

  emit("complete", { completed, skipped, total, courseTitle });
  return { success: true, completed, skipped, total };
}

module.exports = { runAutomation };
