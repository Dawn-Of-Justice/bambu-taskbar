/**
 * Finds Bambu Lab printers on the local network.
 *
 * Printers announce themselves with SSDP-style "NOTIFY" datagrams on UDP ports 2021 and 1990, roughly every few
 * seconds, e.g.:
 *
 *   NOTIFY * HTTP/1.1
 *   Location: 192.168.1.42
 *   USN: 01S00A000000000
 *   DevModel.bambu.com: C12
 *   DevName.bambu.com: My P1S
 *   DevConnect.bambu.com: lan
 *
 * We listen for a few seconds and also send an M-SEARCH, which makes some printers answer immediately.
 */
import dgram from 'dgram';
import type { DiscoveredPrinter } from '../../shared/types';
import { modelName } from './printer_info';

const PORTS = [2021, 1990];
const M_SEARCH = [
    'M-SEARCH * HTTP/1.1',
    'HOST: 239.255.255.250:1990',
    'MAN: "ssdp:discover"',
    'MX: 1',
    'ST: urn:bambulab-com:device:3dprinter:1',
    '', '',
].join('\r\n');

/** Parse one announcement. Returns null for anything that is not a Bambu printer. */
export function parseAnnouncement(message: string, senderAddress?: string): DiscoveredPrinter | null {
    const headers = new Map<string, string>();
    for (const line of message.split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i > 0) { headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()); }
    }
    const isBambu = (headers.get('nt') ?? headers.get('st') ?? '').includes('bambulab')
        || [...headers.keys()].some(k => k.endsWith('.bambu.com'));
    const serial = headers.get('usn');
    if (!isBambu || !serial) { return null; }

    const host = headers.get('location') || senderAddress;
    if (!host) { return null; }
    return {
        host: host.replace(/^https?:\/\//, '').replace(/[:/].*$/, ''),
        serial,
        name: headers.get('devname.bambu.com') || null,
        model: modelName(headers.get('devmodel.bambu.com')),
        connectMode: headers.get('devconnect.bambu.com') || null,
    };
}

/** Listen for `seconds` and return every printer heard, de-duplicated by serial number. */
export function discoverPrinters(seconds: number): Promise<DiscoveredPrinter[]> {
    const found = new Map<string, DiscoveredPrinter>();
    const sockets: dgram.Socket[] = [];

    return new Promise(resolve => {
        for (const port of PORTS) {
            const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            socket.on('error', () => socket.close()); // port busy (e.g. Bambu Studio is listening): use the other one
            socket.on('message', (msg, rinfo) => {
                const printer = parseAnnouncement(msg.toString('utf8'), rinfo.address);
                if (printer) { found.set(printer.serial, printer); }
            });
            socket.bind(port, () => {
                try {
                    socket.setBroadcast(true);
                    socket.send(M_SEARCH, 2021, '255.255.255.255');
                    socket.send(M_SEARCH, 1990, '239.255.255.250');
                } catch { /* sending is best effort */ }
            });
            sockets.push(socket);
        }

        setTimeout(() => {
            for (const s of sockets) { try { s.close(); } catch { /* already closed */ } }
            resolve([...found.values()].sort((a, b) => (a.name ?? a.serial).localeCompare(b.name ?? b.serial)));
        }, Math.max(1, Math.min(30, seconds)) * 1000);
    });
}
