/** Lookup tables for values the printer reports as codes. */

/** `stg_cur` values (current print stage). Unknown codes fall back to "Stage N". */
const STAGES: Record<number, string> = {
    1: 'Auto bed levelling',
    2: 'Heating the bed',
    3: 'Vibration compensation',
    4: 'Changing filament',
    5: 'Paused (M400)',
    6: 'Paused: filament ran out',
    7: 'Heating the nozzle',
    8: 'Calibrating extrusion',
    9: 'Scanning the bed surface',
    10: 'Inspecting the first layer',
    11: 'Identifying the build plate',
    12: 'Calibrating the micro lidar',
    13: 'Homing the toolhead',
    14: 'Cleaning the nozzle tip',
    15: 'Checking extruder temperature',
    16: 'Paused by user',
    17: 'Paused: front cover fell off',
    18: 'Calibrating the micro lidar',
    19: 'Calibrating extrusion flow',
    20: 'Paused: nozzle temperature problem',
    21: 'Paused: bed temperature problem',
    22: 'Unloading filament',
    23: 'Paused: skipped step',
    24: 'Loading filament',
    25: 'Calibrating motor noise',
    26: 'Paused: AMS lost',
    27: 'Paused: heatbreak fan too slow',
    28: 'Paused: chamber temperature problem',
    29: 'Cooling the chamber',
    30: 'Paused by G-code',
    31: 'Motor noise check',
    32: 'Paused: filament on the nozzle',
    33: 'Paused: filament cutter problem',
    34: 'Paused: first layer problem',
    35: 'Paused: nozzle clog',
};

export function stageName(stage: number): string | null {
    if (stage < 0 || stage === 255) { return null; } // idle
    if (stage === 0) { return 'Printing'; }
    return STAGES[stage] ?? `Stage ${stage}`;
}

/** Model codes from the printer's discovery broadcast (DevModel.bambu.com). */
const MODELS: Record<string, string> = {
    'BL-P001': 'X1 Carbon',
    'BL-P002': 'X1',
    'C13': 'X1E',
    'C11': 'P1P',
    'C12': 'P1S',
    'N1': 'A1 mini',
    'N2S': 'A1',
    'O1D': 'H2D',
};

export function modelName(code: string | null | undefined): string | null {
    if (!code) { return null; }
    return MODELS[code] ?? code;
}
