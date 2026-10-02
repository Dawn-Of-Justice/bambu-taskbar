/**
 * Bambu Lab account sign-in and printer list (the same HTTP API Bambu Studio and OrcaSlicer use).
 *
 * Sign-in can take up to two steps:
 *   1. POST /v1/user-service/user/login {account, password}
 *      → accessToken directly, or
 *      → loginType "verifyCode": Bambu wants a one-time code sent by email
 *        (POST /v1/user-service/user/sendemail/code, then login again with {account, code}), or
 *      → loginType "tfa": the account has two-factor authentication
 *        (GET bambulab.com/api/csrf for a CSRF cookie, POST bambulab.com/api/sign-in/tfa {tfaKey, tfaCode};
 *         the token comes back as a "token" cookie).
 *   2. The MQTT username is "u_<uid>", read from the token (JWT) or from /v1/design-user-service/my/preference.
 *
 * Tokens last about 3 months and can't be refreshed any more, so the user signs in again when one expires.
 * The password is only used for the request and never stored.
 */
import type { CloudPrinter, CloudRegion } from '../../shared/types';

export interface HttpResponse {
    status: number;
    text: string;
    /** Cookies set by the response's host, by name. */
    cookies: Record<string, string>;
}

/** Minimal HTTP client so the flow can be tested without Electron or the internet. */
export interface HttpClient {
    request(url: string, init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown }): Promise<HttpResponse>;
}

export interface CloudSession {
    region: CloudRegion;
    email: string;
    /** MQTT username, "u_<uid>". */
    username: string;
    token: string;
    /** Epoch ms when the token expires (approximate). */
    expiresAt: number;
}

export type LoginResult =
    | { status: 'signed-in'; session: CloudSession }
    | { status: 'code-required' }   // a code was emailed; call verifyCode
    | { status: 'tfa-required' };   // call verifyTfa with the authenticator code

export class CloudAuthError extends Error {
    constructor(message: string, readonly kind: 'credentials' | 'code-expired' | 'code-wrong' | 'blocked' | 'network' | 'unexpected') {
        super(message);
    }
}

const DEFAULT_TOKEN_LIFETIME_S = 90 * 24 * 3600;

export function apiBase(region: CloudRegion): string {
    return region === 'china' ? 'https://api.bambulab.cn' : 'https://api.bambulab.com';
}

export function webBase(region: CloudRegion): string {
    return region === 'china' ? 'https://bambulab.cn' : 'https://bambulab.com';
}

export function mqttHost(region: CloudRegion): string {
    return region === 'china' ? 'cn.mqtt.bambulab.com' : 'us.mqtt.bambulab.com';
}

/** Headers Bambu's API expects from a slicer client (the same set OrcaSlicer/ha-bambulab send). */
const CLIENT_HEADERS: Record<string, string> = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'X-BBL-Client-Name': 'OrcaSlicer',
    'X-BBL-Client-Type': 'slicer',
    'X-BBL-Client-Version': '01.09.05.51',
    'X-BBL-Language': 'en-US',
    'X-BBL-OS-Type': 'windows',
};

/** One sign-in attempt; keeps the in-between state (email, 2FA key) in memory only. */
export class CloudLogin {
    private email = '';
    private region: CloudRegion = 'global';
    private tfaKey: string | null = null;

    constructor(private readonly http: HttpClient) { }

    async start(email: string, password: string, region: CloudRegion): Promise<LoginResult> {
        this.email = email.trim();
        this.region = region;
        this.tfaKey = null;
        if (!this.email || !password) { throw new CloudAuthError('Enter your Bambu Lab email and password.', 'credentials'); }

        const res = await this.post(`${apiBase(region)}/v1/user-service/user/login`, { account: this.email, password, apiError: '' });
        const body = parseJson(res.text);
        if (res.status >= 400) { throw errorFrom(res, body, 'credentials'); }

        if (typeof body.accessToken === 'string' && body.accessToken) {
            return { status: 'signed-in', session: await this.finish(body.accessToken, num(body.expiresIn)) };
        }
        if (body.loginType === 'verifyCode') {
            await this.sendCode();
            return { status: 'code-required' };
        }
        if (body.loginType === 'tfa' && typeof body.tfaKey === 'string') {
            this.tfaKey = body.tfaKey;
            return { status: 'tfa-required' };
        }
        throw new CloudAuthError('Bambu Lab sent an unexpected sign-in response.', 'unexpected');
    }

