import './helpers/electron_stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatErrorCode, PrintNotifier } from '../src/main/notifier';
import { createDefaultSettings } from '../src/main/settings_manager';
import type { PrintStatus } from '../src/shared/types';

const settings = createDefaultSettings();
const status = (state: PrintStatus['state'], extra: Partial<PrintStatus> = {}): PrintStatus => ({
    connection: 'connected', connectionMessage: null, mode: 'lan', printerName: 'P1S', model: 'P1S', state,
    percent: null, remainingMinutes: null, layer: null, totalLayers: null, fileName: 'Benchy', stageName: null,
    nozzleTemp: null, nozzleTarget: null, bedTemp: null, bedTarget: null, errorCode: null, lastUpdate: 0, ...extra,
});

test('no notification for the state found at start-up', () => {
    const shown: string[] = [];
    const n = new PrintNotifier(a => shown.push(a.kind));
    n.onStatus(status('unknown'), settings);
    n.onStatus(status('finished'), settings);
    assert.deepEqual(shown, []);
});

test('a full print: almost done once, paused, finished', () => {
    const shown: string[] = [];
    const n = new PrintNotifier(a => shown.push(a.kind));
    const run = (s: PrintStatus) => n.onStatus(s, settings);
    run(status('idle'));
    run(status('preparing'));
    run(status('printing', { remainingMinutes: 60 }));
    run(status('printing', { remainingMinutes: 10 }));
    run(status('printing', { remainingMinutes: 9 }));
    run(status('paused', { stageName: 'Paused: filament ran out' }));
    run(status('printing', { remainingMinutes: 8 }));
    run(status('finished'));
    run(status('finished'));
    assert.deepEqual(shown, ['almost-done', 'paused', 'finished']);
});

test('started is opt-in; failed includes the error code', () => {
    const shown: string[] = [];
    const n = new PrintNotifier(a => shown.push(`${a.kind}:${a.body}`));
    const s = { ...settings, notifyStarted: true };
    n.onStatus(status('idle'), s);
    n.onStatus(status('printing', { remainingMinutes: 90 }), s);
    n.onStatus(status('failed', { errorCode: 0x0300400C }), s);
    assert.deepEqual(shown, ['started:Benchy', 'failed:Benchy (error 0300-400C)']);
    assert.equal(formatErrorCode(0x0500400E), '0500-400E');
});

test('next print re-arms "almost done"', () => {
    const shown: string[] = [];
    const n = new PrintNotifier(a => shown.push(a.kind));
    for (const s of [status('idle'), status('printing', { remainingMinutes: 5 }), status('finished'),
        status('printing', { remainingMinutes: 5 })]) {
        n.onStatus(s, settings);
    }
    assert.deepEqual(shown, ['almost-done', 'finished', 'almost-done']);
});
