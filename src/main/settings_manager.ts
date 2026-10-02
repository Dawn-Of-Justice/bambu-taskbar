import fsa from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'node:events';
import TypedEventEmitter from 'typed-emitter';
import { USER_DATA_PATH } from './resources';
import type { AppSettings, PublicSettings } from '../shared/types';

export type { AppSettings } from '../shared/types';

const SETTINGS_FILE_PATH = path.join(USER_DATA_PATH, 'settings.json');

let _settings: AppSettings = createDefaultSettings();

class SettingsEmitter extends EventEmitter { }
type MessageEvents = { [Property in keyof AppSettings]: (value: AppSettings[Property]) => void } & {
    '_defaultSettingsCreated': () => void;
};
export const settingsChanges = new SettingsEmitter() as TypedEventEmitter<MessageEvents>;

/** Keys the settings window may change directly. Printer connection details go through savePrinter instead. */
export const RENDERER_EDITABLE_KEYS: (keyof AppSettings)[] = [
    'runAtStartup', 'iconStyle', 'allowUnverifiedCertificate',
    'notifyFinished', 'notifyFailed', 'notifyPaused', 'notifyStarted', 'notifyAlmostDone', 'almostDoneMinutes',
];

export function getSettings(): AppSettings {
    return { ..._settings };
}

export function getPublicSettings(): PublicSettings {
    const { accessCodeEncrypted, cloudTokenEncrypted, ...rest } = _settings;
    return { ...rest, hasAccessCode: accessCodeEncrypted.length > 0, cloudSignedIn: cloudTokenEncrypted.length > 0 };
}

export async function updateSettings(changes: Partial<AppSettings>) {
    const sanitized = sanitize(changes);
    const changedKeys = (Object.keys(sanitized) as (keyof AppSettings)[]).filter(k => sanitized[k] !== _settings[k]);
    _settings = { ..._settings, ...sanitized };
    await saveSettings();
    changedKeys.forEach(k => settingsChanges.emit(k, _settings[k] as never));
}

export async function loadSettings() {
    const defaults = createDefaultSettings();
    try {
        const loaded = JSON.parse(await fsa.readFile(SETTINGS_FILE_PATH, { encoding: 'utf8' }));
        if (!loaded || typeof loaded !== 'object') { throw new Error('Invalid settings file'); }
        // Merge with defaults so settings added in newer versions don't wipe existing choices.
        _settings = { ...defaults, ...sanitize(loaded) };
        await saveSettings();
    } catch (e) {
        _settings = defaults;
        await saveSettings();
        settingsChanges.emit('_defaultSettingsCreated');
    }
    (Object.keys(_settings) as (keyof AppSettings)[]).forEach(k => settingsChanges.emit(k, _settings[k] as never));
}

async function saveSettings() {
    try {
        await fsa.mkdir(path.dirname(SETTINGS_FILE_PATH), { recursive: true });
        await fsa.writeFile(SETTINGS_FILE_PATH, JSON.stringify(_settings, null, 2));
    } catch (e) {
        console.error(e);
    }
}

/** Keep only known keys with the right types, clamp numbers. */
export function sanitize(input: Partial<Record<keyof AppSettings, unknown>>): Partial<AppSettings> {
    const defaults = createDefaultSettings();
    const result: Partial<AppSettings> = {};
    for (const key of Object.keys(defaults) as (keyof AppSettings)[]) {
        if (!(key in input)) { continue; }
        const value = input[key];
        if (typeof value !== typeof defaults[key]) { continue; }
        (result as Record<string, unknown>)[key] = value;
    }
    if (result.iconStyle && !['percent', 'ring'].includes(result.iconStyle)) { delete result.iconStyle; }
    if (result.connectionMode && !['cloud', 'lan'].includes(result.connectionMode)) { delete result.connectionMode; }
    if (result.cloudRegion && !['global', 'china'].includes(result.cloudRegion)) { delete result.cloudRegion; }
    if (result.almostDoneMinutes !== undefined) {
        result.almostDoneMinutes = Math.round(Math.max(1, Math.min(120, result.almostDoneMinutes)));
    }
    for (const key of ['printerName', 'printerHost', 'printerSerial', 'printerModel'] as const) {
        if (result[key] !== undefined) { result[key] = (result[key] as string).trim().slice(0, 128); }
    }
    if (result.printerSerial !== undefined) { result.printerSerial = result.printerSerial.toUpperCase(); }
    return result;
}

export function createDefaultSettings(): AppSettings {
    return {
        runAtStartup: false,
        iconStyle: 'percent',
        connectionMode: 'cloud',
        cloudRegion: 'global',
        cloudEmail: '',
        cloudUsername: '',
        cloudTokenEncrypted: '',
        cloudTokenExpiresAt: 0,
        printerName: '',
        printerHost: '',
        printerSerial: '',
        printerModel: '',
        accessCodeEncrypted: '',
        allowUnverifiedCertificate: false,
        notifyFinished: true,
        notifyFailed: true,
        notifyPaused: true,
        notifyStarted: false,
        notifyAlmostDone: true,
        almostDoneMinutes: 10,
    };
}
