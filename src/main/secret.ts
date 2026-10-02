import { safeStorage } from 'electron';

/**
 * The printer's access code is stored encrypted with Windows DPAPI (via Electron safeStorage), so it is tied to
 * your Windows account and not readable from settings.json alone.
 */
export function encryptSecret(plain: string): string {
    if (!plain) { return ''; }
    if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Secure storage is not available on this system.');
    }
    return safeStorage.encryptString(plain).toString('base64');
}

export function decryptSecret(encrypted: string): string {
    if (!encrypted) { return ''; }
    try {
        return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
        return ''; // e.g. settings copied from another Windows account: ask for the code again
    }
}
