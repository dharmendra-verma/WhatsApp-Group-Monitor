import { google } from 'googleapis';
import * as fs from 'fs';

let sheets: any = null;
let isGoogleSheetsEnabled = false;

export const initializeGoogleSheets = async (credentialsPath: string, spreadsheetId: string) => {
    try {
        const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));

        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

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

export const appendBatchToSheet = async (
    spreadsheetId: string,
    sheetName: string,
    rows: string[][]
) => appendRowsToSheet(spreadsheetId, sheetName, rows, 'A:D');

export const appendRowsToSheet = async (
    spreadsheetId: string,
    sheetName: string,
    rows: string[][],
    columns: string = 'A:D'
) => {
    if (!isGoogleSheetsEnabled || !sheets) {
        console.log('Google Sheets not enabled, skipping...');
        return { success: false, error: 'Google Sheets not initialized' };
    }

    try {
        const response = await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `${sheetName}!${columns}`,
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

export const isSheetsReady = () => isGoogleSheetsEnabled && sheets !== null;

/** All values of one column (index 0 = row 1). */
export const readColumn = async (spreadsheetId: string, sheetName: string, column: string): Promise<string[]> => {
    if (!isSheetsReady()) return [];
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!${column}:${column}`,
    });
    return (res.data.values || []).map((r: any[]) => (r && r[0] != null ? String(r[0]) : ''));
};

/** Write several ranges in one call. */
export const updateCells = async (
    spreadsheetId: string,
    data: { range: string; values: string[][] }[]
) => {
    if (!isSheetsReady()) return { success: false, error: 'Google Sheets not initialized' };
    try {
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: { valueInputOption: 'RAW', data },
        });
        return { success: true };
    } catch (error: any) {
        console.error('❌ Failed to update Google Sheets cells:', error.message);
        return { success: false, error: error.message };
    }
};

/** Fill header cells only if they are empty (never overwrites). */
export const ensureHeaderCells = async (
    spreadsheetId: string,
    sheetName: string,
    range: string,
    headers: string[]
) => {
    if (!isSheetsReady()) return;
    try {
        const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!${range}` });
        if (!res.data.values || res.data.values.length === 0) {
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `${sheetName}!${range}`,
                valueInputOption: 'RAW',
                requestBody: { values: [headers] },
            });
        }
    } catch (error: any) {
        console.error('❌ Failed to ensure header cells:', error.message);
    }
};

export const ensureSheetExists = async (spreadsheetId: string, sheetName: string) => {
    if (!isGoogleSheetsEnabled || !sheets) {
        return { success: false, error: 'Google Sheets not initialized' };
    }

    try {
        const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
        const sheetExists = spreadsheet.data.sheets?.some(
            (sheet: any) => sheet.properties?.title === sheetName
        );

        if (!sheetExists) {
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

        const headerResponse = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!A1:D1`,
        });

        if (!headerResponse.data.values || headerResponse.data.values.length === 0) {
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
