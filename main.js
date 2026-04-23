const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile('index.html');
  win.once('ready-to-show', () => win.show());
}

app.whenReady().then(createWindow);

ipcMain.on('start-download', (event, data) => {
  const { url, lang } = data;
  const enginePath = path.join(__dirname, 'engine.py');

  const python = spawn('python', [enginePath, url, lang], {
    shell: false,
  });

  python.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
    lines.forEach((line) => {
      try {
        const payload = JSON.parse(line);
        if (payload.event === 'progress') {
          event.reply('download-progress', payload);
        } else if (payload.event === 'complete') {
          event.reply('download-complete', payload.message);
        } else if (payload.event === 'error') {
          event.reply('download-error', payload.message);
        }
      } catch {
        event.reply('download-status', line);
      }
    });
  });

  python.stderr.on('data', (chunk) => {
    event.reply('download-error', chunk.toString().trim());
  });

  python.on('close', (code) => {
    if (code !== 0) {
      event.reply('download-status', `Download process exited with code ${code}.`);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
