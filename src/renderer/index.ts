/**
 * Settings window. Runs sandboxed; talks to the main process only through `window.trayApp` (see preload.ts).
 */
import './index.css';
import type { AppInfo, CloudPrinter, DiscoveredPrinter, PrintStatus, PublicSettings, TrayAppApi } from '../shared/types';

declare global {
    interface Window { trayApp: TrayAppApi; }
}

const api = window.trayApp;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: PublicSettings;
let status: PrintStatus;
let appInfo: AppInfo;

async function main() {
    [settings, status, appInfo] = await Promise.all([api.getSettings(), api.getStatus(), api.getAppInfo()]);
    if (appInfo.supportsMica) { document.body.classList.add('mica'); }
    $('app_version').textContent = `v${appInfo.version}`;

    fillPrinterForm();
    bindPrinterForm();
    bindConnectionMode();
    bindCloud();
    renderMode();
    bindSettings();
    renderStatus();
    void renderIconPreviews();

    api.onStatusChanged(next => {
        status = next;
        renderStatus();
    });
    setInterval(renderStatus, 30_000); // keep "done at" fresh

    $('test_notification').addEventListener('click', async e => {
        const button = e.currentTarget as HTMLButtonElement;
        await api.sendTestNotification();
        button.textContent = 'Sent';
        button.dataset.done = 'true';
        setTimeout(() => { button.textContent = 'Send test'; delete button.dataset.done; }, 2000);
    });
    $('open_github').addEventListener('click', () => api.openExternal('github'));
    $('open_guide').addEventListener('click', e => { e.preventDefault(); void api.openExternal('setup-guide'); });
}

// ---------- Printer form ----------

function fillPrinterForm() {
    $<HTMLInputElement>('printer_name').value = settings.printerName;
    $<HTMLInputElement>('printer_host').value = settings.printerHost;
    $<HTMLInputElement>('printer_serial').value = settings.printerSerial;
    $<HTMLInputElement>('printer_model').value = settings.printerModel;
    $<HTMLInputElement>('printer_code').placeholder = settings.hasAccessCode ? 'Saved (leave empty to keep)' : '8 characters';
}

function setFormMessage(text: string, tone: 'good' | 'bad' | '' = '') {
    const el = $('form_message');
    el.textContent = text;
    if (tone) { el.dataset.tone = tone; } else { delete el.dataset.tone; }
}

function bindPrinterForm() {
    $<HTMLFormElement>('printer_form').addEventListener('submit', async e => {
        e.preventDefault();
        const button = $<HTMLButtonElement>('save_printer');
        button.disabled = true;
        setFormMessage('Connecting…');
        try {
            await api.savePrinter({
                name: $<HTMLInputElement>('printer_name').value,
                host: $<HTMLInputElement>('printer_host').value,
                serial: $<HTMLInputElement>('printer_serial').value,
                model: $<HTMLInputElement>('printer_model').value,
                accessCode: $<HTMLInputElement>('printer_code').value,
            });
            $<HTMLInputElement>('printer_code').value = '';
            settings = await api.getSettings();
            fillPrinterForm();
            setFormMessage('Saved.', 'good');
        } catch (err) {
            setFormMessage(cleanError(err), 'bad');
        } finally {
            button.disabled = false;
        }
    });

    $('discover').addEventListener('click', async e => {
        const button = e.currentTarget as HTMLButtonElement;
        button.disabled = true;
        $('discover_status').textContent = 'Listening for printers (about 6 seconds)…';
        $('discovered').replaceChildren();
        const found = await api.discoverPrinters(6);
        button.disabled = false;
        $('discover_status').textContent = found.length
            ? `Found ${found.length}. Pick one to fill in the details, then add the access code.`
            : 'No printers answered. Check the printer is on the same network, or enter the details by hand.';
        $('discovered').replaceChildren(...found.map(discoveredButton));
    });
}

