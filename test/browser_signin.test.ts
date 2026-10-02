import './helpers/electron_stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTokenCookie, signInUrl } from '../src/main/cloud/browser_signin';
import { HttpClient, sessionFromToken } from '../src/main/cloud/cloud_auth';

test('only a non-empty "token" cookie from the region\'s Bambu site counts', () => {
    assert.ok(isTokenCookie({ name: 'token', value: 'abc', domain: '.bambulab.com' }, 'global'));
    assert.ok(isTokenCookie({ name: 'token', value: 'abc', domain: 'bambulab.com' }, 'global'));
    assert.ok(isTokenCookie({ name: 'token', value: 'abc', domain: '.bambulab.cn' }, 'china'));
    assert.ok(!isTokenCookie({ name: 'token', value: '', domain: '.bambulab.com' }, 'global'));
    assert.ok(!isTokenCookie({ name: 'token', value: 'abc', domain: '.google.com' }, 'global'));
    assert.ok(!isTokenCookie({ name: 'token', value: 'abc', domain: 'evilbambulab.com' }, 'global'));
    assert.ok(!isTokenCookie({ name: 'token', value: 'abc', domain: '.bambulab.cn' }, 'global'));
    assert.ok(!isTokenCookie({ name: 'bbl_csrf_token', value: 'abc', domain: '.bambulab.com' }, 'global'));
});

test('sign-in page per region', () => {
    assert.equal(signInUrl('global'), 'https://bambulab.com/en/sign-in');
    assert.equal(signInUrl('china'), 'https://bambulab.cn/sign-in');
});

function http(routes: Record<string, (h: Record<string, string>) => { status?: number; json?: unknown }>): HttpClient {
    return {
        async request(url, init) {
            const r = routes[`${init.method} ${url}`]?.(init.headers ?? {}) ?? { status: 404 };
            return { status: r.status ?? 200, text: JSON.stringify(r.json ?? {}), cookies: {} };
        },
    };
}

test('website token: user id from the API, email from the profile, cookie expiry kept', async () => {
    const expiresAt = Date.now() + 30 * 86_400_000;
    const s = await sessionFromToken(http({
        'GET https://api.bambulab.com/v1/design-user-service/my/preference': h => (h.Authorization === 'Bearer web-token' ? { json: { uid: 77 } } : { status: 401 }),
        'GET https://api.bambulab.com/v1/user-service/my/profile': () => ({ json: { uid: 77, account: 'anju@gmail.com' } }),
    }), 'global', 'web-token', { expiresAt });
    assert.deepEqual(s, { region: 'global', email: 'anju@gmail.com', username: 'u_77', token: 'web-token', expiresAt });
});

test('website token rejected by the API', async () => {
    await assert.rejects(sessionFromToken(http({
        'GET https://api.bambulab.com/v1/design-user-service/my/preference': () => ({ status: 401 }),
    }), 'global', 'bad'), /did not accept/);
});

test('website token with no profile still signs in (email left blank, default expiry)', async () => {
    const jwt = `x.${Buffer.from(JSON.stringify({ username: 'u_5' })).toString('base64url')}.y`;
    const s = await sessionFromToken(http({}), 'china', jwt, { expiresAt: null });
    assert.equal(s.username, 'u_5');
    assert.equal(s.email, '');
    assert.ok(s.expiresAt > Date.now() + 89 * 86_400_000);
});
