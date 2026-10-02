/**
 * MQTT connection that receives a Bambu Lab printer's status, either:
 *
 * - **cloud**: through Bambu's broker (us.mqtt.bambulab.com / cn.mqtt.bambulab.com:8883), signed in with the
 *   account's MQTT username "u_<uid>" and access token. Works with the printer in its normal mode, so Bambu
 *   Handy keeps working. Reading status is allowed for third-party apps under Bambu's authorization firmware.
 * - **lan**: directly to the printer (port 8883), username "bblp" + the LAN access code. Needs LAN Only and
 *   Developer mode. The printer's certificate is issued by Bambu Lab's own CA to its serial number, so we
 *   connect with servername = serial and check the CN ourselves.
 *
 * Either way, status arrives on `device/<serial>/report` and requests go to `device/<serial>/request`.
 */
import { EventEmitter } from 'events';
import type { PeerCertificate } from 'tls';
import mqtt, { IClientOptions, MqttClient } from 'mqtt';
import type { ConnectionMode, ConnectionState, PrintStatus } from '../../shared/types';
import { PrintStateStore } from './print_state';

export interface BambuClientOptions {
    mode: ConnectionMode;
    host: string;
    port?: number;
    serial: string;
    username: string;
    password: string;
    name: string;
    model?: string | null;
    /** PEM CA certificate(s). LAN: Bambu Lab's CA. Cloud: leave empty to use the system's trusted CAs. */
    ca?: string | Buffer;
    /** LAN: check that the certificate is issued to the printer's serial number. */
    verifyPrinterIdentity?: boolean;
    /** Skip certificate verification (LAN last resort, off by default). */
    allowUnverified?: boolean;
    /** How often to ask for a full status report. P1 printers should not be asked more than every 5 minutes. */
    pushAllIntervalMs?: number;
    reconnectPeriodMs?: number;
    connectTimeoutMs?: number;
    /** After connecting, how long to wait for a first report before saying the printer seems off. */
    firstReportTimeoutMs?: number;
}

type ClientEvents = { status: (status: PrintStatus) => void };

export class BambuClient extends EventEmitter {
    private client: MqttClient | null = null;
    private readonly store = new PrintStateStore();
    private connection: ConnectionState = 'connecting';
    private message: string | null = 'Connecting…';
    private lastUpdate: number | null = null;
    private pushAllTimer: NodeJS.Timeout | null = null;
    private firstReportTimer: NodeJS.Timeout | null = null;
    private sequence = 0;
    private stopped = false;

    constructor(private readonly options: BambuClientOptions) {
        super();
    }

    override on<E extends keyof ClientEvents>(event: E, listener: ClientEvents[E]): this {
        return super.on(event, listener);
    }

    private get where(): string {
        return this.options.mode === 'cloud' ? 'Bambu Cloud' : `the printer at ${this.options.host}`;
    }

    start(): void {
        const o = this.options;
        this.stopped = false;
        this.setConnection('connecting', `Connecting to ${this.where}…`);

        // Extra TLS options (servername, checkServerIdentity) are passed through to tls.connect by mqtt.js.
        const connectOptions: IClientOptions & { checkServerIdentity?: (host: string, cert: PeerCertificate) => Error | undefined } = {
            protocol: 'mqtts',
            host: o.host,
            port: o.port ?? 8883,
            username: o.username,
            password: o.password,
            clientId: `bambu-taskbar-${Math.random().toString(16).slice(2, 10)}`,
            protocolVersion: 4,
            clean: true,
            keepalive: 30,
            reconnectPeriod: o.reconnectPeriodMs ?? 5000,
            connectTimeout: o.connectTimeoutMs ?? 10000,
            rejectUnauthorized: !o.allowUnverified,
        };
        if (o.ca) { connectOptions.ca = o.ca; }
        if (o.verifyPrinterIdentity) {
            connectOptions.servername = o.serial;
            connectOptions.checkServerIdentity = (_host, cert) => checkPrinterIdentity(cert, o.serial);
        }

        const client = mqtt.connect(connectOptions);
        this.client = client;

        client.on('connect', () => {
            this.setConnection('connected', null);
            client.subscribe(`device/${o.serial}/report`, err => {
                if (err) { this.setConnection('error', `Could not subscribe: ${err.message}`); return; }
                this.requestFullStatus();
                this.watchFirstReport();
            });
            this.schedulePushAll();
        });

        client.on('message', (_topic, payload) => {
            let report: unknown;
            try { report = JSON.parse(payload.toString('utf8')); } catch { return; }
            if (this.store.merge(report)) {
                this.lastUpdate = Date.now();
                if (this.firstReportTimer) { clearTimeout(this.firstReportTimer); this.firstReportTimer = null; }
                this.message = null;
                this.emitStatus();
            }
        });

        client.on('error', err => this.onError(err));
        client.on('close', () => {
            if (this.stopped) { return; }
            if (this.connection === 'connected' || this.connection === 'connecting') {
                this.setConnection('offline', `Can't reach ${this.where}. Retrying…`);
            }
        });
    }

