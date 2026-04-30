/**
 * CLI Tool for VTU Course Automation
 * ⚠️  CREDENTIALS REQUIRED: VTU_EMAIL and VTU_PASSWORD must be set in .env
 * 
 * Note: The server (server.js) does NOT require credentials in .env
 * It accepts them via API request body for web/programmatic usage.
 */

require("dotenv").config();
const { runAutomation } = require("./automation");

const EMAIL = process.env.VTU_EMAIL;
const PASSWORD = process.env.VTU_PASSWORD;
const COURSE_SLUG = process.env.VTU_COURSE_SLUG || "1-social-networks";
const BATCH_SIZE = parseInt(process.env.VTU_BATCH_SIZE) || 10;
const MAX_ATTEMPTS = parseInt(process.env.VTU_MAX_ATTEMPTS) || 100;

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
  console.log(`Batch Size: ${BATCH_SIZE}`);
  console.log(`Max Attempts: ${MAX_ATTEMPTS}`);

  const result = await runAutomation(
    {
      email: EMAIL,
      password: PASSWORD,
      courseSlug: COURSE_SLUG,
      batchSize: BATCH_SIZE,
      maxAttempts: MAX_ATTEMPTS,
    },
    (type, data) => {
      // CLI-style logging for each event from the automation engine
      switch (type) {
        case "phase":
          console.log(`\n${data.message}`);
          break;
        case "log":
          if (data.level === "success") console.log(data.text);
          else if (data.level === "error") console.error(`  ✗ ${data.text}`);
          else console.log(data.text);
          break;
        case "course_info":
          console.log(`\n✓ "${data.title}" — ${data.total} lectures found`);
          break;
        case "lecture_done":
          if (data.status === "done")
            console.log(`  [${data.idx}/${data.total}] ✓ ${data.title}`);
          else if (data.status === "skip")
            console.log(`  [${data.idx}/${data.total}] ⊘ Skipped: ${data.title} — ${data.reason}`);
          else if (data.status === "maxed")
            console.error(`  [${data.idx}/${data.total}] ✗ ${data.title} — ${data.reason}`);
          break;
        case "failed":
          console.error(`\n✗ FAILED: ${data.message}`);
          break;
        case "complete":
          // Summary is printed below after runAutomation returns
          break;
      }
    }
  );

  // Summary
  console.log("\n========================================");
  console.log("   Summary");
  console.log("========================================");
  console.log(`Completed: ${result.completed}`);
  console.log(`Skipped: ${result.skipped}`);
  console.log(`Total: ${result.total}`);

  if (result.success) {
    console.log("\n✓ All done!");
  } else {
    console.error(`\n✗ Failed: ${result.error}`);
    process.exit(1);
  }
}

run().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
