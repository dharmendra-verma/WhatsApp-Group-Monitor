import * as fs from 'fs';
import * as path from 'path';

const LOG_FILE = path.join(__dirname, '..', '..', 'data', 'GP_read_history.txt');

export const appendToLog = (text: string) => {
    console.log('Writing message to file: ' + text);
    fs.appendFileSync(LOG_FILE, text + '\n');
};

export const getLogFilePath = (): string => LOG_FILE;