function discoveredButton(p: DiscoveredPrinter): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    const name = document.createElement('span');
    name.textContent = `${p.name ?? p.serial}${p.model ? ` · ${p.model}` : ''}`;
    const info = document.createElement('small');
    info.textContent = `${p.host} · ${p.serial}${p.connectMode ? ` · ${p.connectMode === 'lan' ? 'LAN mode' : 'cloud mode'}` : ''}`;
    b.append(name, info);
    b.addEventListener('click', () => {
        $<HTMLInputElement>('printer_name').value = p.name ?? '';
        $<HTMLInputElement>('printer_host').value = p.host;
        $<HTMLInputElement>('printer_serial').value = p.serial;
        $<HTMLInputElement>('printer_model').value = p.model ?? '';
        $<HTMLInputElement>('printer_code').focus();
        setFormMessage(p.connectMode && p.connectMode !== 'lan'
            ? 'This printer is not in LAN Only mode yet. Turn it on at the printer first.'
            : 'Now enter the access code from the printer screen.', p.connectMode && p.connectMode !== 'lan' ? 'bad' : '');
    });
    return b;
}

function cleanError(err: unknown): string {
    const text = err instanceof Error ? err.message : String(err);
    return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ---------- Connection mode ----------

function bindConnectionMode() {
    for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="conn_mode"]')) {
        radio.checked = radio.value === settings.connectionMode;
        radio.addEventListener('change', async () => {
            if (!radio.checked) { return; }
            settings = { ...settings, connectionMode: radio.value as PublicSettings['connectionMode'] };
            renderMode();
            await api.setConnectionMode(settings.connectionMode);
        });
    }
}

function renderMode() {
    const cloud = settings.connectionMode === 'cloud';
    $('cloud_panel').hidden = !cloud;
    $('mode_desc').textContent = cloud
        ? 'Through your Bambu Lab account. The printer stays as it is and Bambu Handy keeps working.'
        : 'Straight to the printer on your network. Needs LAN Only and Developer mode on the printer.';
    $('lan_panel').hidden = cloud;
    $('allow_unverified').closest<HTMLElement>('.card').hidden = cloud;
    renderCloud();
}

// ---------- Bambu account ----------

let cloudStep: 'signin' | 'code' | 'tfa' = 'signin';
let cloudPrinters: CloudPrinter[] | null = null;

function setMessage(id: string, text: string, tone: 'good' | 'bad' | '' = '') {
    const el = $(id);
    el.textContent = text;
    if (tone) { el.dataset.tone = tone; } else { delete el.dataset.tone; }
}

function renderCloud() {
    const signedIn = settings.cloudSignedIn;
    $('cloud_signin_card').hidden = signedIn;
    $('cloud_signin').hidden = cloudStep !== 'signin';
    $('cloud_code').hidden = cloudStep === 'signin';
    $('cloud_account').hidden = !signedIn;
    $('cloud_printers_card').hidden = !signedIn;
    if (cloudStep === 'tfa') {
        $('cloud_code_title').textContent = 'Two-factor authentication';
        $('cloud_code_desc').textContent = 'Enter the 6-digit code from your authenticator app.';
        $('cloud_resend').hidden = true;
    } else {
        $('cloud_code_title').textContent = 'Check your email';
        $('cloud_code_desc').textContent = `Bambu Lab emailed a verification code to ${$<HTMLInputElement>('cloud_email').value || 'you'}.`;
        $('cloud_resend').hidden = false;
    }
    if (signedIn) {
        const email = settings.cloudEmail;
        $('cloud_account_email').textContent = email || 'Bambu Lab account';
        $('cloud_avatar').textContent = (email.trim()[0] ?? 'B').toUpperCase();
        const days = Math.round((settings.cloudTokenExpiresAt - Date.now()) / 86_400_000);
        const region = settings.cloudRegion === 'china' ? 'Bambu Lab China' : 'Bambu Lab';
        $('cloud_account_expiry').textContent = !settings.cloudTokenExpiresAt ? region
            : days > 0 ? `${region} · signed in for ${days} more day${days === 1 ? '' : 's'}`
                : 'Sign-in has expired. Sign out and sign in again.';
        if (cloudPrinters === null) { void loadCloudPrinters(); } else { renderCloudPrinters(); }
    }
}

