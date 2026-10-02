import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrintStateStore, mapState, num } from '../src/main/printer/print_state';
import { stageName } from '../src/main/printer/printer_info';
import { commandReply, delta, fullPrinting, idle } from './fixtures/reports';

test('derives a printing status from a full report', () => {
    const s = new PrintStateStore();
    assert.equal(s.merge(fullPrinting), true);
    const d = s.derive();
    assert.equal(d.state, 'printing');
    assert.equal(d.percent, 42);
    assert.equal(d.remainingMinutes, 75);
    assert.equal(d.layer, 120);
    assert.equal(d.totalLayers, 287);
    assert.equal(d.fileName, 'Benchy');
    assert.equal(d.stageName, 'Printing');
    assert.equal(d.nozzleTarget, 220);
    assert.equal(d.errorCode, null);
});

test('merges P1/A1 partial updates, including numbers sent as strings', () => {
    const s = new PrintStateStore();
    s.merge(fullPrinting);
    s.merge(delta({ mc_percent: '43', layer_num: 124 }));
    let d = s.derive();
    assert.equal(d.percent, 43);
    assert.equal(d.layer, 124);
    assert.equal(d.fileName, 'Benchy', 'fields not in the delta are kept');

    s.merge(delta({ gcode_state: 'PAUSE', stg_cur: 6 }));
    d = s.derive();
    assert.equal(d.state, 'paused');
    assert.equal(d.stageName, 'Paused: filament ran out');

    s.merge(delta({ gcode_state: 'FINISH', mc_percent: 100, mc_remaining_time: 0 }));
    d = s.derive();
    assert.equal(d.state, 'finished');
    assert.equal(d.percent, 100);
    assert.equal(d.remainingMinutes, null);
});

test('ignores command replies and junk', () => {
    const s = new PrintStateStore();
    assert.equal(s.merge(commandReply), false);
    assert.equal(s.merge(null), false);
    assert.equal(s.merge({ info: { command: 'get_version' } }), false);
    assert.equal(s.merge({ print: [] }), false);
    assert.equal(s.received, false);
    assert.equal(s.derive().state, 'unknown');
});

test('idle printer has no job fields', () => {
    const s = new PrintStateStore();
    s.merge(idle);
    const d = s.derive();
    assert.equal(d.state, 'idle');
    assert.equal(d.percent, null);
    assert.equal(d.fileName, null);
    assert.equal(d.remainingMinutes, null);
});

test('failed print keeps the error code; file name falls back to the gcode file', () => {
    const s = new PrintStateStore();
    s.merge(delta({ gcode_state: 'FAILED', print_error: 0x0300400C, subtask_name: '', gcode_file: '/sdcard/cube.gcode.3mf', mc_percent: 12 }));
    const d = s.derive();
    assert.equal(d.state, 'failed');
    assert.equal(d.errorCode, 0x0300400C);
    assert.equal(d.fileName, 'cube');
});

test('helpers', () => {
    assert.equal(mapState('running'), 'printing');
    assert.equal(mapState('PREPARE'), 'preparing');
    assert.equal(mapState('???'), 'unknown');
    assert.equal(num('12.5'), 12.5);
    assert.equal(num(''), null);
    assert.equal(num('x'), null);
    assert.equal(stageName(-1), null);
    assert.equal(stageName(255), null);
    assert.equal(stageName(2), 'Heating the bed');
    assert.equal(stageName(99), 'Stage 99');
});
