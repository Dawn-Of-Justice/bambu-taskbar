import { session, Session } from 'electron';
import type { HttpClient, HttpResponse } from './cloud_auth';

/**
 * HTTP client for the Bambu Lab API built on Electron's own network stack (Chromium), in a private in-memory
 * session. Using Chromium rather than Node's HTTP client matters: Bambu's API sits behind Cloudflare, which is
 * much more likely to accept a request that looks like it comes from a normal browser.
 */
export class ElectronHttpClient implements HttpClient {
    private readonly ses: Session = session.fromPartition('bambu-cloud-auth', { cache: false });

    constructor() {
        // Look like plain Chrome: drop the "Electron/x" and app tokens from the user agent.
        this.ses.setUserAgent(this.ses.getUserAgent().replace(/ Electron\/\S+/, '').replace(/ bambu-taskbar\/\S+/, ''));
    }

    /** Forget cookies from an earlier sign-in attempt. */
    async reset(): Promise<void> {
        await this.ses.clearStorageData({ storages: ['cookies'] });
    }

    async request(url: string, init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown }): Promise<HttpResponse> {
        const res = await this.ses.fetch(url, {
            method: init.method,
            headers: init.headers,
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
            credentials: 'include',
            redirect: 'follow',
        });
        const text = await res.text();
        const cookies: Record<string, string> = {};
        for (const c of await this.ses.cookies.get({ url })) { cookies[c.name] = c.value; }
        return { status: res.status, text, cookies };
    }
}
