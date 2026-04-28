"use strict";

const express = require("express");
const cors    = require("cors");
const crypto  = require("crypto");
const { v4: uuidv4 } = require("uuid");
const rateLimit = require("express-rate-limit");
const path = require("path");
const { runAutomation } = require("./automation");
const {
  ensureSeed,
  getStats,
  recordJobCreated,
  recordLecturesCompleted,
  saveJob,
  updateJobFields,
  loadJob,
  deleteJob,
  enqueueJobId,
  removeJobFromQueue,
  loadQueuedJobIds,
  clearQueue,
  setDedupKey,
  getDedupKey,
  deleteDedupKey,
} = require("./lib/redis");
const { configDotenv } = require("dotenv");

configDotenv()
const app = express();
const PORT = process.env.PORT || 3000;

const GITHUB_URL =
  process.env.GITHUB_URL || "https://github.com/vikas-bhat-d/vtu-course-automation";


// ── Runtime-configurable settings ────────────────────────────────────────────
// These can be changed at runtime via PATCH /api/admin/config without redeploying.
const runtimeConfig = {
  maxConcurrent:  parseInt(process.env.MAX_CONCURRENT)       || 2,
  batchSize:      parseInt(process.env.DEFAULT_BATCH_SIZE)   || 10,
  maxAttempts:    parseInt(process.env.DEFAULT_MAX_ATTEMPTS) || 50,
  retryDelay:     parseInt(process.env.RETRY_DELAY_MS)       || 2000,
  requestDelay:   parseInt(process.env.REQUEST_DELAY_MS)     || 500,
};

// ── Notification state ───────────────────────────────────────────────────────
// Can be managed via GET /api/admin/notification?password=<pw>[&message=...&disabled=...]
const notificationState = {
  message: "",
  disabled: false,
};

// ── In-memory job store ──────────────────────────────────────────────────────
// Each job: { id, status, position, logs[], total, processed, progress, createdAt, result? }
const jobs = new Map();

// Queue: [{ jobId, config }]
const queue = [];

// SSE connections: jobId → Set<Response>
const sseConnections = new Map();

// Dedup: "email:courseSlug" → jobId  — only populated while job is active
const activeJobKeys = new Map();

let activeJobs = 0;

// ── SSE helper ───────────────────────────────────────────────────────────────
function push(jobId, event, data) {
  const conns = sseConnections.get(jobId);
  if (!conns?.size) return;
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of conns) {
    try { res.write(chunk); } catch (_) { conns.delete(res); }
  }
}

// ── Queue worker ─────────────────────────────────────────────────────────────
function drainQueue() {
  if (activeJobs >= runtimeConfig.maxConcurrent || queue.length === 0) return;

  const { jobId, config } = queue.shift();
  const job = jobs.get(jobId);
  if (!job) { drainQueue(); return; }

  // Update waiting-room positions for everyone still in queue
  queue.forEach((item, i) => {
    const j = jobs.get(item.jobId);
    if (j) {
      j.position = i + 1;
      push(item.jobId, "queue_pos", { position: i + 1 });
    }
  });

  job.status = "processing";
  job.position = 0;
  removeJobFromQueue(jobId).catch(() => {});
  // Refresh TTL from "now" so a job that waited a long time in queue
  // doesn't expire in Redis before it finishes processing.
  updateJobFields(jobId, { status: "processing", position: 0 }).catch(() => {});
  push(jobId, "status", { status: "processing" });
  activeJobs++;
  drainQueue(); // fill any remaining concurrent slots

  // Shared cleanup — called from both .then() and .catch()
  function scheduleJobExpiry() {
    setTimeout(() => {
      jobs.delete(jobId);
      sseConnections.delete(jobId);
      deleteJob(jobId).catch(() => {});
    }, 3_600_000);
  }

  // Merge runtime-configurable settings at execution time so that any
  // admin changes made while the job was queued are picked up immediately.
  runAutomation({
    ...config,
    batchSize:    runtimeConfig.batchSize,
    maxAttempts:  runtimeConfig.maxAttempts,
    retryDelay:   runtimeConfig.retryDelay,
    requestDelay: runtimeConfig.requestDelay,
  }, (type, data) => {
    // Keep a rolling 200-entry log for late-joiners to replay
    job.logs.push({ type, data, ts: Date.now() });
    if (job.logs.length > 200) job.logs.shift();

    if (type === "course_info") job.total = data.total;
    if (type === "lecture_done") {
      job.processed = data.completed; // count of actually completed lectures, not position
      job.progress = job.total ? Math.round((data.completed / job.total) * 100) : 0;
    }

    push(jobId, type, data);
  })
    .then((result) => {
      activeJobs--;
      job.status = result.success ? "done" : "failed";
      job.result = result;

      // Persist final state (includes logs captured so far)
      updateJobFields(jobId, {
        status: job.status,
        result: job.result,
        logs:   job.logs,
        total:      job.total,
        processed:  job.processed,
        progress:   job.progress,
      }).catch(() => {});
      deleteDedupKey(job.dedupKey).catch(() => {});

      if (result.success) {
        recordLecturesCompleted(result.completed).catch(() => {});
        getStats().then(stats => {
          push(jobId, "done", { ...result, stats });
        }).catch(() => {
          push(jobId, "done", { ...result });
        });
      } else {
        push(jobId, "failed", { message: result.error });
      }

      // Credentials must not linger in memory
      config.email = null;
      config.password = null;

      // Release dedup slot so the user can re-run the same course later
      activeJobKeys.delete(job.dedupKey);

      scheduleJobExpiry();
      drainQueue();
    })
    .catch((err) => {
      activeJobs--;
      job.status = "failed";
      job.result = { success: false, error: "Unexpected server error. Try again." };
      updateJobFields(jobId, { status: "failed", result: job.result }).catch(() => {});
      deleteDedupKey(job.dedupKey).catch(() => {});
      push(jobId, "failed", { message: "Unexpected server error. Try again." });
      config.email = null;
      config.password = null;
      activeJobKeys.delete(job.dedupKey);
      scheduleJobExpiry();
      drainQueue();
    });
}

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.CORS_ORIGIN || "*",
  methods: ["GET", "POST"],
}));
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "frontend")));

