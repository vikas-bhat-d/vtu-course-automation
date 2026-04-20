"use strict";

const { Redis } = require("@upstash/redis");
const {configDotenv}= require("dotenv")

configDotenv()


// Keys
const STUDENTS_KEY = "autopilot:students";
const LECTURES_KEY = "autopilot:lectures";
const SEED_STUDENTS = 40; // minimum baseline

// Graceful init — server should still boot without Redis
let redis = null;
try {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    redis = new Redis({
      url:   process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
  } else {
    console.warn("[redis] KV_REST_API_URL / KV_REST_API_TOKEN not set — using in-memory fallback");
  }
} catch (e) {
  console.warn("[redis] Init failed:", e.message);
}

// In-memory fallback when Redis is unavailable
let _memStudents = SEED_STUDENTS;
let _memLectures = 0;

/**
 * Call once on server start: seeds student counter to 40 if the key
 * doesn't exist yet (SET NX — no-op if already set).
 */
async function ensureSeed() {
  if (!redis) return;
  try {
    await redis.set(STUDENTS_KEY, SEED_STUDENTS, { nx: true });
  } catch (e) {
    console.warn("[redis] ensureSeed failed:", e.message);
  }
}

/**
 * Returns { studentsHelped, lecturesCompleted }
 */
async function getStats() {
  if (!redis) {
    return { studentsHelped: _memStudents, lecturesCompleted: _memLectures };
  }
  try {
    const [s, l] = await Promise.all([
      redis.get(STUDENTS_KEY),
      redis.get(LECTURES_KEY),
    ]);
    return {
      studentsHelped:    Math.max(parseInt(s) || SEED_STUDENTS, SEED_STUDENTS),
      lecturesCompleted: parseInt(l) || 0,
    };
  } catch (e) {
    console.warn("[redis] getStats failed:", e.message);
    return { studentsHelped: _memStudents, lecturesCompleted: _memLectures };
  }
}

/**
 * Increment student counter when a new job is created.
 */
async function recordJobCreated() {
  _memStudents++;
  if (!redis) return;
  try {
    const val = await redis.incr(STUDENTS_KEY);
    // Guard: if the key somehow got set below minimum, correct it
    if (parseInt(val) < SEED_STUDENTS) {
      await redis.set(STUDENTS_KEY, SEED_STUDENTS);
    }
  } catch (e) {
    console.warn("[redis] recordJobCreated failed:", e.message);
  }
}

/**
 * Increment lecture counter on job completion.
 * @param {number} count
 */
async function recordLecturesCompleted(count) {
  if (!count || count <= 0) return;
  _memLectures += count;
  if (!redis) return;
  try {
    await redis.incrby(LECTURES_KEY, count);
  } catch (e) {
    console.warn("[redis] recordLecturesCompleted failed:", e.message);
  }
}

// ── Job / Queue persistence ───────────────────────────────────────────────────
const QUEUE_KEY    = "autopilot:queue";     // Redis List  — jobIds only (no creds)
const JOB_PREFIX   = "autopilot:job:";      // Hash per job
const DEDUP_PREFIX = "autopilot:dedup:";    // String  dedupKey → jobId
const JOB_TTL_SEC  = 3600;                  // 1 hour, mirrors in-memory expiry

/**
 * Persist a full job snapshot (no credentials).
 * Logs and result are JSON-serialised so they survive as hash fields.
 */
async function saveJob(jobId, jobData) {
  if (!redis) return;
  try {
    await redis.hset(`${JOB_PREFIX}${jobId}`, {
      id:        jobData.id,
      status:    jobData.status,
      position:  jobData.position  ?? 0,
      dedupKey:  jobData.dedupKey  ?? "",
      total:     jobData.total     ?? 0,
      processed: jobData.processed ?? 0,
      progress:  jobData.progress  ?? 0,
      createdAt: jobData.createdAt ?? Date.now(),
      logs:      JSON.stringify(jobData.logs   ?? []),
      result:    jobData.result ? JSON.stringify(jobData.result) : "",
    });
    await redis.expire(`${JOB_PREFIX}${jobId}`, JOB_TTL_SEC);
  } catch (e) {
    console.warn("[redis] saveJob failed:", e.message);
  }
}

/**
 * Patch selected fields on an existing job hash.
 * Objects/arrays are automatically JSON-serialised.
 */
async function updateJobFields(jobId, fields) {
  if (!redis) return;
  try {
    const payload = {};
    for (const [k, v] of Object.entries(fields)) {
      payload[k] = typeof v === "object" && v !== null ? JSON.stringify(v) : v;
    }
    await redis.hset(`${JOB_PREFIX}${jobId}`, payload);
    await redis.expire(`${JOB_PREFIX}${jobId}`, JOB_TTL_SEC);
  } catch (e) {
    console.warn("[redis] updateJobFields failed:", e.message);
  }
}

/**
 * Load a job snapshot from Redis and deserialise it.
 * Returns null when the key does not exist or Redis is unavailable.
 */
async function loadJob(jobId) {
  if (!redis) return null;
  try {
    const data = await redis.hgetall(`${JOB_PREFIX}${jobId}`);
    if (!data?.id) return null;
    return {
      id:        data.id,
      status:    data.status,
      position:  parseInt(data.position)  || 0,
      dedupKey:  data.dedupKey            || "",
      total:     parseInt(data.total)     || 0,
      processed: parseInt(data.processed) || 0,
      progress:  parseInt(data.progress)  || 0,
      createdAt: parseInt(data.createdAt) || Date.now(),
      logs:      data.logs   ? JSON.parse(data.logs)   : [],
      result:    data.result ? JSON.parse(data.result) : undefined,
    };
  } catch (e) {
    console.warn("[redis] loadJob failed:", e.message);
    return null;
  }
}

/** Remove a job hash from Redis (called after 1-hour expiry timer). */
async function deleteJob(jobId) {
  if (!redis) return;
  try { await redis.del(`${JOB_PREFIX}${jobId}`); } catch (_) {}
}

/** Append a jobId to the persistent queue list. */
async function enqueueJobId(jobId) {
  if (!redis) return;
  try { await redis.rpush(QUEUE_KEY, jobId); } catch (e) {
    console.warn("[redis] enqueueJobId failed:", e.message);
  }
}

/** Remove all occurrences of jobId from the persistent queue list. */
async function removeJobFromQueue(jobId) {
  if (!redis) return;
  try { await redis.lrem(QUEUE_KEY, 0, jobId); } catch (e) {
    console.warn("[redis] removeJobFromQueue failed:", e.message);
  }
}

/** Return the full ordered list of queued jobIds. */
async function loadQueuedJobIds() {
  if (!redis) return [];
  try { return (await redis.lrange(QUEUE_KEY, 0, -1)) ?? []; } catch (e) {
    console.warn("[redis] loadQueuedJobIds failed:", e.message);
    return [];
  }
}

/** Wipe the queue list entirely (used after restart recovery). */
async function clearQueue() {
  if (!redis) return;
  try { await redis.del(QUEUE_KEY); } catch (_) {}
}

// ── Dedup key helpers ─────────────────────────────────────────────────────────

async function setDedupKey(dedupKey, jobId) {
  if (!redis) return;
  try { await redis.set(`${DEDUP_PREFIX}${dedupKey}`, jobId, { ex: JOB_TTL_SEC }); } catch (_) {}
}

async function getDedupKey(dedupKey) {
  if (!redis) return null;
  try { return await redis.get(`${DEDUP_PREFIX}${dedupKey}`); } catch (_) { return null; }
}

async function deleteDedupKey(dedupKey) {
  if (!redis) return;
  try { await redis.del(`${DEDUP_PREFIX}${dedupKey}`); } catch (_) {}
}

module.exports = {
  ensureSeed,
  getStats,
  recordJobCreated,
  recordLecturesCompleted,
  // job/queue persistence
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
};