    stop(): void {
        this.stopped = true;
        if (this.pushAllTimer) { clearInterval(this.pushAllTimer); }
        if (this.firstReportTimer) { clearTimeout(this.firstReportTimer); }
        this.pushAllTimer = null;
        this.firstReportTimer = null;
        this.client?.end(true);
        this.client = null;
    }

    /** Ask for a complete report (P1/A1 printers otherwise only send changes). */
    requestFullStatus(): void {
        this.publish({ pushing: { sequence_id: String(this.sequence++), command: 'pushall', version: 1, push_target: 1 } });
    }

    status(): PrintStatus {
        return {
            connection: this.connection,
            connectionMessage: this.message,
            mode: this.options.mode,
            printerName: this.options.name || this.options.serial,
            model: this.options.model || null,
            lastUpdate: this.lastUpdate,
            ...this.store.derive(),
        };
    }

    private publish(payload: object): void {
        if (this.client?.connected) {
            this.client.publish(`device/${this.options.serial}/request`, JSON.stringify(payload));
        }
    }

    private schedulePushAll(): void {
        if (this.pushAllTimer) { clearInterval(this.pushAllTimer); }
        const every = this.options.pushAllIntervalMs ?? 10 * 60 * 1000;
        this.pushAllTimer = setInterval(() => this.requestFullStatus(), every);
    }

    /** Connected to the broker but nothing from the printer: most likely it is switched off. */
    private watchFirstReport(): void {
        if (this.store.received || this.firstReportTimer) { return; }
        this.firstReportTimer = setTimeout(() => {
            this.firstReportTimer = null;
            if (!this.store.received && this.connection === 'connected') {
                this.message = this.options.mode === 'cloud'
                    ? 'Connected to Bambu Cloud, but the printer is not sending status. Is it switched on?'
                    : 'Connected, but the printer is not sending status yet.';
                this.emitStatus();
            }
        }, this.options.firstReportTimeoutMs ?? 20000);
    }

    private onError(err: Error & { code?: string | number }): void {
        if (this.stopped) { return; }
        const kind = classifyError(err);
        const cloud = this.options.mode === 'cloud';
        if (kind === 'auth-failed') {
            this.setConnection('auth-failed', cloud
                ? 'Bambu Cloud refused the sign-in. It has probably expired: sign in again in Settings.'
                : 'The printer rejected the access code. Check the code on the printer screen, and that LAN Only mode and Developer mode are on.');
            this.stop(); // retrying with the same credentials won't help
        } else if (kind === 'tls-failed') {
            this.setConnection('tls-failed', cloud
                ? `Could not verify Bambu Cloud's certificate (${err.message}).`
                : `Could not verify the printer's certificate (${err.message}). Check the serial number.`);
            this.stop();
        } else if (kind === 'offline') {
            this.setConnection('offline', `Can't reach ${this.where} (${err.code ?? err.message}). Retrying…`);
        } else {
            this.setConnection('error', err.message);
        }
    }

    private setConnection(connection: ConnectionState, message: string | null): void {
        if (this.connection === connection && this.message === message) { return; }
        this.connection = connection;
        this.message = message;
        this.emitStatus();
    }

    private emitStatus(): void {
        this.emit('status', this.status());
    }
}

/** The printer's certificate is issued to its serial number (CN), not to its IP address. */
export function checkPrinterIdentity(cert: PeerCertificate, serial: string): Error | undefined {
    const cn = cert?.subject?.CN;
    const names = Array.isArray(cn) ? cn : [cn];
    if (names.some(n => typeof n === 'string' && n.toUpperCase() === serial.toUpperCase())) { return undefined; }
    const err = new Error(`certificate is for "${names.join(', ')}", expected serial ${serial}`) as Error & { code: string };
    err.code = 'ERR_PRINTER_IDENTITY';
    return err;
}

export function classifyError(err: Error & { code?: string | number }): 'auth-failed' | 'tls-failed' | 'offline' | 'other' {
    const code = err.code;
    const text = `${code ?? ''} ${err.message}`.toLowerCase();
    // MQTT 3.1.1 CONNACK: 4 = bad username or password, 5 = not authorized
    if (code === 4 || code === 5 || text.includes('not authorized') || text.includes('bad username or password')) {
        return 'auth-failed';
    }
    if (typeof code === 'string' && (code.startsWith('CERT_') || code.startsWith('ERR_TLS') || code === 'ERR_PRINTER_IDENTITY'
        || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
        || code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY')) {
        return 'tls-failed';
    }
    if (typeof code === 'string' && ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
        return 'offline';
    }
    if (text.includes('connack timeout') || text.includes('timeout')) { return 'offline'; }
    return 'other';
}
