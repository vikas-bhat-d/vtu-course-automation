"use strict";

const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const tough = require("tough-cookie");

const VTU_API = "https://online.vtu.ac.in/api/v1";

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
  { email, password, courseSlug, batchSize = 10, maxAttempts = 50 },
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
        lectures.push({ id: lec.id, title: lec.title, week: lesson.name });
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

  async function doLecture(lec, idx) {
    emit("lecture_start", { idx, total, title: lec.title });
    try {
      const detailRes = await request({
        method: "GET",
        url: `${VTU_API}/student/my-courses/${courseSlug}/lectures/${lec.id}`,
      });
      const secs = parseDuration(detailRes.data.data.duration);

      if (!secs) {
        skipped++;
        emit("lecture_done", { idx, total, title: lec.title, status: "skip", completed, skipped });
        return;
      }

      const payload = {
        current_time_seconds: secs,
        total_duration_seconds: secs,
        seconds_just_watched: secs,
      };

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const r = await request({
          method: "POST",
          url: `${VTU_API}/student/my-courses/${courseSlug}/lectures/${lec.id}/progress`,
          data: payload,
          headers: { "Content-Type": "application/json" },
        });
        const { percent, is_completed } = r.data.data || {};
        if (percent === 100 && is_completed) {
          completed++;
          emit("lecture_done", { idx, total, title: lec.title, status: "done", completed, skipped });
          return;
        }
      }

      skipped++;
      emit("lecture_done", { idx, total, title: lec.title, status: "maxed", completed, skipped });
    } catch (err) {
      skipped++;
      emit("lecture_done", { idx, total, title: lec.title, status: "error", error: err.message, completed, skipped });
    }
  }

  for (let i = 0; i < total; i += batchSize) {
    await Promise.all(
      lectures.slice(i, i + batchSize).map((lec, j) => doLecture(lec, i + j + 1))
    );
  }

  emit("complete", { completed, skipped, total, courseTitle });
  return { success: true, completed, skipped, total };
}

module.exports = { runAutomation };