const submitLimit = process.env.NODE_ENV === "production"
  ? rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 5,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many requests. Even VTU has a rate limit (sort of)." },
    })
  : (_req, _res, next) => next(); // disabled in local/dev

// ── Routes ───────────────────────────────────────────────────────────────────

// POST /api/submit  — enqueue a new job
app.post("/api/submit", submitLimit, async (req, res) => {
  const { email, password, courseSlug } = req.body ?? {};

  if (!email || !password || !courseSlug) {
    return res.status(400).json({ error: "All fields are required." });
  }
  if (
    typeof email !== "string" ||
    typeof password !== "string" ||
    typeof courseSlug !== "string"
  ) {
    return res.status(400).json({ error: "Invalid input types." });
  }
  if (email.length > 100 || password.length > 128 || courseSlug.length > 100) {
    return res.status(400).json({ error: "Input too long." });
  }
  if (!email.includes("@") || email.indexOf("@") === 0) {
    return res.status(400).json({ error: "Invalid email address." });
  }
  // Only allow valid URL-slug characters for courseSlug
  if (!/^[\w-]+$/.test(courseSlug)) {
    return res
      .status(400)
      .json({ error: "Invalid course slug. Use letters, numbers, and hyphens only." });
  }

  // Dedup: check in-memory first, then Redis (survives restarts)
  const dedupKey = `${email.toLowerCase()}:${courseSlug.toLowerCase()}`;
  let existingId = activeJobKeys.get(dedupKey);
  if (!existingId) {
    existingId = await getDedupKey(dedupKey).catch(() => null);
  }
  if (existingId) {
    let existing = jobs.get(existingId);
    if (!existing) {
      // Restore from Redis if it was evicted from memory
      existing = await loadJob(existingId).catch(() => null);
      if (existing) jobs.set(existingId, existing);
    }
    if (existing && (existing.status === "queued" || existing.status === "processing")) {
      return res.json({ jobId: existingId, position: existing.position, existing: true });
    }
  }

  const jobId = uuidv4();
  const position = queue.length + activeJobs + 1;

  jobs.set(jobId, {
    id: jobId,
    status: "queued",
    position,
    dedupKey,
    logs: [],
    total: 0,
    processed: 0,
    progress: 0,
    createdAt: Date.now(),
  });

  activeJobKeys.set(dedupKey, jobId);

  // Fire-and-forget: increment student counter in Redis
  recordJobCreated().catch(() => {});

  queue.push({ jobId, config: { email, password, courseSlug } }); // runtime settings injected at execution time

  // Persist job state and queue position to Redis (credentials are NOT stored)
  saveJob(jobId, jobs.get(jobId)).catch(() => {});
  enqueueJobId(jobId).catch(() => {});
  setDedupKey(dedupKey, jobId).catch(() => {});

  drainQueue();

  res.json({ jobId, position });
});

