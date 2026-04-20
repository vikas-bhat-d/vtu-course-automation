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

module.exports = { ensureSeed, getStats, recordJobCreated, recordLecturesCompleted };
