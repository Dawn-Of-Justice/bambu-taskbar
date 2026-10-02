import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudAuthError, CloudLogin, HttpClient, HttpResponse, listCloudPrinters, mqttHost, usernameFromToken } from '../src/main/cloud/cloud_auth';

type Handler = (body: Record<string, unknown>, headers: Record<string, string>) => Partial<HttpResponse> & { json?: unknown };

/** Fake Bambu API: routes by "METHOD url". Records every call. */
function fakeHttp(routes: Record<string, Handler>) {
    const calls: { key: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    const http: HttpClient = {
        async request(url, init) {
            const key = `${init.method} ${url}`;
            const body = (init.body ?? {}) as Record<string, unknown>;
            const headers = init.headers ?? {};
            calls.push({ key, body, headers });
            const handler = routes[key];
            if (!handler) { return { status: 404, text: '{"message":"not found"}', cookies: {} }; }
            const r = handler(body, headers);
            return { status: r.status ?? 200, text: r.text ?? JSON.stringify(r.json ?? {}), cookies: r.cookies ?? {} };
        },
    };
    return { http, calls };
}

const API = 'https://api.bambulab.com';
const jwt = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;

test('password sign-in returning a JWT token', async () => {
    const token = jwt({ username: 'u_123456' });
    const { http, calls } = fakeHttp({
        [`POST ${API}/v1/user-service/user/login`]: b => (b.password === 'pw' ? { json: { accessToken: token, expiresIn: 7776000, loginType: '' } } : { status: 400 }),
    });
    const r = await new CloudLogin(http).start('me@example.com', 'pw', 'global');
    assert.equal(r.status, 'signed-in');
    if (r.status !== 'signed-in') { return; }
    assert.equal(r.session.username, 'u_123456');
    assert.equal(r.session.token, token);
    assert.ok(r.session.expiresAt > Date.now() + 89 * 86_400_000);
    assert.equal(calls[0].headers['Content-Type'], 'application/json');
});

test('email code flow: code sent, expired code re-sent, wrong code, then success via preference uid', async () => {
    let attempt = 0;
    const { http, calls } = fakeHttp({
        [`POST ${API}/v1/user-service/user/login`]: b => {
            if (b.password) { return { json: { loginType: 'verifyCode' } }; }
            attempt++;
            if (attempt === 1) { return { status: 400, json: { code: 1, error: 'expired' } }; }
            if (attempt === 2) { return { status: 400, json: { code: 2, error: 'wrong' } }; }
            return { json: { accessToken: 'opaque-token' } };
        },
        [`POST ${API}/v1/user-service/user/sendemail/code`]: b => (b.type === 'codeLogin' && b.email === 'me@example.com' ? { json: {} } : { status: 400 }),
        [`GET ${API}/v1/design-user-service/my/preference`]: (_, h) => (h.Authorization === 'Bearer opaque-token' ? { json: { uid: 42 } } : { status: 401 }),
    });
    const login = new CloudLogin(http);
    assert.deepEqual(await login.start(' me@example.com ', 'pw', 'global'), { status: 'code-required' });
    assert.equal(calls.filter(c => c.key.endsWith('sendemail/code')).length, 1);

    await assert.rejects(login.verifyCode('111111'), (e: CloudAuthError) => e.kind === 'code-expired');
    assert.equal(calls.filter(c => c.key.endsWith('sendemail/code')).length, 2, 'expired code triggers a new email');
    await assert.rejects(login.verifyCode('222222'), (e: CloudAuthError) => e.kind === 'code-wrong');
    const session = await login.verifyCode(' 333333 ');
    assert.equal(session.username, 'u_42');
    assert.equal(calls.find(c => c.body.code === '333333')?.body.account, 'me@example.com');
});

test('two-factor flow uses the CSRF cookie and reads the token cookie (China region hosts)', async () => {
    const token = jwt({ username: 'u_7' });
    const { http, calls } = fakeHttp({
        'POST https://api.bambulab.cn/v1/user-service/user/login': () => ({ json: { loginType: 'tfa', tfaKey: 'tfa-key-1' } }),
        'GET https://bambulab.cn/api/csrf': () => ({ status: 204, cookies: { bbl_csrf_token: 'csrf-1' } }),
        'POST https://bambulab.cn/api/sign-in/tfa': (b, h) => (b.tfaKey === 'tfa-key-1' && b.tfaCode === '654321' && h['x-bbl-csrf-token'] === 'csrf-1'
            ? { cookies: { token } } : { status: 400 }),
    });
    const login = new CloudLogin(http);
    assert.deepEqual(await login.start('me@example.com', 'pw', 'china'), { status: 'tfa-required' });
    await assert.rejects(login.verifyTfa('000000'), (e: CloudAuthError) => e.kind === 'code-wrong');
    const session = await login.verifyTfa('654321');
    assert.equal(session.username, 'u_7');
    assert.equal(session.region, 'china');
    assert.equal(calls.filter(c => c.key.includes('/api/csrf')).length, 2);
    assert.equal(mqttHost('china'), 'cn.mqtt.bambulab.com');
    assert.equal(mqttHost('global'), 'us.mqtt.bambulab.com');
});

test('wrong password, Cloudflare block, network failure', async () => {
    const wrong = fakeHttp({ [`POST ${API}/v1/user-service/user/login`]: () => ({ status: 400, json: { code: 5, error: 'Incorrect password' } }) });
    await assert.rejects(new CloudLogin(wrong.http).start('a@b.c', 'x', 'global'),
        (e: CloudAuthError) => e.kind === 'credentials' && /Incorrect password/.test(e.message));

    const blocked = fakeHttp({ [`POST ${API}/v1/user-service/user/login`]: () => ({ status: 403, text: '<html>Attention Required! | Cloudflare</html>' }) });
    await assert.rejects(new CloudLogin(blocked.http).start('a@b.c', 'x', 'global'), (e: CloudAuthError) => e.kind === 'blocked');

    const down: HttpClient = { request: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')) };
    await assert.rejects(new CloudLogin(down).start('a@b.c', 'x', 'global'), (e: CloudAuthError) => e.kind === 'network');

    await assert.rejects(new CloudLogin(down).start('', '', 'global'), (e: CloudAuthError) => e.kind === 'credentials');
});

test('lists bound printers', async () => {
    const { http } = fakeHttp({
        [`GET ${API}/v1/iot-service/api/user/bind`]: (_, h) => (h.Authorization === 'Bearer t' ? {
            json: {
                message: 'success', devices: [
                    { dev_id: '01S00A000000001', name: 'Workshop', online: true, print_status: 'RUNNING', dev_model_name: 'C12', dev_product_name: 'P1S', dev_access_code: 'secret' },
                    { dev_id: '03919A000000002', name: '', online: false, dev_model_name: 'N2S' },
                    { name: 'broken entry' },
                ],
            },
        } : { status: 401 }),
    });
    const printers = await listCloudPrinters(http, { region: 'global', token: 't' });
    assert.deepEqual(printers, [
        { serial: '01S00A000000001', name: 'Workshop', model: 'P1S', online: true },
        { serial: '03919A000000002', name: '03919A000000002', model: 'N2S', online: false },
    ]);
    await assert.rejects(listCloudPrinters(http, { region: 'global', token: 'expired' }), (e: CloudAuthError) => e.kind === 'credentials');
});

test('usernameFromToken', () => {
    assert.equal(usernameFromToken(jwt({ username: 'u_99' })), 'u_99');
    assert.equal(usernameFromToken(jwt({ username: 'someone' })), null);
    assert.equal(usernameFromToken('opaque'), null);
    assert.equal(usernameFromToken('a.%%%.c'), null);
});
