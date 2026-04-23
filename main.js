const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile('index.html');
}

app.whenReady().then(createWindow);

ipcMain.on('start-download', (event, data) => {
  const { url, lang } = data;

  const python = spawn('python', ['engine.py', url, lang]);

  python.stdout.on('data', (output) => {
    const result = output.toString().trim();
    // إرسال إشعار الانتهاء للواجهة
    event.reply('download-complete', result);
  });

  python.stderr.on('data', (error) => {
    event.reply('download-error', error.toString().trim());
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
