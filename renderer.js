'use strict';

// ===========================================================================
// Subly renderer – UI state machine + IPC wiring
// ===========================================================================

const subly = window.api;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
    settings: null,
    activeJobs: new Map(), // jobId -> meta + progress
    currentTab: 'download',
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const PAGE_META = {
    download: { title: 'Download', subtitle: 'Grab subtitles from any YouTube video or playlist.' },
    queue:    { title: 'Queue',    subtitle: 'Track and manage concurrent downloads in real time.' },
    history:  { title: 'History',  subtitle: 'Revisit previous downloads and reopen their folders.' },
    settings: { title: 'Settings', subtitle: 'Customize defaults, appearance, and behavior.' },
};

const YOUTUBE_RE = /(?:youtube\.com\/(?:watch|playlist|shorts|embed)|youtu\.be\/)/i;

function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem ? `${m}m ${rem}s` : `${m}m`;
}

function formatRelative(timestamp) {
    if (!timestamp) return '—';
    const diff = Date.now() - timestamp;
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
}

function truncateMiddle(value, max = 48) {
    if (!value || value.length <= max) return value || '';
    const half = Math.floor((max - 1) / 2);
    return `${value.slice(0, half)}…${value.slice(-half)}`;
}

function shortUrl(url) {
    try {
        const u = new URL(url);
        return `${u.hostname}${u.pathname}`;
    } catch {
        return url;
    }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function activateTab(name) {
    state.currentTab = name;
    $$('.rail-link').forEach((btn) => {
        const active = btn.dataset.tab === name;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    $$('.tab-panel').forEach((panel) => {
        panel.classList.toggle('is-active', panel.dataset.panel === name);
    });
    const meta = PAGE_META[name];
    if (meta) {
        $('#page-title').textContent = meta.title;
        $('#page-subtitle').textContent = meta.subtitle;
    }
    if (name === 'history') renderHistory();
    if (name === 'queue') renderQueue();
}

$('#rail-nav').addEventListener('click', (event) => {
    const btn = event.target.closest('.rail-link');
    if (btn) activateTab(btn.dataset.tab);
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function loadAndApplySettings() {
    state.settings = await subly.settings.get();
    applySettingsToUI(state.settings);
}

function applySettingsToUI(s) {
    $('#sub-lang').value = s.defaultLanguage;
    $('#s-default-lang').value = s.defaultLanguage;
    $('#output-path').textContent = s.outputDirectory;
    $('#output-path').title = s.outputDirectory;
    $('#s-output-path').textContent = s.outputDirectory;
    $('#s-output-path').title = s.outputDirectory;
    $('#s-keep-history').checked = !!s.keepHistory;
    $('#s-max-val').textContent = String(s.maxConcurrent);

    $$('.segmented__btn[data-format]').forEach((b) => {
        const active = b.dataset.format === s.subtitleFormat;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-checked', active ? 'true' : 'false');
    });
    $$('.segmented__btn[data-setting-format]').forEach((b) => {
        const active = b.dataset.settingFormat === s.subtitleFormat;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-checked', active ? 'true' : 'false');
    });

    document.documentElement.dataset.accent = s.accent || 'violet';
    $$('#swatches .swatch').forEach((sw) => {
        sw.classList.toggle('is-active', sw.dataset.accent === (s.accent || 'violet'));
    });
}

async function patchSettings(patch) {
    state.settings = await subly.settings.update(patch);
    applySettingsToUI(state.settings);
}

// ---- UI bindings for settings ---------------------------------------------

$('#s-default-lang').addEventListener('change', (e) => patchSettings({ defaultLanguage: e.target.value }));
$('#sub-lang').addEventListener('change', (e) => patchSettings({ defaultLanguage: e.target.value }));

$$('.segmented__btn[data-format]').forEach((btn) => {
    btn.addEventListener('click', () => patchSettings({ subtitleFormat: btn.dataset.format }));
});
$$('.segmented__btn[data-setting-format]').forEach((btn) => {
    btn.addEventListener('click', () => patchSettings({ subtitleFormat: btn.dataset.settingFormat }));
});

$('#s-keep-history').addEventListener('change', (e) => patchSettings({ keepHistory: e.target.checked }));

$('#s-max-inc').addEventListener('click', () => {
    const next = Math.min(8, (state.settings?.maxConcurrent || 3) + 1);
    patchSettings({ maxConcurrent: next });
});
$('#s-max-dec').addEventListener('click', () => {
    const next = Math.max(1, (state.settings?.maxConcurrent || 3) - 1);
    patchSettings({ maxConcurrent: next });
});

$$('#swatches .swatch').forEach((sw) => {
    sw.addEventListener('click', () => patchSettings({ accent: sw.dataset.accent }));
});

$('#btn-pick-folder').addEventListener('click', async () => {
    const folder = await subly.dialogs.pickFolder({ defaultPath: state.settings?.outputDirectory });
    if (folder) patchSettings({ outputDirectory: folder });
});
$('#s-pick-folder').addEventListener('click', async () => {
    const folder = await subly.dialogs.pickFolder({ defaultPath: state.settings?.outputDirectory });
    if (folder) patchSettings({ outputDirectory: folder });
});
$('#btn-open-folder').addEventListener('click', () => {
    if (state.settings?.outputDirectory) subly.shell.openPath(state.settings.outputDirectory);
});

$('#btn-reset-settings').addEventListener('click', async () => {
    state.settings = await subly.settings.reset();
    applySettingsToUI(state.settings);
    showToast('Settings restored to defaults.', 'success');
});

// ---------------------------------------------------------------------------
// Download / webview
// ---------------------------------------------------------------------------

const webview = $('#yt-webview');
const wvAddress = $('#wv-address');
const wvStatus = $('#wv-status');
const wvPulse = $('#wv-pulse');
const btnDownload = $('#btn-download');

function setWebviewStatus(text, live = false) {
    wvStatus.textContent = text;
    wvPulse.classList.toggle('is-live', live);
}

webview.addEventListener('did-start-loading', () => setWebviewStatus('Loading', true));
webview.addEventListener('did-stop-loading', () => {
    setWebviewStatus('Ready');
    wvAddress.textContent = shortUrl(webview.getURL());
});
webview.addEventListener('did-navigate', (e) => { wvAddress.textContent = shortUrl(e.url); });
webview.addEventListener('did-navigate-in-page', (e) => { wvAddress.textContent = shortUrl(e.url); });

$('#wv-back').addEventListener('click', () => { if (webview.canGoBack()) webview.goBack(); });
$('#wv-forward').addEventListener('click', () => { if (webview.canGoForward()) webview.goForward(); });
$('#btn-reload').addEventListener('click', () => webview.reload());

function showToast(message, kind = 'normal', timeout = 4000) {
    const el = $('#status-toast');
    el.hidden = false;
    el.className = `tip tip--${kind}`;
    el.textContent = message;
    clearTimeout(showToast._t);
    if (timeout) {
        showToast._t = setTimeout(() => { el.hidden = true; }, timeout);
    }
}

function canStartDownload() {
    const active = state.activeJobs.size;
    const cap = state.settings?.maxConcurrent || 3;
    return active < cap;
}

async function startDownload() {
    const url = webview.getURL();
    if (!YOUTUBE_RE.test(url)) {
        showToast('Open a YouTube video, playlist, or Shorts page first.', 'error');
        return;
    }
    if (!canStartDownload()) {
        showToast(`Reached concurrency limit (${state.settings.maxConcurrent}). Raise it in Settings.`, 'error');
        return;
    }
    const lang = $('#sub-lang').value;
    const subtitleFormat = $$('.segmented__btn[data-format]').find((b) => b.classList.contains('is-active'))?.dataset.format || 'srt';
    try {
        const jobId = await subly.downloads.start({ url, lang, subtitleFormat });
        showToast(`Queued. Job ${jobId.slice(0, 8)} started.`, 'success');
        activateTab('queue');
    } catch (err) {
        showToast(`Could not start download: ${err.message || err}`, 'error');
    }
}

btnDownload.addEventListener('click', startDownload);

// ---------------------------------------------------------------------------
// Queue rendering (live)
// ---------------------------------------------------------------------------

const queueList = $('#queue-list');
const queueCountEl = $('#queue-count');
const activeCountEl = $('#active-count');
const concurrencyChip = $('#concurrency-chip');

function updateActiveIndicators() {
    const n = state.activeJobs.size;
    queueCountEl.textContent = String(n);
    queueCountEl.hidden = n === 0;
    activeCountEl.textContent = `${n} active`;
    concurrencyChip.classList.toggle('is-active', n > 0);
}

function jobRowId(jobId) { return `job-${jobId}`; }

function ensureJobRow(job) {
    const id = jobRowId(job.id);
    let row = document.getElementById(id);
    if (!row) {
        row = document.createElement('article');
        row.id = id;
        row.className = 'job-item';
        row.innerHTML = `
            <div class="job-item__title">
                <span class="status-pill status-pill--running">
                    <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/></svg>
                    running
                </span>
                <span class="job-title-text" data-field="title">${escapeHtml(job.title || shortUrl(job.url))}</span>
            </div>
            <div class="job-item__actions">
                <button class="icon-btn" data-action="cancel" title="Cancel">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                </button>
            </div>
            <div class="progress"><div class="progress__fill" data-field="fill"></div></div>
            <div class="job-item__meta">
                <span data-field="percent">0%</span>
                <span class="mono" data-field="url">${escapeHtml(shortUrl(job.url))}</span>
                <span data-field="lang">lang: ${escapeHtml(job.lang || '—')}</span>
                <span data-field="eta"></span>
            </div>
        `;
        queueList.appendChild(row);
        row.querySelector('[data-action="cancel"]').addEventListener('click', () => subly.downloads.cancel(job.id));
    }
    return row;
}

function renderQueue() {
    const activeJobs = [...state.activeJobs.values()];
    queueList.innerHTML = '';
    if (activeJobs.length === 0) {
        queueList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state__mark"></div>
                <h3>No active downloads</h3>
                <p class="muted small">Start a download from the Download tab to see it here.</p>
            </div>
        `;
        return;
    }
    for (const job of activeJobs) {
        const row = ensureJobRow(job);
        updateJobRow(row, job);
    }
}

function updateJobRow(row, job) {
    const percent = job.percent || '0%';
    row.querySelector('[data-field="percent"]').textContent = percent;
    row.querySelector('[data-field="fill"]').style.width = percent;
    const title = job.title || shortUrl(job.url);
    row.querySelector('[data-field="title"]').textContent = title;
    const etaEl = row.querySelector('[data-field="eta"]');
    if (job.eta != null) {
        etaEl.textContent = `ETA ${job.eta}s`;
    } else if (job.speed) {
        etaEl.textContent = job.speed;
    } else {
        etaEl.textContent = '';
    }
}

function removeJobRow(jobId) {
    const row = document.getElementById(jobRowId(jobId));
    if (row) row.remove();
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

// ---- Download event wiring ------------------------------------------------

subly.downloads.on('job-started', (meta) => {
    state.activeJobs.set(meta.id, { ...meta, percent: '0%' });
    if (state.currentTab === 'queue') renderQueue();
    else ensureJobRow(state.activeJobs.get(meta.id));
    updateActiveIndicators();
});

subly.downloads.on('job-event', (payload) => {
    const job = state.activeJobs.get(payload.jobId);
    if (!job) return;
    if (payload.event === 'started') {
        if (payload.title) job.title = payload.title;
        if (payload.directory) job.directory = payload.directory;
    } else if (payload.event === 'progress') {
        if (payload.percent) job.percent = payload.percent;
        if (payload.eta != null) job.eta = payload.eta;
        if (payload.speed) job.speed = payload.speed;
    }
    const row = document.getElementById(jobRowId(payload.jobId));
    if (row) updateJobRow(row, job);
});

subly.downloads.on('job-finished', (result) => {
    state.activeJobs.delete(result.id);
    removeJobRow(result.id);
    updateActiveIndicators();
    if (state.currentTab === 'queue' && state.activeJobs.size === 0) renderQueue();
    if (state.currentTab === 'history') renderHistory();
    const label = result.title || shortUrl(result.url);
    if (result.status === 'success') {
        showToast(`Finished: ${truncateMiddle(label, 60)}`, 'success');
    } else {
        showToast(`Failed: ${truncateMiddle(label, 60)}`, 'error');
    }
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const historyList = $('#history-list');

async function renderHistory() {
    const entries = await subly.history.list();
    historyList.innerHTML = '';
    if (!entries.length) {
        historyList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state__mark"></div>
                <h3>Nothing yet</h3>
                <p class="muted small">Your downloads will appear here.</p>
            </div>
        `;
        return;
    }
    for (const entry of entries) {
        historyList.appendChild(buildHistoryRow(entry));
    }
}

function buildHistoryRow(entry) {
    const row = document.createElement('article');
    row.className = 'history-item';
    const statusClass = entry.status === 'success' ? 'success' : 'failed';
    const duration = entry.finishedAt && entry.startedAt
        ? formatDuration(entry.finishedAt - entry.startedAt)
        : '—';
    row.innerHTML = `
        <div class="history-item__title">
            <span class="status-pill status-pill--${statusClass}">${entry.status}</span>
            <span>${escapeHtml(entry.title || shortUrl(entry.url))}</span>
        </div>
        <div class="history-item__actions">
            <button class="icon-btn" data-action="open" title="Open folder">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
            </button>
            <button class="icon-btn" data-action="remove" title="Remove">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
        </div>
        <div class="history-item__meta">
            <span class="mono">${escapeHtml(shortUrl(entry.url))}</span>
            <span>lang: ${escapeHtml(entry.lang || '—')}</span>
            <span>${escapeHtml(entry.subtitleFormat?.toUpperCase() || 'SRT')}</span>
            <span>${escapeHtml(duration)}</span>
            <span>${escapeHtml(formatRelative(entry.finishedAt))}</span>
        </div>
    `;
    row.querySelector('[data-action="open"]').addEventListener('click', () => {
        if (entry.directory) subly.shell.openPath(entry.directory);
        else if (entry.outputDir) subly.shell.openPath(entry.outputDir);
    });
    row.querySelector('[data-action="remove"]').addEventListener('click', async () => {
        await subly.history.remove(entry.id);
        renderHistory();
    });
    return row;
}

$('#btn-clear-history').addEventListener('click', async () => {
    await subly.history.clear();
    renderHistory();
});

// ---------------------------------------------------------------------------
// About panel
// ---------------------------------------------------------------------------

async function loadMeta() {
    try {
        const meta = await subly.app.meta();
        $('#meta-version').textContent = `v${meta.version}`;
        $('#app-version').textContent = `v${meta.version}`;
        $('#meta-platform').textContent = meta.platform;
        $('#meta-userdata').textContent = meta.userData;
        $('#meta-userdata').title = meta.userData;
    } catch {
        /* noop */
    }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function boot() {
    await loadAndApplySettings();
    await loadMeta();
    await renderHistory();
    updateActiveIndicators();
    // Hydrate active jobs (e.g. after reload)
    const active = await subly.downloads.active();
    for (const job of active) state.activeJobs.set(job.id, { ...job, percent: '0%' });
    if (active.length) {
        updateActiveIndicators();
        renderQueue();
    }
})();
