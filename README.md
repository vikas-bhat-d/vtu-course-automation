# VTU Autopilot 🚀

> Auto-complete VTU online courses. Because 166 lectures is not it.

**VTU Autopilot** is an intelligent automation tool for completing VTU online courses. It automates marking lectures as complete with parallel processing, intelligent retries, real-time progress tracking, and a modern web UI.

---

## Features ✨

- ⚡ **Parallel Processing** - Process multiple lectures simultaneously (configurable batch size)
- 🔄 **Intelligent Retry Logic** - Automatic session refresh and exponential backoff
- 📊 **Real-Time Progress** - Server-Sent Events (SSE) for live job updates
- 🎯 **Job Queue Management** - Queue multiple jobs, process sequentially with concurrency control
- 🔐 **Session Management** - Automatic re-authentication when sessions expire
- 📈 **Statistics Tracking** - Redis integration for job analytics and metrics
- 🛡️ **Rate Limiting** - Built-in rate limiting to prevent API throttling
- 🖥️ **Modern Web UI** - Frontend dashboard for job submission and monitoring
- 📝 **Dual Interface** - CLI + REST API + Web UI

---

## Project Structure

```
vtu-course-automation/
├── automation.js          # Core automation engine
├── server.js              # Express server + job queue + SSE
├── index.js               # CLI interface
├── lib/
│   └── redis.js          # Redis client & statistics
├── frontend/
│   └── index.html        # Web dashboard
├── public/
│   └── index.html        # Static assets
├── package.json          # Dependencies
├── stats.json            # Performance metrics
└── oec-pec-automation-data.json  # Course data cache
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Backend** | Node.js, Express |
| **HTTP Client** | Axios with cookie support |
| **Cache/Stats** | Upstash Redis (optional) |
| **Session Management** | tough-cookie |
| **Rate Limiting** | express-rate-limit |
| **Real-Time** | Server-Sent Events (SSE) |

---

## Installation

### Prerequisites
- Node.js 14+ 
- npm or yarn
- VTU account credentials
- (Optional) Upstash Redis URL & token for statistics

### Setup

1. **Clone & Install**
   ```bash
   git clone <repo>
   cd vtu-course-automation
   npm install
   ```

2. **Configure Environment** *(CLI tool only)*
   
   ⚠️ **Credentials are required ONLY if using the CLI tool.**
   
   If running the **web server** (`npm run serve`), skip this step — credentials are passed via API request body.
   
   For CLI usage:
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env`:
   ```env
   # ── VTU Account (REQUIRED for CLI, optional for server) ──
   VTU_EMAIL=your-email@gmail.com
   VTU_PASSWORD=your-password
   VTU_COURSE_SLUG=1-social-networks
   
   # ── API Configuration (optional) ──────────────────────
   VTU_API_BASE_URL=https://online.vtu.ac.in/api/v1
   VTU_BATCH_SIZE=10
   VTU_MAX_ATTEMPTS=50
   
   # ── Server Configuration ──────────────────────────────
   PORT=3000
   MAX_CONCURRENT=2
   
   # ── Redis (optional, for statistics) ──────────────────
   KV_REST_API_URL=https://your-redis.upstash.io
   KV_REST_API_TOKEN=your-token
   ```

3. **Start Server or CLI**
   ```bash
   npm run serve       # Web server (no .env credentials needed)
   npm run dev         # Dev server with auto-reload
   npm start           # CLI tool (requires .env credentials)
   ```

---

## Usage

### CLI Mode *(Credentials required in .env)*
Run automation directly from command line with credentials from `.env`:
```bash
npm start
```
Credentials must be set in `.env` file (VTU_EMAIL, VTU_PASSWORD).

### Web UI Mode *(No .env credentials needed)*
Start the server and submit jobs via web interface without storing credentials:
```bash
npm run serve
# Open http://localhost:3000
```
Submit job with:
- **Email** - VTU login email (via web form)
- **Password** - VTU login password (via web form)
- **Course Slug** - e.g., `1-social-networks`
- **Batch Size** - Lectures per batch (default: 10)
- **Max Attempts** - Retry limit per lecture (default: 50)

Monitor progress in real-time with live updates.

### REST API *(No .env credentials needed)*

**POST** `/api/jobs` - Create new automation job
```json
{
  "email": "user@gmail.com",
  "password": "password",
  "courseSlug": "1-social-networks",
  "batchSize": 10,
  "maxAttempts": 50
}
```

**GET** `/api/jobs/:jobId` - Get job status
```json
{
  "id": "uuid",
  "status": "processing|completed|failed",
  "position": 5,
  "progress": 45,
  "logs": [...],
  "result": { "completed": 120, "skipped": 46, "total": 166 }
}
```

**GET** `/api/jobs/:jobId/stream` - SSE stream for real-time updates
```
event: log
data: {"text":"Logged in successfully","level":"success"}

event: progress
data: {"processed":10,"total":166,"progress":6}
```

---

## Configuration

| Variable | Default | Required For | Description |
|----------|---------|-----|-------------|
| `VTU_EMAIL` | - | **CLI only** | VTU account email |
| `VTU_PASSWORD` | - | **CLI only** | VTU account password |
| `VTU_COURSE_SLUG` | `1-social-networks` | CLI only | Course URL slug |
| `VTU_API_BASE_URL` | `https://online.vtu.ac.in/api/v1` | Optional | VTU API endpoint |
| `VTU_BATCH_SIZE` | `10` | Optional | Lectures processed in parallel per batch |
| `VTU_MAX_ATTEMPTS` | `50` | Optional | Max retry attempts per lecture |
| `PORT` | `3000` | Optional | Server port |
| `MAX_CONCURRENT` | `2` | Optional | Max concurrent jobs in queue |
| `KV_REST_API_URL` | - | Optional | Redis URL (for statistics) |
| `KV_REST_API_TOKEN` | - | Optional | Redis token (for statistics) |

