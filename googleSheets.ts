import { google } from 'googleapis';
import * as fs from 'fs';
import * as path from 'path';

// Google Sheets configuration
let sheets: any = null;
let isGoogleSheetsEnabled = false;

// Initialize Google Sheets API
export const initializeGoogleSheets = async (credentialsPath: string, spreadsheetId: string) => {
    try {
        // Read credentials file
        const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));

        // Create auth client
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        // Get sheets API
        sheets = google.sheets({ version: 'v4', auth });
        isGoogleSheetsEnabled = true;

        console.log('✅ Google Sheets integration initialized');
        return { success: true, spreadsheetId };
    } catch (error: any) {
        console.error('❌ Failed to initialize Google Sheets:', error.message);
        isGoogleSheetsEnabled = false;
        return { success: false, error: error.message };
    }
};

// Append a single message to Google Sheet
export const appendMessageToSheet = async (
    spreadsheetId: string,
    sheetName: string,
    timestamp: string,
    sender: string,
    message: string,
    groupName: string
) => {
    return appendBatchToSheet(spreadsheetId, sheetName, [[timestamp, groupName, sender, message]]);
};

// Append multiple messages to Google Sheet in one API call
export const appendBatchToSheet = async (
    spreadsheetId: string,
    sheetName: string,
    rows: string[][]
) => {
    if (!isGoogleSheetsEnabled || !sheets) {
        console.log('Google Sheets not enabled, skipping...');
        return { success: false, error: 'Google Sheets not initialized' };
    }

    try {
        const response = await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `${sheetName}!A:D`,
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            requestBody: {
                values: rows,
            },
        });

        console.log(`✅ ${rows.length} messages written to Google Sheets: ${response.data.updates?.updatedCells} cells updated`);
        return { success: true, response: response.data };
    } catch (error: any) {
        console.error('❌ Failed to write to Google Sheets:', error.message);
        return { success: false, error: error.message };
    }
};

// Create sheet with headers if it doesn't exist
export const ensureSheetExists = async (spreadsheetId: string, sheetName: string) => {
    if (!isGoogleSheetsEnabled || !sheets) {
        return { success: false, error: 'Google Sheets not initialized' };
    }

    try {
        // Get spreadsheet to check if sheet exists
        const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
        const sheetExists = spreadsheet.data.sheets?.some(
            (sheet: any) => sheet.properties?.title === sheetName
        );

        if (!sheetExists) {
            // Create the sheet
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [
                        {
                            addSheet: {
                                properties: {
                                    title: sheetName,
                                },
                            },
                        },
                    ],
                },
            });
            console.log(`✅ Created new sheet: ${sheetName}`);
        }

        // Check if headers exist
        const headerResponse = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!A1:D1`,
        });

        if (!headerResponse.data.values || headerResponse.data.values.length === 0) {
            // Add headers
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `${sheetName}!A1:D1`,
                valueInputOption: 'RAW',
                requestBody: {
                    values: [['Timestamp', 'Group Name', 'Sender', 'Message']],
                },
            });
            console.log(`✅ Added headers to sheet: ${sheetName}`);
        }

        return { success: true };
    } catch (error: any) {
        console.error('❌ Failed to ensure sheet exists:', error.message);
        return { success: false, error: error.message };
    }
};

export const getGoogleSheetsStatus = () => {
    return {
        enabled: isGoogleSheetsEnabled,
        ready: isGoogleSheetsEnabled && sheets !== null,
    };
};
