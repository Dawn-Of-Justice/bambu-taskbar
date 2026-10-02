/**
 * End-to-end test of the printer connection against a fake printer: an MQTT broker (aedes) over TLS with a
 * certificate issued to the serial number, checking the access code like a real printer does.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'tls';
import type { AddressInfo } from 'net';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const aedesFactory = require('aedes');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const selfsigned = require('selfsigned');
import { BambuClient, classifyError } from '../src/main/printer/bambu_client';
import type { PrintStatus } from '../src/shared/types';
import { delta, fullPrinting } from './fixtures/reports';

const SERIAL = '01S00A000000001';
const CODE = '12345678';
const pems = selfsigned.generate([{ name: 'commonName', value: SERIAL }], { days: 1, keySize: 2048, algorithm: 'sha256' });

interface FakePrinter { port: number; requests: unknown[]; publish(report: object): void; close(): Promise<void>; }

async function startFakePrinter(): Promise<FakePrinter> {
    const broker = aedesFactory();
    const requests: unknown[] = [];
    broker.authenticate = (_client: unknown, username: string, password: Buffer, done: (err: Error | null, ok?: boolean) => void) => {
        if (username === 'bblp' && password?.toString() === CODE) { return done(null, true); }
        const err = new Error('Bad username or password') as Error & { returnCode: number };
        err.returnCode = 4;
        done(err, false);
    };
    broker.on('publish', (packet: { topic: string; payload: Buffer }) => {
        if (packet.topic === `device/${SERIAL}/request`) { requests.push(JSON.parse(packet.payload.toString())); }
    });
    const server = tls.createServer({ key: pems.private, cert: pems.cert }, broker.handle);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    return {
        port: (server.address() as AddressInfo).port,
        requests,
        publish: report => broker.publish({ topic: `device/${SERIAL}/report`, payload: Buffer.from(JSON.stringify(report)), qos: 0, retain: false, cmd: 'publish', dup: false }, (): void => undefined),
        close: () => new Promise<void>(r => { broker.close(() => server.close(() => r())); }),
    };
}

function waitForStatus(client: BambuClient, check: (s: PrintStatus) => boolean, ms = 8000): Promise<PrintStatus> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out; last status ${JSON.stringify(client.status())}`)), ms);
        const listener = (s: PrintStatus) => { if (check(s)) { clearTimeout(t); client.removeListener('status', listener); resolve(s); } };
        client.on('status', listener);
        if (check(client.status())) { clearTimeout(t); client.removeListener('status', listener); resolve(client.status()); }
    });
}

const clients: BambuClient[] = [];
const make = (port: number, overrides: Partial<ConstructorParameters<typeof BambuClient>[0]> = {}) => {
    const c = new BambuClient({
        mode: 'lan', host: '127.0.0.1', port, serial: SERIAL, username: 'bblp', password: CODE, name: 'Test printer',
        ca: pems.cert, verifyPrinterIdentity: true, reconnectPeriodMs: 500, connectTimeoutMs: 3000, ...overrides,
    });
    clients.push(c);
    return c;
};
after(() => clients.forEach(c => c.stop()));

test('connects with TLS, asks for a full report and merges partial updates', async () => {
    const printer = await startFakePrinter();
    try {
        const client = make(printer.port);
        client.start();
        await waitForStatus(client, s => s.connection === 'connected');
        // the client subscribes, then requests pushall
        await new Promise(r => setTimeout(r, 300));
        assert.deepEqual((printer.requests[0] as { pushing: { command: string } }).pushing.command, 'pushall');

        printer.publish(fullPrinting);
        let s = await waitForStatus(client, x => x.state === 'printing');
        assert.equal(s.percent, 42);
        printer.publish(delta({ mc_percent: 43 }));
        s = await waitForStatus(client, x => x.percent === 43);
        assert.equal(s.fileName, 'Benchy');
        assert.equal(s.printerName, 'Test printer');
        assert.ok(s.lastUpdate);
    } finally {
        await printer.close();
    }
});

test('wrong access code -> auth-failed and stops retrying', async () => {
    const printer = await startFakePrinter();
    try {
        const client = make(printer.port, { password: 'wrong000' });
        client.start();
        const s = await waitForStatus(client, x => x.connection === 'auth-failed');
        assert.match(s.connectionMessage, /access code/);
    } finally {
        await printer.close();
    }
});

test('certificate for a different serial -> tls-failed', async () => {
    const printer = await startFakePrinter();
    try {
        const client = make(printer.port, { serial: '01S00A999999999' });
        client.start();
        const s = await waitForStatus(client, x => x.connection === 'tls-failed');
        assert.match(s.connectionMessage, /certificate/);
    } finally {
        await printer.close();
    }
});

test('nothing listening -> offline (keeps retrying)', async () => {
    const client = make(1); // port 1: connection refused
    client.start();
    const s = await waitForStatus(client, x => x.connection === 'offline');
    assert.match(s.connectionMessage, /Retrying/);
});

test('cloud mode: system-style TLS (hostname check), u_<uid> + token, and a "printer off" hint', async () => {
    // Stand-in for us.mqtt.bambulab.com: certificate issued to "localhost".
    const cloudPems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
        days: 1, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] }],
    });
    const broker = aedesFactory();
    broker.authenticate = (_c: unknown, user: string, pass: Buffer, done: (e: Error | null, ok?: boolean) => void) => {
        if (user === 'u_123' && pass?.toString() === 'cloud-token') { return done(null, true); }
        done(Object.assign(new Error('Not authorized'), { returnCode: 5 }), false);
    };
    const server = tls.createServer({ key: cloudPems.private, cert: cloudPems.cert }, broker.handle);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
        const ok = new BambuClient({ mode: 'cloud', host: 'localhost', port, serial: SERIAL, username: 'u_123', password: 'cloud-token', name: 'P', ca: cloudPems.cert, firstReportTimeoutMs: 300, reconnectPeriodMs: 500 });
        clients.push(ok);
        ok.start();
        const s = await waitForStatus(ok, x => x.connection === 'connected' && /switched on/.test(x.connectionMessage ?? ''));
        assert.equal(s.mode, 'cloud');
        assert.equal(s.state, 'unknown');

        const expired = new BambuClient({ mode: 'cloud', host: 'localhost', port, serial: SERIAL, username: 'u_123', password: 'old', name: 'P', ca: cloudPems.cert, reconnectPeriodMs: 500 });
        clients.push(expired);
        expired.start();
        const e = await waitForStatus(expired, x => x.connection === 'auth-failed');
        assert.match(e.connectionMessage, /sign in again/i);
    } finally {
        await new Promise<void>(r => { broker.close(() => server.close(() => r())); });
    }
});

test('error classification', () => {
    const e = (code: string | number, message = 'x') => Object.assign(new Error(message), { code });
    assert.equal(classifyError(e(5, 'Connection refused: Not authorized')), 'auth-failed');
    assert.equal(classifyError(e('SELF_SIGNED_CERT_IN_CHAIN')), 'tls-failed');
    assert.equal(classifyError(e('EHOSTUNREACH')), 'offline');
    assert.equal(classifyError(e('WHATEVER')), 'other');
});
