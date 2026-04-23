'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const JOB_CHANNELS = Object.freeze([
    'job-started',
    'job-event',
    'job-log',
    'job-finished',
]);

contextBridge.exposeInMainWorld('api', {
    settings: {
        get: () => ipcRenderer.invoke('settings:get'),
        update: (patch) => ipcRenderer.invoke('settings:update', patch),
        reset: () => ipcRenderer.invoke('settings:reset'),
    },
    history: {
        list: () => ipcRenderer.invoke('history:list'),
        clear: () => ipcRenderer.invoke('history:clear'),
        remove: (id) => ipcRenderer.invoke('history:remove', id),
    },
    downloads: {
        start: (request) => ipcRenderer.invoke('download:start', request),
        cancel: (jobId) => ipcRenderer.invoke('download:cancel', jobId),
        active: () => ipcRenderer.invoke('download:active'),
        on: (channel, handler) => {
            if (!JOB_CHANNELS.includes(channel)) return () => {};
            const listener = (_event, payload) => handler(payload);
            ipcRenderer.on(channel, listener);
            return () => ipcRenderer.removeListener(channel, listener);
        },
    },
    dialogs: {
        pickFolder: (options) => ipcRenderer.invoke('dialog:pickFolder', options || {}),
    },
    shell: {
        openPath: (target) => ipcRenderer.invoke('shell:openPath', target),
        showItem: (target) => ipcRenderer.invoke('shell:showItem', target),
    },
    app: {
        meta: () => ipcRenderer.invoke('app:meta'),
    },
});
