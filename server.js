"use strict";

const express = require("express");
const cors    = require("cors");
const { v4: uuidv4 } = require("uuid");
const rateLimit = require("express-rate-limit");
const path = require("path");
const { runAutomation } = require("./automation");
const {
  ensureSeed,
  getStats,
  recordJobCreated,
  recordLecturesCompleted,
} = require("./lib/redis");

const app = express();
const PORT = process.env.PORT || 3000;

const GITHUB_URL =
  process.env.GITHUB_URL || "https://github.com/vikas-bhat-d/vtu-course-automation";


// ── In-memory job store ──────────────────────────────────────────────────────
// Each job: { id, status, position, logs[], total, processed, progress, createdAt, result? }
const jobs = new Map();

// Queue: [{ jobId, config }]
const queue = [];

// SSE connections: jobId → Set<Response>
const sseConnections = new Map();

let activeJobs = 0;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT) || 2;

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
  if (activeJobs >= MAX_CONCURRENT || queue.length === 0) return;

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
  push(jobId, "status", { status: "processing" });
  activeJobs++;

  runAutomation(config, (type, data) => {
    // Keep a rolling 200-entry log for late-joiners to replay
    job.logs.push({ type, data, ts: Date.now() });
    if (job.logs.length > 200) job.logs.shift();

    if (type === "course_info") job.total = data.total;
    if (type === "lecture_done") {
      job.processed = data.idx;
      job.progress = job.total ? Math.round((data.idx / job.total) * 100) : 0;
    }

    push(jobId, type, data);
  })
    .then((result) => {
      activeJobs--;
      job.status = result.success ? "done" : "failed";
      job.result = result;

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

      // Expire job after 1 hour
      setTimeout(() => {
        jobs.delete(jobId);
        sseConnections.delete(jobId);
      }, 3_600_000);

      drainQueue();
    })
    .catch((err) => {
      activeJobs--;
      job.status = "failed";
      push(jobId, "failed", { message: "Unexpected server error. Try again." });
      config.email = null;
      config.password = null;
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

const submitLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Even VTU has a rate limit (sort of)." },
});

// ── Routes ───────────────────────────────────────────────────────────────────

// POST /api/submit  — enqueue a new job
app.post("/api/submit", submitLimit, (req, res) => {
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

  const jobId = uuidv4();
  const position = queue.length + activeJobs + 1;

  jobs.set(jobId, {
    id: jobId,
    status: "queued",
    position,
    logs: [],
    total: 0,
    processed: 0,
    progress: 0,
    createdAt: Date.now(),
  });

  // Fire-and-forget: increment student counter in Redis
  recordJobCreated().catch(() => {});

  queue.push({ jobId, config: { email, password, courseSlug } });
  drainQueue();

  res.json({ jobId, position });
});

// GET /api/status/:jobId  — SSE stream for real-time progress
app.get("/api/status/:jobId", (req, res) => {
  const { jobId } = req.params;

  // Validate UUID v4 format to prevent enumeration probing
  if (!/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(jobId)) {
    return res.status(400).json({ error: "Invalid job ID format." });
  }

  const job = jobs.get(jobId);
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

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🛸  VTU Autopilot is live → http://localhost:${PORT}`);
  console.log(`    VTU: "Please watch all 166 lectures."`);
  console.log(`    Us:  "No."\n`);
  ensureSeed().catch(e => console.warn("[redis] seed failed:", e.message));
});
