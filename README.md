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

- Node.js 18+
- npm

### Local Development

```bash
# Install dependencies
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
- Mount `credentials.json` and load `.env` for Google Sheets integration (if configured)
- Persist WhatsApp authentication and cache across restarts
- Save message logs to `data/` directory on your host machine

## Google Sheets Integration (Optional)

### 1. Create a Google Cloud Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project and enable the **Google Sheets API**
3. Create a **Service Account** under "APIs & Services" > "Credentials"
4. Generate a JSON key and save it as `credentials.json` in the project root

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
GOOGLE_SHEETS_CREDENTIALS_PATH=./credentials.json
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

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/status` | Connection status, current group, available groups |
| POST | `/read-messages` | Fetch messages (`{ groupName, messageLimit, sinceDate, deleteMessages }`) |
| GET | `/download-log` | Download the message log file |
| POST | `/configure-sheets` | Configure Google Sheets at runtime |
| GET | `/sheets-status` | Google Sheets configuration status |

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
│   │   └── googleSheets.ts    # Google Sheets API integration
│   └── utils/
│       └── logger.ts          # File logging utility
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

**Messages not deleting** - Only your own messages can be deleted for everyone. Others' messages can only be deleted for yourself.

**Google Sheets errors** - Verify the sheet is shared with the service account email and that the spreadsheet ID is correct. Check `/sheets-status`.

## Security Notes

- Never commit `credentials.json` or `.env` to version control
- Don't expose port 3000 publicly without authentication
- Review WhatsApp's terms of service regarding automation

## License

[MIT](LICENSE)
