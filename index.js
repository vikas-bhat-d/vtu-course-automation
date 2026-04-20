/**
 * CLI Tool for VTU Course Automation
 * ⚠️  CREDENTIALS REQUIRED: VTU_EMAIL and VTU_PASSWORD must be set in .env
 * 
 * Note: The server (server.js) does NOT require credentials in .env
 * It accepts them via API request body for web/programmatic usage.
 */

const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const tough = require("tough-cookie");
require("dotenv").config();

const jar = new tough.CookieJar();
const client = wrapper(axios.create({ jar }));

const BASE_URL = process.env.VTU_API_BASE_URL || "https://online.vtu.ac.in/api/v1";
const COURSE_SLUG = process.env.VTU_COURSE_SLUG || "1-social-networks";
const EMAIL = process.env.VTU_EMAIL;
const PASSWORD = process.env.VTU_PASSWORD;
const BATCH_SIZE = parseInt(process.env.VTU_BATCH_SIZE) || 10;
const MAX_ATTEMPTS = parseInt(process.env.VTU_MAX_ATTEMPTS) || 100;

let isLoggedIn = false;
let processedCount = 0;
let skippedCount = 0;

/**
 * Login to the platform and store the session cookie
 * ⚠️  CLI-ONLY: Credentials must be in .env file
 */
async function login() {
    if (!EMAIL || !PASSWORD) {
        console.error("\n" + "=".repeat(60));
        console.error("✗ ERROR: Missing credentials");
        console.error("=".repeat(60));
        console.error("This CLI tool requires VTU_EMAIL and VTU_PASSWORD in .env\n");
        console.error("📝 Set up your .env file:");
        console.error("   VTU_EMAIL=your-email@gmail.com");
        console.error("   VTU_PASSWORD=your-password\n");
        console.error("💡 TIP: Use the web server (npm run serve) instead if you");
        console.error("   don't want to store credentials. Pass them via API.\n");
        console.error("=".repeat(60));
        process.exit(1);
    }

    try {
        const response = await client.post(`${BASE_URL}/auth/login`, {
            email: EMAIL,
            password: PASSWORD
        });

        isLoggedIn = true;
        console.log("✓ Logged in successfully");
        console.log(`User: ${response.data.data.name}`);
        return true;
    } catch (err) {
        console.error("✗ Login failed:", err.response?.data || err.message);
        return false;
    }
}

/**
 * Make an authenticated request with automatic re-login on session expiry
 */
async function requestWithAuth(config, retry = true) {
    try {
        if (!isLoggedIn) await login();
        return await client(config);
    } catch (err) {
        const status = err.response?.status;

        if (retry && (status === 401 || status === 419 || status === 403)) {
            console.log("⚠ Session expired. Re-logging...");
            isLoggedIn = false;
            await login();
            return requestWithAuth(config, false);
        }

        throw err;
    }
}

/**
 * Convert duration string "HH:MM:SS mins" to total seconds
 */
function durationToSeconds(durationStr) {
    if (!durationStr) return 0;
    
    const timeStr = durationStr.replace(" mins", "").trim();
    const parts = timeStr.split(":");
    
    let seconds = 0;
    if (parts.length === 3) {
        // HH:MM:SS
        seconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
    } else if (parts.length === 2) {
        // MM:SS
        seconds = parseInt(parts[0]) * 60 + parseInt(parts[1]);
    }
    
    return seconds;
}

/**
 * Get all lectures for the course
 */
async function getLectures() {
    try {
        const response = await requestWithAuth({
            method: "GET",
            url: `${BASE_URL}/student/my-courses/${COURSE_SLUG}`
        });

        const lessons = response.data.data.lessons;
        const allLectures = [];

        // Flatten all lectures from all lessons/weeks
        lessons.forEach(lesson => {
            if (lesson.lectures && Array.isArray(lesson.lectures)) {
                lesson.lectures.forEach(lecture => {
                    allLectures.push({
                        id: lecture.id,
                        title: lecture.title,
                        lessonName: lesson.name
                    });
                });
            }
        });

        console.log(`\n✓ Found ${allLectures.length} lectures across ${lessons.length} weeks`);
        return allLectures;
    } catch (err) {
        console.error("✗ Failed to fetch lectures:", err.response?.data || err.message);
        return [];
    }
}

/**
 * Get lecture duration
 */
async function getLectureDuration(lectureId) {
    try {
        const response = await requestWithAuth({
            method: "GET",
            url: `${BASE_URL}/student/my-courses/${COURSE_SLUG}/lectures/${lectureId}`
        });

        return response.data.data.duration;
    } catch (err) {
        console.error(`  ✗ Failed to fetch lecture ${lectureId}:`, err.response?.status);
        return null;
    }
}

/**
 * Get current lecture progress
 */
async function getLectureProgress(lectureId) {
    try {
        const response = await requestWithAuth({
            method: "GET",
            url: `${BASE_URL}/student/my-courses/${COURSE_SLUG}/lectures/${lectureId}`
        });

        return response.data.data.progress;
    } catch (err) {
        console.error(`Failed to fetch progress for lecture ${lectureId}`);
        return 0;
    }
}

/**
 * Send progress update for lecture
 */