**Key Point:** 
- ✅ Web server & REST API: **No** `.env` credentials needed (pass via request body)
- ✅ CLI tool: **Yes** `.env` credentials needed (or it will show error)

---

## How It Works

### Automation Flow

```
1. Authentication
   ├─ Login with VTU credentials
   ├─ Establish session with cookie jar
   └─ Store authentication state

2. Course Fetch
   ├─ Retrieve course metadata
   ├─ List all lectures/modules
   └─ Calculate total lectures

3. Batch Processing
   ├─ Group lectures by batch size
   ├─ Process each batch in parallel
   ├─ Track progress per lecture
   └─ Implement exponential backoff

4. Progress Update Loop
   ├─ Send progress update (1-100%)
   ├─ Wait for completion acknowledgment
   ├─ Retry on failure/timeout
   └─ Repeat until 100% reached

5. Result Aggregation
   ├─ Count completed lectures
   ├─ Count skipped lectures
   ├─ Record statistics
   └─ Return final report
```

### Session Management

- **Automatic Re-login**: Detects 401/419/403 responses and refreshes session
- **Cookie Persistence**: Uses tough-cookie for session cookies across requests
- **Timeout Handling**: 30-second timeout per request with automatic retry

---

## Example Output

```
========================================
   VTU Autopilot
========================================
✓ Logged in successfully
  User: Vikas Bhat D

✓ Found 166 lectures across 12 weeks

========================================
   Processing Lectures (Parallel: 10/batch)...
========================================

Batch 1/17 (10 lectures):
[1/166] Introduction
  Duration: 00:08:55
  [Attempt 1] 50% | Completed: false
  [Attempt 2] 100% | Completed: true
  ✓ Success!

[2/166] Advanced Topics
  [Attempt 1] 100% | Completed: true
  ✓ Success!

...

Final Results:
  ✓ Completed: 120
  ⊘ Skipped: 46
  Total: 166
  Success Rate: 72.3%
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `Login failed` | Verify credentials in `.env` are correct |
| `Session expired` | Tool auto-retries, but check if VTU API is accessible |
| `Course not found` | Ensure course slug is correct (from VTU URL) |
| `Timeout errors` | Increase `VTU_MAX_ATTEMPTS` or check network connectivity |
| `Rate limited` | Add delays between requests or reduce `VTU_BATCH_SIZE` |

---

## Security

- ⚠️ **Never commit `.env` file** - it contains sensitive credentials
- 🔒 Use environment variables for production deployments
- 🛡️ Keep credentials safe and rotate regularly
- 🔐 Use HTTPS in production

---

## Performance Metrics

Typical performance on modern hardware:

- **Login**: ~1-2 seconds
- **Fetch lectures**: ~2-3 seconds (500+ lectures)
- **Per lecture completion**: ~0.5-1.5 seconds
- **Full course (166 lectures)**: ~10-15 minutes with batch size 10

Current instance stats saved in `stats.json`.

---

## API Response Formats

### Job Status Response
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "processing",
  "position": 3,
  "logs": [
    { "text": "✓ Logged in successfully", "level": "success", "timestamp": 1234567890 },
    { "text": "✓ Found 166 lectures", "level": "success", "timestamp": 1234567891 }
  ],
  "total": 166,
  "processed": 45,
  "progress": 27,
  "createdAt": "2024-04-21T10:30:00Z"
}
```

### Job Result
```json
{
  "success": true,
  "completed": 120,
  "skipped": 46,
  "total": 166,
  "duration": "12m 34s"
}
```

---

## License

MIT © Vikas Bhat D

---

## Contributing

Contributions welcome! Feel free to submit issues or PRs.

**GitHub**: [vikas-bhat-d/vtu-course-automation](https://github.com/vikas-bhat-d/vtu-course-automation)
   Summary
========================================
Processed: 166
Skipped: 0
Total: 166

✓ All done!
```

## Troubleshooting

**Error: Missing credentials in .env file**
- Ensure `.env` file exists and has `VTU_EMAIL` and `VTU_PASSWORD` set

**Error: Login failed**
- Check your email and password in `.env`
- Make sure your VTU account is active

**Progress stuck at lower percentage**
- Increase `VTU_MAX_ATTEMPTS` in `.env`
- Check your internet connection

## Security

⚠️ **Never commit `.env` to version control!**

The `.gitignore` file already excludes:
- `.env` - Your actual credentials
- `credentials.json` - Legacy credentials file
- `oec-pec-automation-data.json` - Legacy config file

## Other Scripts

### Diary Automation
```bash
npm run start:dairy
```

Uses `index.js` for internship diary automation.

## Run Locally (3 Commands)

Already have **Git** and **Node.js** installed? Run VTU Autopilot on your own system in 3 commands — no external servers needed. This saves resources for other students.

```bash
git clone https://github.com/vikas-bhat-d/vtu-course-automation && cd vtu-course-automation && npm install
npm run serve
```

Then open **http://localhost:3000** in your browser. That's it!

**Why run locally?**
- 🔒 Your credentials stay on your machine
- ⚡ Faster processing (no server queue)
- 🌍 Saves bandwidth for students using the web UI
- 📴 Works even with intermittent internet (local retries)

## License

ISC
