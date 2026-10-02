/** Types shared between the main process, preload and the settings window. No runtime imports here. */

export type ConnectionState =
    | 'unconfigured'  // no printer set up yet
    | 'connecting'
    | 'connected'
    | 'offline'       // printer not reachable (off, wrong IP, not on LAN)
    | 'auth-failed'   // LAN: wrong access code / Developer mode off. Cloud: sign-in expired
    | 'signed-out'    // cloud mode without a Bambu account sign-in
    | 'tls-failed'    // certificate check failed
    | 'error';

export type PrintState = 'idle' | 'preparing' | 'printing' | 'paused' | 'finished' | 'failed' | 'unknown';

export interface PrintStatus {
    connection: ConnectionState;
    /** Human readable reason when connection is not 'connected'. */
    connectionMessage: string | null;
    mode: ConnectionMode;
    printerName: string;
    model: string | null;
    state: PrintState;
    /** 0-100, null when no print is known. */
    percent: number | null;
    remainingMinutes: number | null;
    layer: number | null;
    totalLayers: number | null;
    fileName: string | null;
    /** What the printer is doing right now, e.g. "Auto bed levelling", "Paused: filament runout". */
    stageName: string | null;
    nozzleTemp: number | null;
    nozzleTarget: number | null;
    bedTemp: number | null;
    bedTarget: number | null;
    /** Non-zero print_error code reported by the printer, if any. */
    errorCode: number | null;
    /** When the last report arrived (epoch ms). */
    lastUpdate: number | null;
}

export type IconStyle = 'percent' | 'ring';

/** How the app reaches the printer. */
export type ConnectionMode = 'cloud' | 'lan';
export type CloudRegion = 'global' | 'china';

export interface CloudPrinter {
    serial: string;
    name: string;
    model: string | null;
    online: boolean;
}

export type CloudLoginStep = 'signed-in' | 'code-required' | 'tfa-required';

export interface AppSettings {
    runAtStartup: boolean;
    iconStyle: IconStyle;
    connectionMode: ConnectionMode;
    cloudRegion: CloudRegion;
    /** Email of the signed-in Bambu account (shown in Settings); empty when signed out. */
    cloudEmail: string;
    /** MQTT username "u_<uid>". */
    cloudUsername: string;
    /** Access token, encrypted with Windows DPAPI. */
    cloudTokenEncrypted: string;
    /** Approximate token expiry (epoch ms); Bambu tokens last about 3 months. */
    cloudTokenExpiresAt: number;
    printerName: string;
    printerHost: string;
    printerSerial: string;
    /** Friendly model name from discovery, e.g. "P1S"; empty when unknown. */
    printerModel: string;
    /** Encrypted with Windows DPAPI (Electron safeStorage); empty when not set. */
    accessCodeEncrypted: string;
    /** Last resort for printers whose certificate cannot be verified. Off by default. */
    allowUnverifiedCertificate: boolean;
    notifyFinished: boolean;
    notifyFailed: boolean;
    notifyPaused: boolean;
    notifyStarted: boolean;
    notifyAlmostDone: boolean;
    almostDoneMinutes: number;
}

/** What the settings window may see: everything except the encrypted secrets. */
export type PublicSettings = Omit<AppSettings, 'accessCodeEncrypted' | 'cloudTokenEncrypted'> & {
    hasAccessCode: boolean;
    cloudSignedIn: boolean;
};

export interface PrinterConnectionInput {
    name: string;
    host: string;
    serial: string;
    model: string;
    /** Empty string = keep the stored access code. */
    accessCode: string;
}

export interface DiscoveredPrinter {
    host: string;
    serial: string;
    name: string | null;
    model: string | null;
    /** "lan" when the printer reports LAN mode, "cloud" otherwise, if known. */
    connectMode: string | null;
}

export interface IconPreviewRequest {
    style: IconStyle;
    state: PrintState | 'offline';
    percent: number | null;
    lightTaskbar: boolean;
    size: number;
}

export interface AppInfo {
    version: string;
    supportsMica: boolean;
    lightTaskbar: boolean;
}

export interface TrayAppApi {
    getSettings(): Promise<PublicSettings>;
    updateSettings(changes: Partial<PublicSettings>): Promise<void>;
    savePrinter(input: PrinterConnectionInput): Promise<void>;
    setConnectionMode(mode: ConnectionMode): Promise<void>;
    cloudSignIn(email: string, password: string, region: CloudRegion): Promise<CloudLoginStep>;
    /** Sign in on Bambu Lab's website in a window (Google, Apple, email). 'cancelled' if the window was closed. */
    cloudSignInWithBrowser(region: CloudRegion): Promise<CloudLoginStep | 'cancelled'>;
    cloudVerifyCode(code: string): Promise<CloudLoginStep>;
    cloudVerifyTfa(code: string): Promise<CloudLoginStep>;
    cloudResendCode(): Promise<void>;
    cloudSignOut(): Promise<void>;
    cloudListPrinters(): Promise<CloudPrinter[]>;
    cloudSelectPrinter(printer: CloudPrinter): Promise<void>;
    getStatus(): Promise<PrintStatus>;
    onStatusChanged(callback: (status: PrintStatus) => void): () => void;
    discoverPrinters(seconds: number): Promise<DiscoveredPrinter[]>;
    renderIcon(request: IconPreviewRequest): Promise<string>;
    getAppInfo(): Promise<AppInfo>;
    sendTestNotification(): Promise<void>;
    openExternal(target: 'github' | 'setup-guide'): Promise<void>;
}
