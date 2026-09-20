# WhatsApp Group Monitor

A Dockerized web application to monitor, archive, and manage messages from WhatsApp groups. Supports logging to local files and Google Sheets.

## Features

- **Web UI** - Clean, modern interface accessible from any browser
- **QR Code Authentication** - Easy WhatsApp Web authentication via QR code
- **On-Demand Message Reading** - Fetch messages with a button click
- **Configurable Group Selection** - Select any WhatsApp group from a dropdown or type manually
- **Optional Auto-Delete** - Choose to delete messages after archiving
- **Google Sheets Integration** - Automatically log messages to Google Sheets
- **Message Logging** - All messages saved to a local log file
- **Download Logs** - Download complete message history
- **Docker Support** - Easy deployment with Docker Compose
- **Real-time Monitoring** - Background monitoring of the selected group

## Quick Start

### Prerequisites

- Node.js 20+
- npm

### Local Development

```bash
# Install dependencies (also applies the whatsapp-web.js compat patch, see below)
npm install

# Start the server
npm start
```

Open `http://localhost:3000`, scan the QR code with WhatsApp, and start reading messages.

### Using Docker

```bash
docker-compose up -d --build
```

Open `http://localhost:3000` and scan the QR code.

Docker will automatically:
- Mount the `secrets/` folder (put `credentials.json` there) and load `.env` for Google Sheets integration (if configured)
- Persist WhatsApp authentication and cache across restarts
- Save message logs to `data/` directory on your host machine

## Google Sheets Integration (Optional)

### 1. Create a Google Cloud Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project and enable the **Google Sheets API**
3. Create a **Service Account** under "APIs & Services" > "Credentials"
4. Generate a JSON key and save it as `secrets/credentials.json`

### 2. Create and Share a Google Sheet

1. Create a new Google Sheet
2. Copy the **Spreadsheet ID** from the URL: `https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit`
3. Share the sheet with the service account email (found in `credentials.json` as `client_email`) with **Editor** permission

### 3. Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
GOOGLE_SHEETS_CREDENTIALS_PATH=./secrets/credentials.json
GOOGLE_SHEETS_SPREADSHEET_ID=your_spreadsheet_id_here
GOOGLE_SHEETS_SHEET_NAME=WhatsApp Messages
```

Restart the server after updating `.env`. Messages will automatically appear in your Google Sheet.

You can verify the configuration at `http://localhost:3000/sheets-status`.

## Usage

1. **Authenticate** - Scan the QR code displayed in the web UI with your WhatsApp app
2. **Select Group** - Choose a group from the dropdown or type a group name
3. **Read Messages** - Click "Read Messages" to fetch the last 10 messages
4. **Auto-Delete** - Optionally check "Delete messages after reading"
5. **Download Logs** - Click "Download Log File" for the complete message history

## Pipelines (automatic, multi-group)

Pipelines watch configured groups on a timer (no button click) and hand each new
message to downstream tools through plain files on a mounted folder.

| Action | What it does |
|---|---|
| `media` | Downloads attachments (default: images + PDFs) into `dir` as `WA_<YYYY-MM-DD_HHMMSS>_<sender>_<id>.<ext>`, and appends a line to `_whatsapp-manifest.jsonl` with the caption, sender and time. Text-only messages are logged to the manifest too. |
| `sheet` | Appends `Timestamp, Group, Sender, Message, Message ID, Status, Output` (A:G) to the Google Sheet. |
| `queue` | Hands `{msgId, group, sender, timestamp, text, urls}` to a processor. With `dir`: one file per message, `<dir>/pending/<YYYY-MM-DD_HHMMSS>_<id>.json`; the processor **moves** it to `<dir>/processed/…` when done, so `pending/` always shows exactly what is waiting. (Legacy `file`: one append-only JSONL.) `onlyWithUrls` skips messages without a link. |
| `deleteAfterCapture` | `"me"` or `"everyone"`: delete the WhatsApp message once it is **captured durably** (attachment saved, manifest/queue written, or sheet row written) — never before, and never a message whose attachment type is not saved. Retried each poll, up to 3 attempts. `"me"` removes it cleanly on all your linked devices; `"everyone"` revokes it for all members where WhatsApp allows (own message, recent) and leaves a "This message was deleted" bubble. Omit to keep messages. |
| `results` | Reads a JSONL file written **by** the processor (`{msgId, status, output, note}`) and writes Status/Output back into that message's sheet row. |

