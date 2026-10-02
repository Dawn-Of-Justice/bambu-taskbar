import { BrowserWindow, Cookie, session, shell } from 'electron';
import type { CloudRegion } from '../../shared/types';
import { webBase } from './cloud_auth';

export interface WebSignInResult {
    token: string;
    /** Epoch ms when the token cookie expires, if the site said. */
    expiresAt: number | null;
}

const PARTITION = 'bambu-web-signin';

/** Hosts the sign-in window may show itself; anything else opens in the default browser. */
const SIGN_IN_HOSTS = [
    /(^|\.)bambulab\.(com|cn)$/,
    /(^|\.)google\.com$/,
    /(^|\.)gstatic\.com$/,
    /(^|\.)apple\.com$/,
    /(^|\.)facebook\.com$/,
];

export function signInUrl(region: CloudRegion): string {
    return region === 'china' ? `${webBase(region)}/sign-in` : `${webBase(region)}/en/sign-in`;
}

/** True for the cookie Bambu's website sets once the user is signed in. */
export function isTokenCookie(cookie: Pick<Cookie, 'name' | 'value' | 'domain'>, region: CloudRegion): boolean {
    const domain = (cookie.domain ?? '').replace(/^\./, '');
    const site = region === 'china' ? 'bambulab.cn' : 'bambulab.com';
    return cookie.name === 'token' && !!cookie.value && (domain === site || domain.endsWith(`.${site}`));
}

function allowedHost(url: string): boolean {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' && SIGN_IN_HOSTS.some(re => re.test(u.hostname));
    } catch {
        return false;
    }
}

/**
 * Shows Bambu Lab's own sign-in page in a window, so any sign-in method the website offers works (Google, Apple,
 * email + password, codes, 2FA). The app never sees the password; it only picks up the "token" cookie the
 * website sets when sign-in succeeds. Resolves null if the user closes the window.
 */
export async function signInWithBrowser(region: CloudRegion, parent: BrowserWindow | null): Promise<WebSignInResult | null> {
    const ses = session.fromPartition(PARTITION, { cache: false });
    // Start clean every time, and look like plain Chrome: Google refuses sign-in from browsers that call
    // themselves Electron.
    await ses.clearStorageData();
    ses.setUserAgent(ses.getUserAgent().replace(/ Electron\/\S+/, '').replace(/ bambu-taskbar\/\S+/, ''));

    const win = new BrowserWindow({
        width: 520,
        height: 760,
        parent: parent ?? undefined,
        title: 'Sign in to Bambu Lab',
        autoHideMenuBar: true,
        show: false,
        webPreferences: { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.removeMenu();

    // Google/Apple sign-in may open a popup; keep those inside the app (same session), send anything else
    // (help pages, privacy policy) to the default browser.
    const handleOpen = (contents: Electron.WebContents) => {
        contents.setWindowOpenHandler(({ url }) => {
            if (allowedHost(url)) {
                return {
                    action: 'allow',
                    overrideBrowserWindowOptions: {
                        parent: win, width: 500, height: 700, autoHideMenuBar: true,
                        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
                    },
                };
            }
            if (url.startsWith('https://')) { void shell.openExternal(url); }
            return { action: 'deny' };
        });
    };
    handleOpen(win.webContents);
    win.webContents.on('did-create-window', child => { child.removeMenu(); handleOpen(child.webContents); });

    return new Promise<WebSignInResult | null>(resolve => {
        let done = false;
        const finish = (result: WebSignInResult | null) => {
            if (done) { return; }
            done = true;
            ses.cookies.removeListener('changed', onCookie);
            if (!win.isDestroyed()) { win.close(); }
            resolve(result);
        };
        const fromCookie = (c: Cookie) => finish({
            token: c.value,
            expiresAt: typeof c.expirationDate === 'number' ? Math.round(c.expirationDate * 1000) : null,
        });
        const onCookie = (_e: Electron.Event, cookie: Cookie, _cause: string, removed: boolean) => {
            if (!removed && isTokenCookie(cookie, region)) { fromCookie(cookie); }
        };
        ses.cookies.on('changed', onCookie);
        // Belt and braces: also look after every page load, in case the cookie event was missed.
        win.webContents.on('did-navigate', async () => {
            const cookies = await ses.cookies.get({ name: 'token' }).catch((): Cookie[] => []);
            const c = cookies.find(x => isTokenCookie(x, region));
            if (c) { fromCookie(c); }
        });
        win.on('closed', () => finish(null));
        win.once('ready-to-show', () => win.show());
        void win.loadURL(signInUrl(region)).catch(() => {
            // Keep the window open so the user sees Chromium's error page and can close it.
            if (!win.isDestroyed()) { win.show(); }
        });
    });
}

/** Forget the website sign-in (called on sign-out). */
export async function clearBrowserSignIn(): Promise<void> {
    await session.fromPartition(PARTITION, { cache: false }).clearStorageData();
}
