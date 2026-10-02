import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnnouncement } from '../src/main/printer/discovery';

const notify = [
    'NOTIFY * HTTP/1.1',
    'HOST: 239.255.255.250:1900',
    'Server: UPnP/1.0',
    'Location: 192.168.1.42',
    'NT: urn:bambulab-com:device:3dprinter:1',
    'USN: 01S00A000000001',
    'Cache-Control: max-age=1800',
    'DevModel.bambu.com: C12',
    'DevName.bambu.com: Workshop P1S',
    'DevConnect.bambu.com: lan',
    'DevBind.bambu.com: free',
    '', '',
].join('\r\n');

test('parses a Bambu printer announcement', () => {
    assert.deepEqual(parseAnnouncement(notify, '192.168.1.42'), {
        host: '192.168.1.42', serial: '01S00A000000001', name: 'Workshop P1S', model: 'P1S', connectMode: 'lan',
    });
});

test('falls back to the sender address and keeps unknown model codes', () => {
    const msg = notify.replace('Location: 192.168.1.42\r\n', '').replace('C12', 'Z99');
    const p = parseAnnouncement(msg, '10.0.0.7');
    assert.equal(p.host, '10.0.0.7');
    assert.equal(p.model, 'Z99');
});

test('ignores other SSDP devices', () => {
    const tv = 'NOTIFY * HTTP/1.1\r\nLocation: http://192.168.1.9:8080/desc.xml\r\nNT: upnp:rootdevice\r\nUSN: uuid:abc::upnp:rootdevice\r\n\r\n';
    assert.equal(parseAnnouncement(tv, '192.168.1.9'), null);
    assert.equal(parseAnnouncement('garbage'), null);
});