// GET /api/status/:jobId  — SSE stream for real-time progress
app.get("/api/status/:jobId", async (req, res) => {
  const { jobId } = req.params;

  // Validate UUID v4 format to prevent enumeration probing
  if (!/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(jobId)) {
    return res.status(400).json({ error: "Invalid job ID format." });
  }

  let job = jobs.get(jobId);
  if (!job) {
    // Fallback: try loading from Redis (e.g. after server restart)
    job = await loadJob(jobId).catch(() => null);
    if (job) jobs.set(jobId, job);
  }
  if (!job) {
    return res.status(404).json({ error: "Job not found or has expired (jobs live for 1 hour)." });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // nginx: disable proxy buffering
  res.flushHeaders();

  if (!sseConnections.has(jobId)) sseConnections.set(jobId, new Set());
  sseConnections.get(jobId).add(res);

  // Send current state snapshot immediately so late-joiners catch up
  res.write(
    `event: snapshot\ndata: ${JSON.stringify({
      status: job.status,
      progress: job.progress,
      total: job.total,
      processed: job.processed,
      position: job.position,
      logs: job.logs.slice(-50),
      result: job.result ?? null,
    })}\n\n`
  );

  if (job.status === "done" || job.status === "failed") {
    sseConnections.get(jobId)?.delete(res);
    res.end();
    return;
  }

  // Keepalive ping every 20 s to prevent proxies from closing idle connections
  const ping = setInterval(() => {
    try { res.write(":ping\n\n"); } catch (_) { clearInterval(ping); }
  }, 20_000);

  req.on("close", () => {
    clearInterval(ping);
    sseConnections.get(jobId)?.delete(res);
  });
});

// GET /api/stats  — public counter + GitHub URL
app.get("/api/stats", async (_req, res) => {
  try {
    const stats = await getStats();
    res.json({ ...stats, githubUrl: GITHUB_URL });
  } catch {
    res.status(500).json({ error: "Could not load stats" });
  }
});

// GET /api/queue  — current queue depth (queued + processing)
app.get("/api/queue", (_req, res) => {
  res.json({ queued: queue.length, processing: activeJobs, total: queue.length + activeJobs });
});

// GET /api/notification  — public notification state (message + submit button disabled status)
app.get("/api/notification", (_req, res) => {
  res.json(notificationState);
});

// ── Admin — password-protected config management ──────────────────────────────
// Set ADMIN_PASSWORD in your .env to enable these routes.

/** Timing-safe string comparison to prevent timing attacks on the password check. */
function safeCompare(a, b) {
  try {
    const bufA = Buffer.from(String(a), "utf8");
    const bufB = Buffer.from(String(b), "utf8");
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

function adminAuth(req, res, next) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return res.status(503).json({ error: "Admin access is not configured (ADMIN_PASSWORD not set in env)." });
  }
  const provided = String(req.query.password ?? "");
  if (!provided || !safeCompare(provided, adminPassword)) {
    return res.status(401).json({ error: "Unauthorized." });
  }
  next();
}

// Strict rate limiter for admin endpoints to prevent brute-force
const adminLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many admin requests." },
});

// Allowed keys with their [min, max] bounds
const CONFIG_BOUNDS = {
  maxConcurrent:  [1, 10],
  batchSize:      [1, 50],
  maxAttempts:    [1, 500],
  retryDelay:     [0, 30_000],
  requestDelay:   [0, 10_000],
};

// GET /api/admin/config?password=<pw>[&key=value...]
// Returns current config. If any config keys are also present as query params,
// validates and applies them first, then returns the updated config.
app.get("/api/admin/config", adminLimit, adminAuth, (req, res) => {
  const updates = {};
  for (const key of Object.keys(req.query)) {
    if (key === "password") continue; // not a config key
    if (!(key in CONFIG_BOUNDS)) {
      return res.status(400).json({ error: `Unknown config key: "${key}". Allowed: ${Object.keys(CONFIG_BOUNDS).join(", ")}.` });
    }
    const val = Number(req.query[key]);
    if (!Number.isInteger(val)) {
      return res.status(400).json({ error: `"${key}" must be an integer.` });
    }
    const [min, max] = CONFIG_BOUNDS[key];
    if (val < min || val > max) {
      return res.status(400).json({ error: `"${key}" must be between ${min} and ${max}.` });
    }
    updates[key] = val;
  }

  if (Object.keys(updates).length > 0) {
    Object.assign(runtimeConfig, updates);
    console.log("[admin] Config updated:", updates);
  }

  res.json({ config: runtimeConfig, bounds: CONFIG_BOUNDS });
});