    /** Email a (new) one-time code. */
    async sendCode(): Promise<void> {
        const res = await this.post(`${apiBase(this.region)}/v1/user-service/user/sendemail/code`, { email: this.email, type: 'codeLogin' });
        if (res.status >= 400) { throw errorFrom(res, parseJson(res.text), 'unexpected'); }
    }

    async verifyCode(code: string): Promise<CloudSession> {
        const res = await this.post(`${apiBase(this.region)}/v1/user-service/user/login`, { account: this.email, code: code.trim() });
        const body = parseJson(res.text);
        if (res.status === 400 && body.code === 1) {
            await this.sendCode();
            throw new CloudAuthError('That code has expired. A new one has been emailed to you.', 'code-expired');
        }
        if (res.status === 400 && body.code === 2) {
            throw new CloudAuthError('That code is not right. Check the email and try again.', 'code-wrong');
        }
        if (res.status >= 400 || typeof body.accessToken !== 'string' || !body.accessToken) {
            throw errorFrom(res, body, 'unexpected');
        }
        return this.finish(body.accessToken, num(body.expiresIn));
    }

    async verifyTfa(code: string): Promise<CloudSession> {
        if (!this.tfaKey) { throw new CloudAuthError('Start signing in again.', 'unexpected'); }
        const web = webBase(this.region);
        const csrf = await this.request(`${web}/api/csrf`, { method: 'GET', headers: CLIENT_HEADERS });
        const csrfToken = csrf.cookies.bbl_csrf_token;
        if (!csrfToken) { throw new CloudAuthError('Could not start two-factor sign-in (no CSRF token). Try again.', 'unexpected'); }

        const res = await this.request(`${web}/api/sign-in/tfa`, {
            method: 'POST',
            headers: { ...CLIENT_HEADERS, 'x-bbl-csrf-token': csrfToken },
            body: { tfaKey: this.tfaKey, tfaCode: code.trim() },
        });
        const token = res.cookies.token;
        if (res.status >= 400 || !token) {
            throw res.status === 400 || res.status === 401
                ? new CloudAuthError('That authenticator code is not right. Try the current one.', 'code-wrong')
                : errorFrom(res, parseJson(res.text), 'unexpected');
        }
        return this.finish(token, null);
    }

    private finish(token: string, expiresIn: number | null): Promise<CloudSession> {
        return sessionFromToken(this.http, this.region, token, {
            email: this.email,
            expiresAt: Date.now() + (expiresIn && expiresIn > 0 ? expiresIn : DEFAULT_TOKEN_LIFETIME_S) * 1000,
        });
    }

    private post(url: string, body: unknown): Promise<HttpResponse> {
        return this.request(url, { method: 'POST', headers: CLIENT_HEADERS, body });
    }

    private async request(url: string, init: Parameters<HttpClient['request']>[1]): Promise<HttpResponse> {
        let res: HttpResponse;
        try {
            res = await this.http.request(url, init);
        } catch (e) {
            throw new CloudAuthError(`Could not reach Bambu Lab (${(e as Error).message}). Check your internet connection.`, 'network');
        }
        if ((res.status === 403 || res.status === 429) && /cloudflare/i.test(res.text)) {
            throw new CloudAuthError('Bambu Lab\'s servers blocked the request for now. Wait a few minutes and try again.', 'blocked');
        }
        return res;
    }
}

/**
 * Turns an access token into a session: works out the MQTT username ("u_<uid>") and, when not known, the
 * account's email. Used after password sign-in and after signing in on Bambu's website (Google, Apple…).
 */
