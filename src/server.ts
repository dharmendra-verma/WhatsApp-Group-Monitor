import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { initializeGoogleSheets, ensureSheetExists } from './services/googleSheets';
import { initializeClient, setGoogleSheetsConfig } from './services/whatsapp';
import statusRoutes from './routes/status';
import messageRoutes from './routes/messages';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json());

// Register routes
app.use(statusRoutes);
app.use(messageRoutes);

// Start server
app.listen(PORT, async () => {
    console.log(`Server running on http://localhost:${PORT}`);

    // Initialize Google Sheets from environment variables if configured
    const credentialsPath = process.env.GOOGLE_SHEETS_CREDENTIALS_PATH;
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    const sheetName = process.env.GOOGLE_SHEETS_SHEET_NAME || 'WhatsApp Messages';

    if (credentialsPath && spreadsheetId) {
        console.log('🔧 Initializing Google Sheets from environment variables...');
        const result = await initializeGoogleSheets(credentialsPath, spreadsheetId);

        if (result.success) {
            setGoogleSheetsConfig(spreadsheetId, sheetName);
            await ensureSheetExists(spreadsheetId, sheetName);
            console.log(`✅ Google Sheets configured: Sheet "${sheetName}"`);
        } else {
            console.error(`❌ Failed to initialize Google Sheets: ${result.error}`);
        }
    } else {
        console.log('ℹ️  Google Sheets not configured (set GOOGLE_SHEETS_CREDENTIALS_PATH and GOOGLE_SHEETS_SPREADSHEET_ID in .env)');
    }

    initializeClient();
});
