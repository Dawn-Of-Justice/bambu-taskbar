/**
 * Turns Bambu Lab `device/<serial>/report` messages into a PrintStatus.
 * Pure logic, no Electron or network imports, so it can be unit tested.
 *
 * X1 printers send the full `print` object every time; P1/A1 printers only send the fields that changed,
 * so reports are merged into one accumulated object before deriving the status.
 */
import type { PrintState, PrintStatus } from '../../shared/types';
import { stageName } from './printer_info';

export type PrintFields = Record<string, unknown>;

export class PrintStateStore {
    private fields: PrintFields = {};
    private hasData = false;

    /** Merge one MQTT report. Returns true when it contained printer status. */
    merge(report: unknown): boolean {
        if (!report || typeof report !== 'object') { return false; }
        const print = (report as { print?: unknown }).print;
        if (!print || typeof print !== 'object' || Array.isArray(print)) { return false; }
        const command = (print as PrintFields).command;
        // Replies to commands (pause, gcode_line, ...) also arrive under "print"; only status pushes describe the printer.
        if (command !== undefined && command !== 'push_status') { return false; }
        this.fields = { ...this.fields, ...(print as PrintFields) };
        this.hasData = true;
        return true;
    }

    reset(): void {
        this.fields = {};
        this.hasData = false;
    }

    get received(): boolean {
        return this.hasData;
    }

    /** Print related part of the status (connection fields are filled in by the client). */
    derive(): Pick<PrintStatus, 'state' | 'percent' | 'remainingMinutes' | 'layer' | 'totalLayers' | 'fileName'
        | 'stageName' | 'nozzleTemp' | 'nozzleTarget' | 'bedTemp' | 'bedTarget' | 'errorCode'> {
        const f = this.fields;
        const state = this.hasData ? mapState(f.gcode_state) : 'unknown';
        const active = state === 'printing' || state === 'paused' || state === 'preparing';
        const hasJob = active || state === 'finished' || state === 'failed';

        let percent = hasJob ? num(f.mc_percent) : null;
        if (percent !== null) { percent = Math.max(0, Math.min(100, Math.round(percent))); }
        if (state === 'finished') { percent = 100; }

        const remaining = active ? num(f.mc_remaining_time) : null;
        const errorCode = num(f.print_error);
        const total = num(f.total_layer_num);

        return {
            state,
            percent,
            remainingMinutes: remaining !== null && remaining >= 0 ? Math.round(remaining) : null,
            layer: hasJob ? num(f.layer_num) : null,
            totalLayers: hasJob && total ? total : null,
            fileName: hasJob ? fileNameOf(f) : null,
            stageName: describeStage(state, num(f.stg_cur)),
            nozzleTemp: num(f.nozzle_temper),
            nozzleTarget: num(f.nozzle_target_temper),
            bedTemp: num(f.bed_temper),
            bedTarget: num(f.bed_target_temper),
            errorCode: errorCode ? errorCode : null,
        };
    }
}

export function mapState(value: unknown): PrintState {
    switch (String(value ?? '').toUpperCase()) {
        case 'IDLE': return 'idle';
        case 'PREPARE':
        case 'SLICING':
        case 'INIT': return 'preparing';
        case 'RUNNING': return 'printing';
        case 'PAUSE': return 'paused';
        case 'FINISH': return 'finished';
        case 'FAILED': return 'failed';
        default: return 'unknown';
    }
}

function describeStage(state: PrintState, stage: number | null): string | null {
    const name = stage !== null ? stageName(stage) : null;
    switch (state) {
        case 'printing': return name && stage !== 0 ? name : 'Printing';
        case 'paused': return name && stage !== 0 ? name : 'Paused';
        case 'preparing': return name ?? 'Preparing';
        case 'finished': return 'Finished';
        case 'failed': return 'Failed';
        case 'idle': return 'Idle';
        default: return null;
    }
}

function fileNameOf(f: PrintFields): string | null {
    const subtask = typeof f.subtask_name === 'string' ? f.subtask_name.trim() : '';
    if (subtask) { return subtask; }
    const gcode = typeof f.gcode_file === 'string' ? f.gcode_file.trim() : '';
    if (!gcode) { return null; }
    const base = gcode.split(/[\\/]/).pop() ?? gcode;
    return base.replace(/\.gcode(\.3mf)?$/i, '').replace(/\.3mf$/i, '') || null;
}

/** Numbers arrive as numbers or numeric strings depending on firmware. */
export function num(value: unknown): number | null {
    if (typeof value === 'number') { return Number.isFinite(value) ? value : null; }
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}