// GET /api/admin/monitor?password=<pw>  — live queue inspector
app.get("/api/admin/monitor", adminLimit, adminAuth, (_req, res) => {
  const processing = [];
  for (const [jobId, job] of jobs) {
    if (job.status === "processing") {
      const colonIdx = (job.dedupKey || "").indexOf(":");
      const email  = colonIdx >= 0 ? job.dedupKey.slice(0, colonIdx) : "?";
      const course = colonIdx >= 0 ? job.dedupKey.slice(colonIdx + 1) : "?";
      processing.push({ jobId, email, course });
    }
  }

  const queued = queue.map((item, i) => ({
    num:    i + 1,
    jobId:  item.jobId,
    email:  item.config.email      || "?",
    course: item.config.courseSlug || "?",
  }));

  if (processing.length === 0 && queued.length === 0) {
    return res.json({ message: "No active or queued jobs.", processing: [], queued: [] });
  }

  res.json({
    activeJobs:  processing.length,
    queueLength: queued.length,
    processing,
    queued,
  });
});

// GET /api/admin/notification?password=<pw>[&message=...&disabled=...]
// Returns current notification state. If message or disabled params are provided,
// updates them first, then returns the updated state.
app.get("/api/admin/notification", adminLimit, adminAuth, (req, res) => {
  const updates = {};

  // Check if message parameter is provided
  if ("message" in req.query) {
    const msg = String(req.query.message ?? "");
    if (msg.length > 500) {
      return res.status(400).json({ error: "Notification message must be 500 characters or less." });
    }
    updates.message = msg;
  }

  // Check if disabled parameter is provided
  if ("disabled" in req.query) {
    const disabled = String(req.query.disabled).toLowerCase();
    if (!["true", "false", "1", "0", "yes", "no"].includes(disabled)) {
      return res.status(400).json({ error: `"disabled" must be true or false.` });
    }
    updates.disabled = ["true", "1", "yes"].includes(disabled);
  }

  // Apply updates if any were provided
  if (Object.keys(updates).length > 0) {
    Object.assign(notificationState, updates);
    console.log("[admin] Notification updated:", updates);
  }

  res.json({
    notification: notificationState,
  });
});

/**
 * On startup, reload any jobs that were queued/processing before the last
 * restart and immediately mark them as failed — credentials are ephemeral and
 * were never persisted to Redis, so these jobs cannot be resumed.
 * Users will see "Server was restarted" when they reconnect via SSE.
 */
async function restoreQueueFromRedis() {
  const queuedIds = await loadQueuedJobIds().catch(() => []);
  if (queuedIds.length === 0) return;

  console.log(`[queue] Recovering ${queuedIds.length} job(s) from previous session...`);
  const failedResult = { success: false, error: "Server was restarted. Please resubmit your request." };

  for (const jobId of queuedIds) {
    const job = await loadJob(jobId).catch(() => null);
    if (!job) continue;

    // Restore into in-memory map as failed so SSE reconnects get the right state
    jobs.set(jobId, { ...job, status: "failed", result: failedResult });
    updateJobFields(jobId, { status: "failed", result: failedResult }).catch(() => {});
    if (job.dedupKey) deleteDedupKey(job.dedupKey).catch(() => {});
  }

  // The queue list is now stale — wipe it so new jobs start clean
  await clearQueue().catch(() => {});
  console.log(`[queue] ${queuedIds.length} job(s) marked as failed (no credentials after restart).`);
}

app.listen(PORT, () => {
  console.log(`\n🛸  VTU Autopilot is live → http://localhost:${PORT}`);
  console.log(`    VTU: "Please watch all 166 lectures."`);
  console.log(`    Us:  "No."\n`);
  ensureSeed().catch(e => console.warn("[redis] seed failed:", e.message));
  restoreQueueFromRedis().catch(e => console.warn("[queue] restore failed:", e.message));
});
