"use strict";

const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const tough = require("tough-cookie");

const VTU_API = "https://online.vtu.ac.in/api/v1";

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
  { email, password, courseSlug, batchSize = 10, maxAttempts = 50, retryDelay = 2000, requestDelay = 500 },
  onProgress
) {
  const emit = (type, data) => { try { onProgress?.(type, data); } catch (_) {} };

  const jar = new tough.CookieJar();
  const http = wrapper(axios.create({ jar, timeout: 30_000 }));
  let sessionValid = false;
  let completed = 0;
  let skipped = 0;

  // ── Auth ─────────────────────────────────────────────────────────────────
  async function login() {
    const res = await http.post(`${VTU_API}/auth/login`, { email, password });
    sessionValid = true;
    emit("log", { text: `✓ Logged in as ${res.data.data.name}`, level: "success" });
  }

  async function request(cfg, retry = true) {
    if (!sessionValid) await login();
    try {
      return await http(cfg);
    } catch (err) {
      const s = err.response?.status;
      if (retry && (s === 401 || s === 419 || s === 403)) {
        sessionValid = false;
        await login();
        return request(cfg, false);
      }
      // VTU server is overloaded — back off and retry once before propagating
      if (retry && (s === 500 || s === 503 || s === 429)) {
        const wait = retryDelay > 0 ? retryDelay : 2000;
        emit("log", { text: `⚠ VTU returned ${s} — waiting ${wait}ms before retry...`, level: "warn" });
        await sleep(wait);
        return request(cfg, false);
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

  // Lectures to retry after the first pass.
  // Only "maxed" (hit attempt cap) and "error" (network/server crash) are retryable.
  // "skip" (zero duration) is a permanent data condition — retrying won't help.
  const retryable = [];

  async function doLecture(lec, idx, isRetry = false) {
    if (lec.is_completed && !isRetry) {
      skipped++;
      emit("lecture_done", { idx, total, title: lec.title, status: "skip", reason: "Already completed", completed, skipped });
      return;
    }
    if (!isRetry) emit("lecture_start", { idx, total, title: lec.title });
    try {
      const detailRes = await request({
        method: "GET",
        url: `${VTU_API}/student/my-courses/${courseSlug}/lectures/${lec.id}`,
      });
      const secs = parseDuration(detailRes.data.data.duration);

      if (!secs) {
        // Zero duration — VTU has no watchable content here; skip permanently.
        if (!isRetry) {
          skipped++;
          emit("lecture_done", { idx, total, title: lec.title, status: "skip", reason: "VTU reported zero duration — no video content available for this lecture", completed, skipped });
        }
        return;
      }

      const payload = {
        current_time_seconds: secs,
        total_duration_seconds: secs,
        seconds_just_watched: secs,
      };

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Throttle requests so VTU's server is not hammered
        if (requestDelay > 0) await sleep(requestDelay);
        const r = await request({
          method: "POST",
          url: `${VTU_API}/student/my-courses/${courseSlug}/lectures/${lec.id}/progress`,
          data: payload,
          headers: { "Content-Type": "application/json" },
        });
        const { percent, is_completed } = r.data.data || {};
        if (percent === 100 && is_completed) {
          if (isRetry) skipped--; // undo the skipped count from the first pass
          completed++;
          emit("lecture_done", { idx, total, title: lec.title, status: "done", completed, skipped, retry: isRetry });
          return;
        }
      }

      // Still not completed after all attempts
      if (!isRetry) {
        skipped++;
        retryable.push({ lec, idx });
      }
      const maxedReason = isRetry
        ? `Still not marked complete after ${maxAttempts} attempts on retry — VTU may not be accepting progress for this lecture`
        : `Did not reach 100% after ${maxAttempts} progress attempts — will retry`;
      emit("lecture_done", { idx, total, title: lec.title, status: "maxed", reason: maxedReason, completed, skipped, retry: isRetry });
    } catch (err) {
      if (!isRetry) {
        skipped++;
        retryable.push({ lec, idx });
      }
      const errReason = isRetry
        ? `Request failed on retry: ${err.message}`
        : `Request failed: ${err.message} — will retry`;
      emit("lecture_done", { idx, total, title: lec.title, status: "error", reason: errReason, completed, skipped, retry: isRetry });
    }
  }

  for (let i = 0; i < total; i += batchSize) {
    await Promise.all(
      lectures.slice(i, i + batchSize).map((lec, j) => doLecture(lec, i + j + 1))
    );
  }

  // ── Retry pass ────────────────────────────────────────────────────────────
  if (retryable.length > 0) {
    emit("phase", { message: `Retrying ${retryable.length} stubborn lecture(s) that didn't stick first time...` });
    for (let i = 0; i < retryable.length; i += batchSize) {
      await Promise.all(
        retryable.slice(i, i + batchSize).map(({ lec, idx }) => doLecture(lec, idx, true))
      );
    }
  }

  emit("complete", { completed, skipped, total, courseTitle });
  return { success: true, completed, skipped, total };
}

module.exports = { runAutomation };
