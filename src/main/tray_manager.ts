import { Menu, MenuItem, MenuItemConstructorOptions, Tray } from 'electron';
import { IconRenderer, IconSpec } from './icon_renderer';
import { getSettings } from './settings_manager';
import type { AppSettings, PrintStatus } from '../shared/types';

const APP_TITLE = 'Bambu Taskbar';
/** Windows truncates tray tooltips at 127 characters. */
const MAX_TOOLTIP_LENGTH = 127;

export default class TrayManager {
    private tray: Tray | null = null;
    private status: PrintStatus | null = null;
    private lightTaskbar = false;
    private renderSequence = 0;
    private tooltipTimer: NodeJS.Timeout | null = null;

    constructor(
        private icons: IconRenderer,
        private staticMenuItems: (MenuItemConstructorOptions | MenuItem)[],
        private onClick: () => void,
    ) { }

    async init(): Promise<void> {
        const image = await this.icons.renderTrayImage(buildIconSpec(null, getSettings(), this.lightTaskbar));
        this.tray = new Tray(image);
        this.tray.setToolTip(APP_TITLE);
        this.tray.on('click', () => this.onClick());
        // Keep "done at" / "updated N min ago" fresh.
        this.tooltipTimer = setInterval(() => this.updateTooltip(), 30_000);
        await this.update();
    }

    dispose(): void {
        if (this.tooltipTimer) { clearInterval(this.tooltipTimer); }
        this.tray?.destroy();
        this.tray = null;
    }

    setStatus(status: PrintStatus): void {
        this.status = status;
        void this.update();
    }

    setLightTaskbar(light: boolean): void {
        if (this.lightTaskbar === light) { return; }
        this.lightTaskbar = light;
        void this.update();
    }

    async update(): Promise<void> {
        if (!this.tray) { return; }
        const sequence = ++this.renderSequence;
        const image = await this.icons.renderTrayImage(buildIconSpec(this.status, getSettings(), this.lightTaskbar));
        if (sequence !== this.renderSequence || !this.tray) { return; }
        this.tray.setImage(image);
        this.updateTooltip();
        this.tray.setContextMenu(this.buildMenu());
    }

    private updateTooltip(): void {
        if (!this.tray) { return; }
        const text = tooltipText(this.status);
        this.tray.setToolTip(text.length > MAX_TOOLTIP_LENGTH ? text.slice(0, MAX_TOOLTIP_LENGTH - 1) + '…' : text);
    }

    private buildMenu(): Menu {
        const lines = tooltipText(this.status).split('\n');
        return Menu.buildFromTemplate([
            ...lines.map(label => ({ label, enabled: false })),
            { type: 'separator' },
            ...this.staticMenuItems,
        ]);
    }
}

export function buildIconSpec(status: PrintStatus | null, settings: AppSettings, lightTaskbar: boolean): IconSpec {
    const online = status && status.connection === 'connected';
    return {
        style: settings.iconStyle,
        state: online ? status.state : 'offline',
        percent: online ? status.percent : null,
        lightTaskbar,
    };
}

export function tooltipText(status: PrintStatus | null, now = new Date()): string {
    if (!status || status.connection === 'unconfigured') {
        return `${APP_TITLE}\nNo printer set up. Click to open settings.`;
    }
    if (status.connection === 'signed-out') {
        return `${APP_TITLE}\nSign in to Bambu Lab. Click to open settings.`;
    }
    const title = status.model ? `${status.printerName} (${status.model})` : status.printerName;
    if (status.connection !== 'connected') {
        const reason = {
            'signed-out': 'Not signed in to Bambu Lab',
            connecting: 'Connecting…',
            offline: 'Printer offline',
            'auth-failed': 'Access code rejected',
            'tls-failed': 'Certificate check failed',
            error: 'Connection error',
        }[status.connection] ?? 'Not connected';
        return `${title}\n${reason}`;
    }

    const lines = [title];
    switch (status.state) {
        case 'printing':
        case 'paused':
        case 'preparing': {
            if (status.fileName) { lines.push(status.fileName); }
            const parts = [`${status.percent ?? 0}%`];
            if (status.layer !== null && status.totalLayers) { parts.push(`Layer ${status.layer}/${status.totalLayers}`); }
            if (status.state !== 'printing' && status.stageName) { parts.unshift(status.stageName); }
            lines.push(parts.join(' · '));
            if (status.remainingMinutes !== null && status.state !== 'preparing') {
                lines.push(`${formatDuration(status.remainingMinutes)} left · done ${formatClock(addMinutes(now, status.remainingMinutes))}`);
            }
            break;
        }
        case 'finished': lines.push(`Finished${status.fileName ? `: ${status.fileName}` : ''}`); break;
        case 'failed': lines.push(`Failed${status.fileName ? `: ${status.fileName}` : ''}`); break;
        case 'idle': lines.push('Idle'); break;
        default: lines.push(status.connectionMessage ? 'Printer not responding (off?)' : 'Waiting for status…');
    }
    return lines.join('\n');
}

export function formatDuration(minutes: number): string {
    if (minutes < 60) { return `${minutes} min`; }
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
}

function addMinutes(date: Date, minutes: number): Date {
    return new Date(date.getTime() + minutes * 60_000);
}

function formatClock(date: Date): string {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
