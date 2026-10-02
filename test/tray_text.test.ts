import './helpers/electron_stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, tooltipText } from '../src/main/tray_manager';
import type { PrintStatus } from '../src/shared/types';

const base: PrintStatus = {
    connection: 'connected', connectionMessage: null, mode: 'lan', printerName: 'Workshop', model: 'P1S', state: 'printing',
    percent: 42, remainingMinutes: 75, layer: 120, totalLayers: 287, fileName: 'Benchy', stageName: 'Printing',
    nozzleTemp: 220, nozzleTarget: 220, bedTemp: 55, bedTarget: 55, errorCode: null, lastUpdate: 0,
};

test('tooltip while printing fits the Windows limit', () => {
    const text = tooltipText(base, new Date(2026, 9, 2, 13, 0));
    const lines = text.split('\n');
    assert.equal(lines[0], 'Workshop (P1S)');
    assert.equal(lines[1], 'Benchy');
    assert.equal(lines[2], '42% · Layer 120/287');
    assert.match(lines[3], /^1 h 15 min left · done /);
    assert.ok(text.length <= 127);
});

test('tooltip for other states', () => {
    assert.match(tooltipText(null), /No printer set up/);
    assert.match(tooltipText({ ...base, connection: 'auth-failed' }), /Access code rejected/);
    assert.match(tooltipText({ ...base, state: 'paused', stageName: 'Paused: filament ran out' }), /Paused: filament ran out · 42%/);
    assert.match(tooltipText({ ...base, state: 'finished' }), /Finished: Benchy/);
    assert.equal(formatDuration(45), '45 min');
    assert.equal(formatDuration(120), '2 h');
});
