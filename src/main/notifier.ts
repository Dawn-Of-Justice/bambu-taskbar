import { Notification } from 'electron';
import { APP_ICON_PATH } from './resources';
import type { AppSettings, PrintState, PrintStatus } from '../shared/types';

export interface Alert {
    kind: 'started' | 'almost-done' | 'paused' | 'finished' | 'failed';
    title: string;
    body: string;
}

const ACTIVE: PrintState[] = ['preparing', 'printing', 'paused'];

/**
 * Turns print state changes into notifications. Only real transitions count: when the app starts and the printer
 * already shows "finished" from an earlier print, nothing is announced.
 */
export class PrintNotifier {
    private previous: PrintStatus | null = null;
    private almostDoneSent = false;

    constructor(private show: (alert: Alert) => void = showNotification) { }

    onStatus(next: PrintStatus, settings: AppSettings): void {
        for (const alert of this.evaluate(next, settings)) { this.show(alert); }
    }

    /** Pure decision logic, exposed for tests. */
    evaluate(next: PrintStatus, settings: AppSettings): Alert[] {
        const prev = this.previous;
        // Ignore updates without a known state (e.g. while disconnected) so reconnecting doesn't look like a change.
        if (next.state === 'unknown') { return []; }
        this.previous = next;
        if (!prev || prev.state === 'unknown') { return []; }

        const alerts: Alert[] = [];
        const file = next.fileName ?? 'Your print';
        const from = prev.state;
        const to = next.state;

        if (!ACTIVE.includes(to)) { this.almostDoneSent = false; }

        if (!ACTIVE.includes(from) && (to === 'preparing' || to === 'printing')) {
            this.almostDoneSent = false;
            if (settings.notifyStarted) { alerts.push({ kind: 'started', title: 'Print started', body: file }); }
        }
        if (from !== 'paused' && to === 'paused' && settings.notifyPaused) {
            alerts.push({ kind: 'paused', title: 'Print paused', body: `${file}\n${next.stageName ?? 'The printer paused.'}` });
        }
        if (from !== 'finished' && to === 'finished' && settings.notifyFinished) {
            alerts.push({ kind: 'finished', title: 'Print finished', body: `${file} is done.` });
        }
        if (from !== 'failed' && to === 'failed' && settings.notifyFailed) {
            const code = next.errorCode ? ` (error ${formatErrorCode(next.errorCode)})` : '';
            alerts.push({ kind: 'failed', title: 'Print failed', body: `${file}${code}` });
        }
        if (to === 'printing' && !this.almostDoneSent && next.remainingMinutes !== null
            && next.remainingMinutes > 0 && next.remainingMinutes <= settings.almostDoneMinutes) {
            this.almostDoneSent = true;
            if (settings.notifyAlmostDone) {
                alerts.push({ kind: 'almost-done', title: `${next.remainingMinutes} min left`, body: `${file} is almost done.` });
            }
        }
        return alerts;
    }
}

/** Bambu shows print_error codes as 8 hex digits, e.g. 0300-4000. */
export function formatErrorCode(code: number): string {
    const hex = (code >>> 0).toString(16).toUpperCase().padStart(8, '0');
    return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

export function showNotification(alert: Pick<Alert, 'title' | 'body'>): void {
    if (!Notification.isSupported()) { return; }
    new Notification({ title: alert.title, body: alert.body, icon: APP_ICON_PATH }).show();
}
