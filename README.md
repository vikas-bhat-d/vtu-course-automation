# VTU Lecture Automation

Automate marking all lectures as complete on VTU Online platform.

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Create a `.env` file in the project root by copying `.env.example`:

```bash
cp .env.example .env
```

Then edit `.env` and add your credentials:

```env
# VTU Account Credentials
VTU_EMAIL=your-email@gmail.com
VTU_PASSWORD=your-password

# Course Configuration
VTU_COURSE_SLUG=1-social-networks

# API Configuration (usually no need to change)
VTU_API_BASE_URL=https://online.vtu.ac.in/api/v1

# Parallel Processing (optional)
VTU_BATCH_SIZE=10
VTU_MAX_ATTEMPTS=100
```

**Important:** The `.env` file is **NOT** tracked in git. Never commit it. Keep it safe.

### 3. Run the Script

```bash
npm run start:course
```

Or directly:

```bash
node automate-lectures.js
```

## How It Works

1. **Login** - Authenticates with VTU using credentials from `.env`
2. **Fetch Lectures** - Gets all lectures from the specified course
3. **Process in Parallel** - Marks lectures as complete in batches (default: 10 at a time)
4. **Progress Updates** - Repeatedly sends progress updates until each lecture reaches 100%

## Configuration Options

| Variable | Default | Description |
|----------|---------|-------------|
| `VTU_EMAIL` | - | Your VTU login email (required) |
| `VTU_PASSWORD` | - | Your VTU login password (required) |
| `VTU_COURSE_SLUG` | `1-social-networks` | Course slug from the URL |
| `VTU_API_BASE_URL` | `https://online.vtu.ac.in/api/v1` | VTU API base URL |
| `VTU_BATCH_SIZE` | `10` | Number of lectures to process in parallel |
| `VTU_MAX_ATTEMPTS` | `100` | Max retry attempts per lecture |

## Output Example

```
========================================
   VTU Lecture Progress Automation
========================================
Course: 1-social-networks
API Base: https://online.vtu.ac.in/api/v1
Batch Size: 10
Max Attempts: 100

✓ Logged in successfully
User: Vikas Bhat D

✓ Found 166 lectures across 12 weeks

========================================
   Processing Lectures (Parallel: 10/batch)...
========================================

Batch 1/17 (10 lectures):
[1/166] Processing: Introduction
  Duration: 00:08:55 mins (535s)
  Starting progressive updates...
  [Attempt 1] Progress: 50% | Completed: false
  [Attempt 2] Progress: 100% | Completed: true
  ✓ Success! Lecture marked as 100% complete
  ...

========================================
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

## License

ISC