async function loadCloudPrinters() {
    cloudPrinters = [];
    setMessage('cloud_printers_message', 'Loading your printers…');
    try {
        cloudPrinters = await api.cloudListPrinters();
        setMessage('cloud_printers_message', cloudPrinters.length ? '' : 'No printers are bound to this account. Bind it in Bambu Handy or Bambu Studio first.');
    } catch (err) {
        setMessage('cloud_printers_message', cleanError(err), 'bad');
    }
    renderCloudPrinters();
}

/** Printer outline: frame, gantry with the print head, and the bed. */
const PRINTER_SVG = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="2.5" width="14" height="15" rx="2" />'
    + '<path d="M3 6.5h14M8.5 6.5v2.5h3V6.5M10 9v1.5M6 14.5h8" /></svg>';

function renderCloudPrinters() {
    $('cloud_printers').replaceChildren(...(cloudPrinters ?? []).map(p => {
        const selected = p.serial === settings.printerSerial;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'printer-item';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(selected));

        const thumb = document.createElement('span');
        thumb.className = 'printer-thumb';
        thumb.innerHTML = PRINTER_SVG;

        const text = document.createElement('span');
        text.className = 'printer-text';
        const name = document.createElement('span');
        name.className = 'printer-name';
        name.textContent = p.name;
        const sub = document.createElement('span');
        sub.className = 'printer-sub';
        sub.textContent = [p.model, p.serial].filter(Boolean).join(' · ');
        text.append(name, sub);

        const state = document.createElement('span');
        state.className = 'chip';
        state.textContent = p.online ? 'Online' : 'Offline';
        if (p.online) { state.dataset.tone = 'good'; }

        const mark = document.createElement('span');
        mark.className = 'radio-mark';
        mark.setAttribute('aria-hidden', 'true');

        b.append(thumb, text, state, mark);
        b.addEventListener('click', async () => {
            await api.cloudSelectPrinter(p);
            settings = await api.getSettings();
            renderCloudPrinters();
        });
        return b;
    }));
}

function bindCloud() {
    $<HTMLSelectElement>('cloud_region').value = settings.cloudRegion;
    if (settings.cloudEmail) { $<HTMLInputElement>('cloud_email').value = settings.cloudEmail; }

    $<HTMLFormElement>('cloud_signin').addEventListener('submit', async e => {
        e.preventDefault();
        const button = $<HTMLButtonElement>('cloud_signin_button');
        button.disabled = true;
        setMessage('cloud_signin_message', 'Signing in…');
        try {
            const step = await api.cloudSignIn(
                $<HTMLInputElement>('cloud_email').value,
                $<HTMLInputElement>('cloud_password').value,
                $<HTMLSelectElement>('cloud_region').value as PublicSettings['cloudRegion'],
            );
            $<HTMLInputElement>('cloud_password').value = '';
            setMessage('cloud_signin_message', '');
            await afterCloudStep(step);
        } catch (err) {
            setMessage('cloud_signin_message', cleanError(err), 'bad');
        } finally {
            button.disabled = false;
        }
    });

    $('cloud_browser_button').addEventListener('click', async () => {
        const button = $<HTMLButtonElement>('cloud_browser_button');
        button.disabled = true;
        setMessage('cloud_browser_message', 'Finish signing in in the Bambu Lab window…');
        try {
            const step = await api.cloudSignInWithBrowser($<HTMLSelectElement>('cloud_region').value as PublicSettings['cloudRegion']);
            setMessage('cloud_browser_message', '');
            if (step !== 'cancelled') { await afterCloudStep(step); }
        } catch (err) {
            setMessage('cloud_browser_message', cleanError(err), 'bad');
        } finally {
            button.disabled = false;
        }
    });

    $<HTMLFormElement>('cloud_code').addEventListener('submit', async e => {
        e.preventDefault();
        const button = $<HTMLButtonElement>('cloud_code_button');
        button.disabled = true;
        setMessage('cloud_code_message', 'Checking…');
        try {
            const code = $<HTMLInputElement>('cloud_code_input').value;
            const step = cloudStep === 'tfa' ? await api.cloudVerifyTfa(code) : await api.cloudVerifyCode(code);
            $<HTMLInputElement>('cloud_code_input').value = '';
            setMessage('cloud_code_message', '');
            await afterCloudStep(step);
        } catch (err) {
            setMessage('cloud_code_message', cleanError(err), 'bad');
        } finally {
            button.disabled = false;
        }
    });

    $('cloud_resend').addEventListener('click', async () => {
        try {
            await api.cloudResendCode();
            setMessage('cloud_code_message', 'A new code is on its way.', 'good');
        } catch (err) {
            setMessage('cloud_code_message', cleanError(err), 'bad');
        }
    });
    $('cloud_code_cancel').addEventListener('click', () => { cloudStep = 'signin'; renderCloud(); });

    $('cloud_signout').addEventListener('click', async () => {
        await api.cloudSignOut();
        settings = await api.getSettings();
        cloudPrinters = null;
        cloudStep = 'signin';
        renderCloud();
    });
    $('cloud_refresh').addEventListener('click', () => { void loadCloudPrinters(); });
}