Delivery is at-least-once: a message is marked seen (in `stateFile`) only after its
media/queue actions succeed, so failures are retried on the next poll (consumers
should de-duplicate on `msgId`). The sheet row is best effort: a Sheets outage shows
up in `/pipelines-status` but never stalls the folder/queue hand-off.
On the very first run, `backfillHours` limits how far back it looks.

Setup:

1. Copy `pipelines.example.json`, set the exact group names and folders.
2. Mount it and the target folders, and point `PIPELINES_CONFIG` at it:

```yaml
    environment:
      - PIPELINES_CONFIG=/app/config/pipelines.json
    volumes:
      - ./pipelines.json:/app/config/pipelines.json:ro
      - "C:/path/to/receipts:/app/drops/receipts"
      - "C:/path/to/reading-inbox:/app/drops/reading"
```

3. Check `GET /pipelines-status`; force an immediate poll with `POST /pipelines/run`.

Tests: `npm test`.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/status` | Connection status, current group, available groups |
| POST | `/read-messages` | Fetch messages (`{ groupName, messageLimit, sinceDate, deleteMessages }`) |
| GET | `/download-log` | Download the message log file |
| POST | `/configure-sheets` | Configure Google Sheets at runtime |
| GET | `/sheets-status` | Google Sheets configuration status |
| GET | `/pipelines-status` | Pipelines config, per-group watermark, last run and errors |
| POST | `/pipelines/run` | Poll all pipelines now |

## Project Structure

```
WhatsApp/
├── src/
│   ├── server.ts              # Express app entry point
│   ├── routes/
│   │   ├── status.ts          # Status & Google Sheets config endpoints
│   │   └── messages.ts        # Message fetching & log download endpoints
│   ├── services/
│   │   ├── whatsapp.ts        # WhatsApp client & message processing
│   │   ├── pipelines.ts       # Automatic multi-group routing (media / sheet / queue)
│   │   └── googleSheets.ts    # Google Sheets API integration
│   └── utils/
│       └── logger.ts          # File logging utility
├── scripts/
│   └── patch-wwebjs.js        # postinstall compat patch for whatsapp-web.js
├── public/
│   ├── index.html             # Web UI
│   ├── styles.css             # Styling
│   └── script.js              # Client-side JavaScript
├── data/                      # Runtime output (message logs)
├── Dockerfile                 # Docker configuration
├── docker-compose.yml         # Docker Compose setup
├── .env.example               # Environment variable template
├── package.json               # Dependencies
└── tsconfig.json              # TypeScript configuration
```

## Troubleshooting

**QR Code not showing** - Wait a few seconds for initialization, then check the browser console.

**Authentication fails** - Delete the `.wwebjs_auth` folder and restart. If using Docker, remove the auth volume: `docker volume rm whatsapp_whatsapp-auth`.

**QR scanned but nothing happens** - After scanning, the log shows `Authenticated` and `Loading WhatsApp: N%`. Large accounts can take 10-15 minutes before `Client is ready!`. Keep the phone online meanwhile. Avoid re-scanning repeatedly: WhatsApp then temporarily blocks linking ("Can't link new devices right now").

**"Unable to load chats" / `r: r` errors** - WhatsApp Web renamed message-key fields (`_serialized` -> `$1`), which breaks `whatsapp-web.js` <= 1.34.7. `scripts/patch-wwebjs.js` (run automatically on `npm install` / Docker build) fixes this; check the install output for `[patch-wwebjs] ... patched`. Once an upstream release includes the fix, the script skips itself.

**"The profile appears to be in use by another computer"** - Stale Chromium lock after the container was recreated. The app removes these locks on startup; the fixed `hostname` in `docker-compose.yml` also prevents it.

**Messages not deleting** - Only your own messages can be deleted for everyone. Others' messages can only be deleted for yourself.

**Google Sheets errors** - Verify the sheet is shared with the service account email and that the spreadsheet ID is correct. Check `/sheets-status`.

## Security Notes

- Never commit `credentials.json`, `secrets/` or `.env` to version control
- Don't expose port 3000 publicly without authentication
- Review WhatsApp's terms of service regarding automation

## License

[MIT](LICENSE)