export async function sessionFromToken(
    http: HttpClient, region: CloudRegion, token: string, opts: { email?: string; expiresAt?: number | null } = {},
): Promise<CloudSession> {
    const auth = { ...CLIENT_HEADERS, Authorization: `Bearer ${token}` };
    let username = usernameFromToken(token);
    if (!username) {
        const res = await safeRequest(http, `${apiBase(region)}/v1/design-user-service/my/preference`, { method: 'GET', headers: auth });
        if (res && (res.status === 401 || res.status === 403)) {
            throw new CloudAuthError('Bambu Lab did not accept the sign-in. Try again.', 'credentials');
        }
        const uid = res && res.status < 400 ? parseJson(res.text).uid : undefined;
        username = (typeof uid === 'number' || typeof uid === 'string') && String(uid) ? `u_${uid}` : null;
    }
    if (!username) { throw new CloudAuthError('Signed in, but could not read your Bambu user id.', 'unexpected'); }

    let email = opts.email?.trim() ?? '';
    if (!email) {
        const res = await safeRequest(http, `${apiBase(region)}/v1/user-service/my/profile`, { method: 'GET', headers: auth });
        const body = res && res.status < 400 ? parseJson(res.text) : {};
        const found = [body.account, body.email, body.name].find(v => typeof v === 'string' && v);
        email = typeof found === 'string' ? found : '';
    }
    return {
        region,
        email,
        username,
        token,
        expiresAt: opts.expiresAt && opts.expiresAt > Date.now() ? opts.expiresAt : Date.now() + DEFAULT_TOKEN_LIFETIME_S * 1000,
    };
}

async function safeRequest(http: HttpClient, url: string, init: Parameters<HttpClient['request']>[1]): Promise<HttpResponse | null> {
    try { return await http.request(url, init); } catch { return null; }
}

/** Printers bound to the account. */
export async function listCloudPrinters(http: HttpClient, session: Pick<CloudSession, 'region' | 'token'>): Promise<CloudPrinter[]> {
    const res = await http.request(`${apiBase(session.region)}/v1/iot-service/api/user/bind`, {
        method: 'GET', headers: { ...CLIENT_HEADERS, Authorization: `Bearer ${session.token}` },
    });
    const body = parseJson(res.text);
    if (res.status === 401 || res.status === 403) {
        throw new CloudAuthError('Your Bambu Lab sign-in has expired. Sign in again.', 'credentials');
    }
    if (res.status >= 400 || !Array.isArray(body.devices)) { throw errorFrom(res, body, 'unexpected'); }
    return (body.devices as Record<string, unknown>[])
        .filter(d => typeof d.dev_id === 'string' && d.dev_id)
        .map(d => ({
            serial: String(d.dev_id),
            name: typeof d.name === 'string' && d.name ? d.name : String(d.dev_id),
            model: typeof d.dev_product_name === 'string' && d.dev_product_name ? d.dev_product_name
                : typeof d.dev_model_name === 'string' ? d.dev_model_name : null,
            online: d.online === true,
        }));
}

/** Newer tokens are JWTs whose payload carries {"username": "u_<uid>"}; older ones are opaque. */
export function usernameFromToken(token: string): string | null {
    const parts = token.split('.');
    if (parts.length !== 3) { return null; }
    try {
        const json = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        return typeof json.username === 'string' && /^u_\d+$/.test(json.username) ? json.username : null;
    } catch {
        return null;
    }
}

function parseJson(text: string): Record<string, unknown> {
    try {
        const v = JSON.parse(text);
        return v && typeof v === 'object' ? v : {};
    } catch {
        return {};
    }
}

function num(v: unknown): number | null {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
}

function errorFrom(res: HttpResponse, body: Record<string, unknown>, kind: CloudAuthError['kind']): CloudAuthError {
    const detail = [body.message, body.error].find(v => typeof v === 'string' && v && v !== 'success') as string | undefined;
    if (kind === 'credentials' && (res.status === 400 || res.status === 401)) {
        return new CloudAuthError(detail ? `Sign-in failed: ${detail}` : 'Wrong email or password.', 'credentials');
    }
    return new CloudAuthError(`Bambu Lab returned an error (${res.status}${detail ? `: ${detail}` : ''}).`, kind);
}
