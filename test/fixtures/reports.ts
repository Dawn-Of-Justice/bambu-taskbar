/** Report payloads shaped like real printer messages (trimmed). */

/** Full status, as an X1 sends every time or a P1/A1 sends after "pushall". */
export const fullPrinting = {
    print: {
        command: 'push_status',
        sequence_id: '1',
        gcode_state: 'RUNNING',
        mc_percent: 42,
        mc_remaining_time: 75,
        layer_num: 120,
        total_layer_num: 287,
        subtask_name: 'Benchy',
        gcode_file: '/data/Metadata/plate_1.gcode',
        stg_cur: 0,
        nozzle_temper: 219.8,
        nozzle_target_temper: 220,
        bed_temper: 55.1,
        bed_target_temper: 55,
        print_error: 0,
        hms: [] as unknown[],
        ams: { ams: [] as unknown[] },
    },
};

/** P1/A1 style delta: only the fields that changed. Some firmwares send numbers as strings. */
export const delta = (fields: Record<string, unknown>) => ({ print: { command: 'push_status', ...fields } });

export const idle = {
    print: {
        command: 'push_status',
        gcode_state: 'IDLE',
        mc_percent: 0,
        mc_remaining_time: 0,
        layer_num: 0,
        total_layer_num: 0,
        subtask_name: '',
        stg_cur: -1,
        nozzle_temper: 26,
        nozzle_target_temper: 0,
        bed_temper: 25,
        bed_target_temper: 0,
        print_error: 0,
    },
};

/** A reply to a command, which must not be mistaken for status. */
export const commandReply = { print: { command: 'gcode_line', sequence_id: '7', result: 'success', param: 'M400' } };
