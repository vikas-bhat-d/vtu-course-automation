# VTU Autopilot 🚀

> Auto-complete VTU online courses. Because 166 lectures is not it.

**VTU Autopilot** automates marking VTU online course lectures as complete — parallel processing, smart retries, real-time progress, and a clean web UI.

---

## Table of Contents

- [VTU Autopilot 🚀](#vtu-autopilot-)
  - [Table of Contents](#table-of-contents)
  - [Features ✨](#features-)
  - [🏠 Run It Yourself (Service down? No problem.)](#-run-it-yourself-service-down-no-problem)
    - [Requirements](#requirements)
    - [Steps](#steps)
    - [No Redis needed](#no-redis-needed)
  - [How It Works](#how-it-works)
    - [Skip reasons](#skip-reasons)
  - [Usage](#usage)
    - [Web UI *(recommended)*](#web-ui-recommended)
    - [CLI *(requires `.env`)*](#cli-requires-env)
    - [Dev mode (auto-reload)](#dev-mode-auto-reload)
  - [Configuration Reference](#configuration-reference)
  - [REST API](#rest-api)
  - [Troubleshooting](#troubleshooting)
  - [Project Structure](#project-structure)
  - [Tech Stack](#tech-stack)
  - [Security](#security)
  - [License](#license)
  - [Contributing](#contributing)
- [Summary](#summary)
  - [Run Locally (3 Commands)](#run-locally-3-commands)
  - [License](#license-1)

---

## Features ✨

- ⚡ **Parallel Processing** — Multiple lectures at once (configurable batch size)
- 🔄 **Intelligent Retry Logic** — Auto session refresh; failed lectures are retried with clear reasons
- 📊 **Real-Time Progress** — Server-Sent Events (SSE) for live updates
- 🎯 **Job Queue** — Multiple jobs queued and processed with concurrency control
- 🔐 **Session Management** — Auto re-authentication on 401/419/403
- 📈 **Statistics** — Redis-backed analytics (optional)
- 🖥️ **Web UI + CLI + REST API**

---

## 🏠 Run It Yourself (Service down? No problem.)

> **The hosted service has limited capacity and may occasionally be unavailable.**  
> If it's down — don't wait. You have Git and Node. Run it locally in under 2 minutes.

### Requirements

- [Git](https://git-scm.com/downloads) (to clone)
- [Node.js 18+](https://nodejs.org/) (LTS recommended)
- Your VTU account credentials

### Steps

**1. Clone and install**
```bash
git clone https://github.com/vikas-bhat-d/vtu-course-automation.git
cd vtu-course-automation
npm install
```

**2. Start the local server**
```bash
npm run serve
```

**3. Open in browser**
```
http://localhost:3000
```

That's it. The web UI is identical to the hosted version — enter your credentials, paste your course slug, and hit go. Nothing is stored anywhere; credentials are only used in memory for the duration of the job.

> **Finding your course slug:** Go to your VTU course page. The slug is the last part of the URL, e.g. `https://online.vtu.ac.in/courses/1-social-networks` → slug is `1-social-networks`.

### No Redis needed

Redis is only used for the public hosted statistics counter. Running locally works perfectly without it — just skip any `KV_REST_API_*` env vars.

---

## How It Works

```
1. Login          → Authenticates with VTU, stores session cookie
2. Fetch Course   → Lists all lectures across all modules
3. Batch Process  → Sends progress updates in parallel batches
4. Retry Pass     → Re-attempts any lectures that failed or hit the attempt cap
5. Report         → Counts completed vs skipped, explains every skip with a reason
```

### Skip reasons

Every skipped lecture now tells you exactly why:

| Status | Reason | Retried? |
|--------|--------|----------|
| `skip` | VTU returned zero duration — no video content exists for this lecture | No — permanent data issue on VTU's side |
| `maxed` | Didn't reach 100% within the attempt limit | Yes — retried once |
| `error` | Network or server error during request | Yes — retried once |

---

## Usage

### Web UI *(recommended)*
```bash
npm run serve
# Open http://localhost:3000
```
Fill in email, password, course slug → submit → watch the live log.

### CLI *(requires `.env`)*
```bash
cp .env.example .env   # fill in VTU_EMAIL, VTU_PASSWORD, VTU_COURSE_SLUG
npm start
```

### Dev mode (auto-reload)
```bash
npm run dev
```

---

## Configuration Reference

| Variable | Default | Required For | Description |
|----------|---------|--------------|-------------|
| `VTU_EMAIL` | — | CLI only | VTU account email |
| `VTU_PASSWORD` | — | CLI only | VTU account password |
| `VTU_COURSE_SLUG` | `1-social-networks` | CLI only | Course URL slug |
| `VTU_BATCH_SIZE` | `10` | Optional | Lectures processed in parallel per batch |
| `VTU_MAX_ATTEMPTS` | `50` | Optional | Max progress-push attempts per lecture |
| `PORT` | `3000` | Optional | Server port |
| `MAX_CONCURRENT` | `2` | Optional | Max concurrent jobs (hosted only) |
| `KV_REST_API_URL` | — | Optional | Upstash Redis URL (statistics only) |
| `KV_REST_API_TOKEN` | — | Optional | Upstash Redis token |

> **Web server / REST API:** credentials are passed in the request body — no `.env` needed.  
> **CLI:** credentials must be in `.env`.

---

## REST API

**POST** `/api/jobs` — Submit a job
```json
{
  "email": "you@gmail.com",
  "password": "yourpassword",
  "courseSlug": "1-social-networks",
  "batchSize": 10,
  "maxAttempts": 50
}
```

**GET** `/api/jobs/:jobId` — Poll job state
```json
{
  "id": "uuid",
  "status": "processing",
  "progress": 45,
  "total": 166,
  "processed": 75,
  "logs": [...]
}
```

**GET** `/api/jobs/:jobId/stream` — SSE stream (real-time events)
```
event: lecture_done
data: {"idx":12,"total":166,"title":"Introduction","status":"skip","reason":"VTU reported zero duration — no video content available for this lecture"}

event: done
data: {"completed":120,"skipped":46,"total":166}
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Login failed` | Check your VTU credentials — same ones you use on the website |
| `Course not found` | Verify the slug from the VTU URL (e.g. `1-social-networks`) |
| Lectures stuck at `maxed` | VTU API may be throttling — try a smaller `batchSize` (e.g. `5`) or increase `maxAttempts` |
| `Network error` / `ECONNRESET` | Transient VTU outage — these are auto-retried; if persistent, try again later |
| Port 3000 already in use | Set `PORT=3001` in your environment before running |
| Hosted site down | **Run it locally** — see [Run It Yourself](#-run-it-yourself-service-down-no-problem) above |

---

## Project Structure

```
vtu-course-automation/
├── automation.js          # Core automation engine
├── server.js              # Express server + job queue + SSE
├── index.js               # CLI entry point
├── lib/
│   └── redis.js           # Redis client & statistics helpers
├── frontend/
│   └── index.html         # Web dashboard (served at /)
├── public/
│   └── index.html         # Static fallback
├── package.json
└── stats.json             # Local stats cache
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js |
| Server | Express |
| HTTP Client | Axios + tough-cookie |
| Real-Time | Server-Sent Events (SSE) |
| Rate Limiting | express-rate-limit |
| Stats (optional) | Upstash Redis |

---

## Security

- Never commit your `.env` file — it's in `.gitignore` for a reason
- Credentials passed to the web UI are held in memory only for the duration of the job and never persisted
- Use HTTPS in any production/hosted deployment

---

## License

MIT © Vikas Bhat D

---

## Contributing

PRs and issues welcome.  
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