async function afterCloudStep(step: 'signed-in' | 'code-required' | 'tfa-required') {
    if (step === 'signed-in') {
        cloudStep = 'signin';
        settings = await api.getSettings();
        cloudPrinters = null;
    } else {
        cloudStep = step === 'tfa-required' ? 'tfa' : 'code';
    }
    renderCloud();
    if (step !== 'signed-in') { $<HTMLInputElement>('cloud_code_input').focus(); }
}

// ---------- Settings ----------

function bindToggle(id: string, key: keyof PublicSettings) {
    const input = $<HTMLInputElement>(id);
    input.checked = settings[key] as boolean;
    input.addEventListener('change', () => save({ [key]: input.checked }));
}

async function save(changes: Partial<PublicSettings>) {
    settings = { ...settings, ...changes };
    await api.updateSettings(changes);
    $<HTMLSelectElement>('almost_done_minutes').disabled = !settings.notifyAlmostDone;
    void renderIconPreviews();
}

function bindSettings() {
    bindToggle('notify_finished', 'notifyFinished');
    bindToggle('notify_almost_done', 'notifyAlmostDone');
    bindToggle('notify_paused', 'notifyPaused');
    bindToggle('notify_failed', 'notifyFailed');
    bindToggle('notify_started', 'notifyStarted');
    bindToggle('run_at_startup', 'runAtStartup');
    bindToggle('allow_unverified', 'allowUnverifiedCertificate');

    const minutes = $<HTMLSelectElement>('almost_done_minutes');
    const values = [2, 5, 10, 15, 20, 30, 60];
    if (!values.includes(settings.almostDoneMinutes)) { values.push(settings.almostDoneMinutes); values.sort((a, b) => a - b); }
    minutes.replaceChildren(...values.map(v => new Option(`${v} min`, String(v))));
    minutes.value = String(settings.almostDoneMinutes);
    minutes.disabled = !settings.notifyAlmostDone;
    minutes.addEventListener('change', () => save({ almostDoneMinutes: parseInt(minutes.value) }));

    for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="icon_style"]')) {
        radio.checked = radio.value === settings.iconStyle;
        radio.addEventListener('change', () => { if (radio.checked) { void save({ iconStyle: radio.value as PublicSettings['iconStyle'] }); } });
    }
}

// ---------- Status ----------

const CONNECTION_LABELS: Record<PrintStatus['connection'], [string, 'good' | 'warn' | 'bad' | '']> = {
    unconfigured: ['Not set up', ''],
    'signed-out': ['Not signed in', ''],
    connecting: ['Connecting', 'warn'],
    connected: ['Connected', 'good'],
    offline: ['Offline', 'bad'],
    'auth-failed': ['Access code rejected', 'bad'],
    'tls-failed': ['Certificate error', 'bad'],
    error: ['Error', 'bad'],
};

const STATE_LABELS: Record<PrintStatus['state'], [string, 'good' | 'warn' | 'bad' | '']> = {
    idle: ['Idle', ''],
    preparing: ['Preparing', 'good'],
    printing: ['Printing', 'good'],
    paused: ['Paused', 'warn'],
    finished: ['Finished', 'good'],
    failed: ['Failed', 'bad'],
    unknown: ['Waiting for status', ''],
};

function setChip(id: string, [text, tone]: [string, string]) {
    const chip = $(id);
    chip.textContent = text;
    if (tone) { chip.dataset.tone = tone; } else { delete chip.dataset.tone; }
}

