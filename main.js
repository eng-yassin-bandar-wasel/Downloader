'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PYTHON_BIN = process.env.YT_SUB_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const HISTORY_CAP = 200;

const DEFAULT_SETTINGS = Object.freeze({
    defaultLanguage: 'en',
    outputDirectory: path.join(app.getPath('downloads'), 'YT-Subtitles'),
    subtitleFormat: 'srt',
    accent: 'violet',
    maxConcurrent: 3,
    keepHistory: true,
});

const DATA_DIR = app.getPath('userData');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

// ---------------------------------------------------------------------------
// Persistent storage (JSON files in userData)
// ---------------------------------------------------------------------------

function readJson(file, fallback) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

function writeJson(file, value) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
    } catch (err) {
        console.error(`Failed to write ${file}:`, err);
    }
}

function loadSettings() {
    return { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE, {}) };
}

function saveSettings(partial) {
    const next = { ...loadSettings(), ...partial };
    writeJson(SETTINGS_FILE, next);
    return next;
}

function loadHistory() {
    const entries = readJson(HISTORY_FILE, []);
    return Array.isArray(entries) ? entries : [];
}

function saveHistory(entries) {
    writeJson(HISTORY_FILE, entries.slice(0, HISTORY_CAP));
}

function addHistoryEntry(entry) {
    const settings = loadSettings();
    if (!settings.keepHistory) return;
    const entries = [entry, ...loadHistory().filter((e) => e.id !== entry.id)];
    saveHistory(entries);
}

// ---------------------------------------------------------------------------
// Download job manager
// ---------------------------------------------------------------------------

/** @type {Map<string, { child: import('child_process').ChildProcess, meta: object }>} */
const jobs = new Map();

function broadcast(window, channel, payload) {
    if (window && !window.isDestroyed()) {
        window.webContents.send(channel, payload);
    }
}

function startDownload(window, request) {
    const settings = loadSettings();
    const jobId = request.jobId || randomUUID();
    const lang = request.lang || settings.defaultLanguage;
    const outputDir = request.outputDir || settings.outputDirectory;
    const subtitleFormat = request.subtitleFormat || settings.subtitleFormat;

    fs.mkdirSync(outputDir, { recursive: true });

    const enginePath = path.join(__dirname, 'engine.py');
    const args = [
        enginePath,
        '--url', request.url,
        '--lang', lang,
        '--output-dir', outputDir,
        '--format', subtitleFormat,
        '--job-id', jobId,
    ];

    const child = spawn(PYTHON_BIN, args, { shell: false });
    const meta = {
        id: jobId,
        url: request.url,
        lang,
        outputDir,
        subtitleFormat,
        startedAt: Date.now(),
        title: null,
    };
    jobs.set(jobId, { child, meta });

    broadcast(window, 'job-started', { ...meta });

    child.stdout.on('data', (chunk) => {
        const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
            let payload;
            try {
                payload = JSON.parse(line);
            } catch {
                broadcast(window, 'job-log', { jobId, line });
                continue;
            }
            if (payload.event === 'started' && payload.title) {
                meta.title = payload.title;
                meta.directory = payload.directory;
            }
            broadcast(window, 'job-event', { ...payload, jobId: payload.jobId || jobId });
        }
    });

    child.stderr.on('data', (chunk) => {
        const message = chunk.toString().trim();
        if (message) broadcast(window, 'job-log', { jobId, line: message });
    });

    child.on('close', (code) => {
        jobs.delete(jobId);
        const finishedAt = Date.now();
        const success = code === 0;
        const entry = {
            ...meta,
            finishedAt,
            status: success ? 'success' : 'failed',
            exitCode: code,
        };
        addHistoryEntry(entry);
        broadcast(window, 'job-finished', entry);
    });

    return jobId;
}

function cancelDownload(jobId) {
    const job = jobs.get(jobId);
    if (!job) return false;
    try {
        job.child.kill('SIGTERM');
    } catch (err) {
        console.error('Failed to cancel job', jobId, err);
    }
    return true;
}

// ---------------------------------------------------------------------------
// Window lifecycle
// ---------------------------------------------------------------------------

let mainWindow = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1080,
        minHeight: 720,
        show: false,
        backgroundColor: '#0a0a0b',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            webviewTag: true,
            sandbox: false,
        },
    });

    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile('index.html');
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC surface
// ---------------------------------------------------------------------------

ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:update', (_event, patch) => saveSettings(patch || {}));
ipcMain.handle('settings:reset', () => {
    writeJson(SETTINGS_FILE, { ...DEFAULT_SETTINGS });
    return loadSettings();
});

ipcMain.handle('history:list', () => loadHistory());
ipcMain.handle('history:clear', () => {
    saveHistory([]);
    return [];
});
ipcMain.handle('history:remove', (_event, id) => {
    const entries = loadHistory().filter((e) => e.id !== id);
    saveHistory(entries);
    return entries;
});

ipcMain.handle('dialog:pickFolder', async (event, { defaultPath } = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: defaultPath || loadSettings().outputDirectory,
        title: 'Choose subtitle output folder',
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
});

ipcMain.handle('shell:openPath', async (_event, target) => {
    if (!target) return false;
    const err = await shell.openPath(target);
    return !err;
});

ipcMain.handle('shell:showItem', (_event, target) => {
    if (!target) return false;
    shell.showItemInFolder(target);
    return true;
});

ipcMain.handle('app:meta', () => ({
    version: app.getVersion(),
    platform: process.platform,
    home: os.homedir(),
    userData: DATA_DIR,
}));

ipcMain.handle('download:start', (event, request) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    return startDownload(win, request || {});
});

ipcMain.handle('download:cancel', (_event, jobId) => cancelDownload(jobId));

ipcMain.handle('download:active', () =>
    [...jobs.values()].map(({ meta }) => ({ ...meta })),
);