async function sendProgressUpdate(lectureId, durationSeconds) {
    try {
        const payload = {
            current_time_seconds: durationSeconds,
            total_duration_seconds: durationSeconds,
            seconds_just_watched: durationSeconds
        };

        const response = await requestWithAuth({
            method: "POST",
            url: `${BASE_URL}/student/my-courses/${COURSE_SLUG}/lectures/${lectureId}/progress`,
            data: payload,
            headers: {
                "Content-Type": "application/json",
                "Accept": "*/*"
            }
        });

        const responseData = response.data;
        return {
            percent: responseData.data?.percent,
            is_completed: responseData.data?.is_completed,
            fullResponse: responseData
        };
    } catch (err) {
        console.error(`  ✗ Failed to send progress update for lecture ${lectureId}`);
        return null;
    }
}

/**
 * Update lecture progress repeatedly until 100% and completed
 */
async function updateLectureProgress(lectureId, durationSeconds) {
    try {
        let attempt = 0;
        let maxAttempts = MAX_ATTEMPTS;

        console.log(`  Starting progressive updates...`);

        while (attempt < maxAttempts) {
            attempt++;

            // Send progress update with full duration
            const result = await sendProgressUpdate(lectureId, durationSeconds);

            if (!result) {
                console.error(`  ✗ Failed to send progress update`);
                return false;
            }

            const { percent, is_completed, fullResponse } = result;

            console.log(`  [Attempt ${attempt}] Progress: ${percent}% | Completed: ${is_completed}`);

            // Check if we reached 100% and marked as completed
            if (percent === 100 && is_completed === true) {
                console.log(`  ✓ Success! Lecture marked as 100% complete`);
                return true;
            }
        }

        // If we reached max attempts
        console.error(`\n${"=".repeat(50)}`);
        console.error("✗ MAX ATTEMPTS REACHED!");
        console.error(`${"=".repeat(50)}`);
        console.error(`Could not reach 100% completion after ${maxAttempts} attempts`);
        console.error(`Last response: ${JSON.stringify(result.fullResponse, null, 2)}`);
        console.error(`${"=".repeat(50)}\n`);
        process.exit(1);

    } catch (err) {
        console.error(`  ✗ Error updating progress:`, err.message);
        return false;
    }
}

/**
 * Process a single lecture
 */
async function processLecture(lecture, index, total) {
    try {
        console.log(`\n[${index}/${total}] Processing: ${lecture.title}`);

        // Get lecture duration
        const duration = await getLectureDuration(lecture.id);
        
        if (!duration) {
            console.log(`  ⊘ Skipped (could not fetch duration)`);
            skippedCount++;
            return;
        }

        // Convert to seconds
        const durationSeconds = durationToSeconds(duration);
        console.log(`  Duration: ${duration} (${durationSeconds}s)`);

        // Update progress to 100%
        const success = await updateLectureProgress(lecture.id, durationSeconds);

        if (success) {
            console.log(`Progress updated to 100%`);
            processedCount++;
        } else {
            skippedCount++;
        }
    } catch (err) {
        console.error(`Error processing lecture:`, err.message);
        skippedCount++;
    }
}

/**
 * Sleep utility
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Main execution
 */
async function run() {
    // CLI-ONLY: Validate credentials are set
    if (!EMAIL || !PASSWORD) {
        console.error("\n" + "=".repeat(60));
        console.error("✗ CLI Tool Error: Missing Credentials");
        console.error("=".repeat(60));
        console.error("This CLI requires VTU_EMAIL and VTU_PASSWORD in .env\n");
        console.error("If you're running the web server:");
        console.error("  → Use: npm run serve");
        console.error("  → Credentials are passed via API request body\n");
        console.error("For CLI usage, set in .env:");
        console.error("  VTU_EMAIL=your-email@gmail.com");
        console.error("  VTU_PASSWORD=your-password");
        console.error("=".repeat(60) + "\n");
        process.exit(1);
    }

    console.log("========================================");
    console.log("   VTU Lecture Progress Automation");
    console.log("========================================");
    console.log(`Course: ${COURSE_SLUG}`);
    console.log(`API Base: ${BASE_URL}`);
    console.log(`Batch Size: ${BATCH_SIZE}`);
    console.log(`Max Attempts: ${MAX_ATTEMPTS}`);

    // Step 1: Login
    const loginSuccess = await login();
    if (!loginSuccess) {
        console.error("\nCannot proceed without login");
        process.exit(1);
    }

    // Step 2: Get all lectures
    const lectures = await getLectures();
    if (lectures.length === 0) {
        console.error("\nNo lectures found");
        process.exit(1);
    }

    // Step 3: Process lectures in parallel batches
    console.log("\n========================================");
    console.log(`   Processing Lectures (Parallel: ${BATCH_SIZE}/batch)...`);
    console.log("========================================");
    
    for (let i = 0; i < lectures.length; i += BATCH_SIZE) {
        const batch = lectures.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(lectures.length / BATCH_SIZE);
        
        console.log(`\nBatch ${batchNum}/${totalBatches} (${batch.length} lectures):`);
        
        // Process batch in parallel
        await Promise.all(
            batch.map((lecture, idx) => 
                processLecture(lecture, i + idx + 1, lectures.length)
            )
        );
    }

    // Summary
    console.log("\n========================================");
    console.log("   Summary");
    console.log("========================================");
    console.log(`Processed: ${processedCount}`);
    console.log(`Skipped: ${skippedCount}`);
    console.log(`Total: ${lectures.length}`);
    console.log("\nAll done!");
}

run().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});