function formatDuration(minutes: number): string {
    if (minutes < 60) { return `${minutes} min`; }
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
}

function temp(current: number | null, target: number | null): string {
    if (current === null) { return '--'; }
    const c = `${Math.round(current)}°`;
    return target ? `${c} / ${Math.round(target)}°` : c;
}

function renderStatus() {
    const connected = status.connection === 'connected';
    const s = status;
    const active = s.state === 'printing' || s.state === 'paused' || s.state === 'preparing';
    const heroState = !connected ? 'offline' : s.state;
    $('hero').dataset.state = heroState;

    const printer = s.model ? `${s.printerName} · ${s.model}` : s.printerName;
    const notSetUp = s.connection === 'unconfigured' || s.connection === 'signed-out';
    $('hero_printer').textContent = notSetUp ? 'No printer set up' : printer;
    $('hero_file').textContent = notSetUp
        ? (s.connection === 'signed-out' ? 'Sign in below to see your prints' : 'Choose your printer below')
        : !connected ? (s.connectionMessage ?? 'Not connected')
            : active || s.state === 'finished' || s.state === 'failed' ? (s.fileName ?? 'Untitled print')
                : s.state === 'unknown' ? (s.connectionMessage ?? 'Waiting for the printer…') : 'Ready for the next print';

    const percent = connected && s.percent !== null ? s.percent : null;
    $('hero_percent').textContent = percent === null ? '--' : String(percent);
    $('ring_fill').style.strokeDasharray = `${percent ?? 0} 100`;
    $('ring_fill').style.strokeOpacity = percent ? '1' : '0'; // a zero-length round cap would still show a dot

    setChip('hero_chip', connected ? STATE_LABELS[s.state] : CONNECTION_LABELS[s.connection]);
    $('hero_detail').textContent = connected && active && s.stageName && s.stageName !== 'Printing' ? s.stageName : '';

    $('stat_left').textContent = connected && active && s.remainingMinutes !== null ? formatDuration(s.remainingMinutes) : '--';
    $('stat_eta').textContent = connected && active && s.remainingMinutes !== null
        ? new Date(Date.now() + s.remainingMinutes * 60_000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '--';
    $('stat_layer').textContent = connected && s.layer !== null && s.totalLayers ? `${s.layer} / ${s.totalLayers}` : '--';
    $('stat_nozzle').textContent = connected ? temp(s.nozzleTemp, s.nozzleTarget) : '--';
    $('stat_bed').textContent = connected ? temp(s.bedTemp, s.bedTarget) : '--';

    setChip('connection_chip', CONNECTION_LABELS[s.connection]);
    $('connection_message').textContent = connected
        ? (s.connectionMessage ?? (s.mode === 'cloud' ? 'Receiving live status through Bambu Cloud.' : `Receiving live status from ${settings.printerHost}.`))
        : s.connectionMessage ?? 'Not connected.';
    // A refused cloud sign-in means the saved token expired: show the account panel's sign-in again.
    if (s.mode === 'cloud' && s.connection === 'auth-failed' && settings.cloudSignedIn) {
        $('cloud_account_expiry').textContent = 'Bambu Cloud refused the saved sign-in. Sign out and sign in again.';
    }
}

// ---------- Icon previews ----------

let previewSequence = 0;
async function renderIconPreviews() {
    const sequence = ++previewSequence;
    const light = appInfo.lightTaskbar;
    for (const style of ['percent', 'ring'] as const) {
        const variants = [
            { state: 'printing' as const, percent: 42 },
            { state: 'paused' as const, percent: 67 },
            { state: 'finished' as const, percent: null as number | null },
        ];
        const urls = await Promise.all(variants.map(v => api.renderIcon({ style, ...v, lightTaskbar: light, size: 48 })));
        if (sequence !== previewSequence) { return; }
        const swatch = $(`preview_${style}`);
        swatch.classList.toggle('light', light);
        swatch.classList.toggle('dark', !light);
        swatch.replaceChildren(...urls.map(url => {
            const img = new Image();
            img.src = url;
            img.alt = '';
            return img;
        }));
    }
}

void main();
