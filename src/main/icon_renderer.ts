import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { app, BrowserWindow, NativeImage, nativeImage } from 'electron';
import { buildIco } from './ico';
import type { IconStyle, PrintState } from '../shared/types';

export interface IconSpec {
    style: IconStyle;
    /** 'offline' covers unconfigured / unreachable printers. */
    state: PrintState | 'offline';
    /** 0-100 while a print is running, otherwise null. */
    percent: number | null;
    /** true when the Windows taskbar uses the light theme (draw dark glyphs). */
    lightTaskbar: boolean;
}

/** Tray icon sizes per display scale factor (100% .. 200%). */
const TRAY_SIZES: [scaleFactor: number, size: number][] = [[1, 16], [1.25, 20], [1.5, 24], [1.75, 28], [2, 32]];
/** Sizes written into the Windows .ico: every tray size from 100% to 300% scaling. */
const ICO_SIZES = [16, 20, 24, 28, 32, 36, 40, 48];

/**
 * Renders tray icons at runtime with a hidden, sandboxed window's <canvas>: crisp per-DPI icons in the system font
 * for any percentage and print state, matched to the taskbar theme.
 */
export class IconRenderer {
    private window: BrowserWindow | null = null;
    private ready: Promise<void> | null = null;
    private readonly cache = new Map<string, NativeImage | string>();
    private readonly icoDir = path.join(app.getPath('userData'), 'tray-icons');

    init(): Promise<void> {
        if (!this.ready) {
            this.window = new BrowserWindow({
                show: false,
                width: 64,
                height: 64,
                skipTaskbar: true,
                webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
            });
            this.ready = this.window.loadURL('about:blank');
        }
        return this.ready;
    }

    dispose(): void {
        this.window?.destroy();
        this.window = null;
        this.ready = null;
    }

    /**
     * Tray image for the current platform. On Windows this is the path of a multi-size .ico file, so the shell
     * picks the exact pixel size for the display scaling (a NativeImage would be stretched from 16 px and blur).
     */
    async renderTrayImage(spec: IconSpec): Promise<NativeImage | string> {
        const key = JSON.stringify(normalize(spec));
        const cached = this.cache.get(key);
        if (cached) { return cached; }

        let result: NativeImage | string;
        if (process.platform === 'win32') {
            result = await this.renderIcoFile(spec, key);
        } else {
            const urls = await this.drawDataUrls(spec, TRAY_SIZES.map(([, size]) => size));
            const image = nativeImage.createEmpty();
            TRAY_SIZES.forEach(([scaleFactor], i) => image.addRepresentation({ scaleFactor, dataURL: urls[i] }));
            result = image;
        }

        if (this.cache.size > 256) { this.cache.clear(); }
        this.cache.set(key, result);
        return result;
    }

    private async renderIcoFile(spec: IconSpec, key: string): Promise<string> {
        const file = path.join(this.icoDir, `${crypto.createHash('md5').update(key).digest('hex')}.ico`);
        if (!fs.existsSync(file)) {
            await this.init();
            const script = `(${drawIcons.toString()})(${JSON.stringify(normalize(spec))}, ${JSON.stringify(ICO_SIZES)}, true)`;
            const raw: string[] = await this.window.webContents.executeJavaScript(script, true);
            const ico = buildIco(ICO_SIZES.map((size, i) => ({ size, rgba: Buffer.from(raw[i], 'base64') })));
            await fs.promises.mkdir(this.icoDir, { recursive: true });
            await fs.promises.writeFile(file, ico);
        }
        return file;
    }

    /** Remove cached .ico files from earlier runs (they are cheap to regenerate). */
    clearIconCache(): void {
        try { fs.rmSync(this.icoDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    /** Single size data URL, used for previews in the settings window. */
    async renderDataUrl(spec: IconSpec, size: number): Promise<string> {
        const [url] = await this.drawDataUrls(spec, [Math.max(8, Math.min(256, Math.round(size)))]);
        return url;
    }

    private async drawDataUrls(spec: IconSpec, sizes: number[]): Promise<string[]> {
        await this.init();
        const script = `(${drawIcons.toString()})(${JSON.stringify(normalize(spec))}, ${JSON.stringify(sizes)})`;
        return await this.window.webContents.executeJavaScript(script, true);
    }
}

function normalize(spec: IconSpec): IconSpec {
    const state = spec.state === 'unknown' ? 'offline' : spec.state;
    const showsPercent = state === 'printing' || state === 'paused' || state === 'preparing';
    return {
        style: spec.style === 'ring' ? 'ring' : 'percent',
        state,
        percent: showsPercent && spec.percent !== null ? Math.max(0, Math.min(100, Math.round(spec.percent))) : null,
        lightTaskbar: !!spec.lightTaskbar,
    };
}

/**
 * Runs inside the hidden renderer. Must be fully self-contained (no references to outer scope).
 * Straight lines are drawn with whole-pixel fillRect calls (no anti-aliasing) so they match the shell's tray icons;
 * only the ring, tick and cross use anti-aliased paths.
 */
function drawIcons(spec: IconSpec, sizes: number[], rawRgba = false): string[] {
    const light = spec.lightTaskbar;
    const fg = light ? '#1b1b1b' : '#ffffff';
    const red = light ? '#c42b1c' : '#ff5b5b';
    const green = light ? '#0f7b0f' : '#6ccb5f';
    const amber = light ? '#9d5d00' : '#fce100';
    const font = '"Segoe UI Variable Display", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
    const accent = spec.state === 'paused' ? amber : fg;
    /** Bambu-style green for the freshly printed line under the nozzle. */
    const printedLine = light ? '#00994a' : '#2fd16f';

    /** Enclosed printer seen from the front: frame, gantry, toolhead, bed. */
    function drawPrinter(ctx: CanvasRenderingContext2D, S: number) {
        const lw = S >= 28 ? 2 : 1;
        const px = (x: number, y: number, w: number, h: number) => ctx.fillRect(x, y, w, h);
        const inset = Math.max(1, Math.round(S / 16));
        const l = inset;
        const t = inset;
        const w = S - 2 * inset;
        const h = S - 2 * inset;
        ctx.fillStyle = fg;
        ctx.globalAlpha = spec.state === 'offline' ? 0.45 : 1;
        // frame with softened corners
        px(l + lw, t, w - 2 * lw, lw);
        px(l + lw, t + h - lw, w - 2 * lw, lw);
        px(l, t + lw, lw, h - 2 * lw);
        px(l + w - lw, t + lw, lw, h - 2 * lw);
        // gantry
        const gy = t + Math.round(h * 0.3);
        px(l + lw, gy, w - 2 * lw, lw);
        // toolhead hanging from the gantry
        const thW = Math.max(3, Math.round(w * 0.3) | 1);
        const thH = Math.max(2, Math.round(h * 0.2));
        px(l + Math.floor((w - thW) / 2), gy + lw, thW, thH);
        // nozzle
        px(l + Math.floor(w / 2) - (lw === 2 ? 1 : 0), gy + lw + thH, lw, lw);
        // bed
        const by = t + h - lw - Math.max(2, Math.round(h * 0.2));
        px(l + lw + 1, by, w - 2 * lw - 2, lw);
        ctx.globalAlpha = 1;
    }

    /**
     * An extruder in the middle of the ring: filament going in at the top, heater block, a nozzle tapering to a
     * point, and the green line of plastic it is laying down. Whole pixels only, centred on the icon.
     */
    function drawNozzle(ctx: CanvasRenderingContext2D, S: number) {
        const u = S / 16;
        const even = (n: number) => Math.max(2, Math.round(n / 2) * 2); // even widths stay centred on even sizes
        const filW = even(1.5 * u);
        const filH = Math.max(1, Math.round(1.5 * u));
        const blockW = even(6 * u);
        const blockH = Math.max(2, Math.round(3 * u));
        const coneRows = Math.max(2, Math.round(2 * u));
        const gap = Math.max(1, Math.round(u));
        const beadW = even(5.5 * u); // narrow enough to stay inside the ring near its bottom
        const beadH = Math.max(1, Math.round(u));
        const total = filH + blockH + coneRows + gap + beadH;
        let y = Math.round((S - total) / 2);
        const c = S / 2;
        ctx.fillStyle = fg;
        ctx.fillRect(c - filW / 2, y, filW, filH);
        y += filH;
        ctx.fillRect(c - blockW / 2, y, blockW, blockH);
        y += blockH;
        const coneTop = blockW - 2;
        for (let i = 0; i < coneRows; i++) {
            const w = even(coneTop - (coneTop - 2) * (i / (coneRows - 1)));
            ctx.fillRect(c - w / 2, y + i, w, 1);
        }
        y += coneRows + gap;
        ctx.fillStyle = printedLine;
        ctx.fillRect(c - beadW / 2, y, beadW, beadH);
    }

    function drawRing(ctx: CanvasRenderingContext2D, S: number) {
        const lw = Math.max(2, Math.round(S / 9));
        const r = S / 2 - lw / 2 - Math.max(0.5, S / 32);
        const c = S / 2;
        ctx.lineWidth = lw;
        ctx.strokeStyle = fg;
        ctx.globalAlpha = 0.3;
        ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
        const pct = spec.percent ?? 0;
        if (pct > 0) {
            ctx.strokeStyle = accent;
            ctx.lineCap = pct >= 100 ? 'butt' : 'round';
            ctx.beginPath();
            ctx.arc(c, c, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.03, pct / 100));
            ctx.stroke();
        }
        if (spec.state === 'paused') {
            // two pause bars in the middle
            const bh = Math.max(3, Math.round(S * 0.3));
            const bw = Math.max(1, Math.round(S / 14));
            const gap = Math.max(1, Math.round(S / 14));
            ctx.fillStyle = amber;
            const y = Math.round((S - bh) / 2);
            const x = Math.round(S / 2 - gap / 2 - bw);
            ctx.fillRect(x, y, bw, bh);
            ctx.fillRect(x + bw + gap, y, bw, bh);
        } else {
            drawNozzle(ctx, S);
        }
    }

    function drawNumber(ctx: CanvasRenderingContext2D, S: number) {
        // While printing, 100 would be misleading (finishing moves etc.): cap at 99 until the printer says finished.
        const text = String(Math.min(99, spec.percent ?? 0));
        ctx.fillStyle = accent;
        const maxH = S * 0.75;
        const minScaleX = 0.85;
        let size = S;
        let m: TextMetrics;
        let inkW = 0;
        let inkH = 0;
        for (; size > 6; size -= 0.5) {
            ctx.font = `600 ${size}px ${font}`;
            m = ctx.measureText(text);
            inkW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
            inkH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
            if (inkH <= maxH && inkW * minScaleX <= S) { break; }
        }
        const scaleX = Math.min(1, S / inkW);
        const x = (S - inkW * scaleX) / 2 + m.actualBoundingBoxLeft * scaleX;
        const y = Math.round((S - inkH) / 2 + m.actualBoundingBoxAscent);
        ctx.save();
        ctx.translate(Math.round(x * 2) / 2, y);
        ctx.scale(scaleX, 1);
        ctx.fillText(text, 0, 0);
        ctx.restore();
    }

    function drawMark(ctx: CanvasRenderingContext2D, S: number, kind: 'tick' | 'cross') {
        const lw = Math.max(2, Math.round(S / 7));
        ctx.lineWidth = lw;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = kind === 'tick' ? green : red;
        const m = lw / 2 + Math.max(1, S / 10);
        ctx.beginPath();
        if (kind === 'tick') {
            ctx.moveTo(m, S * 0.52);
            ctx.lineTo(S * 0.4, S - m - S * 0.08);
            ctx.lineTo(S - m, m + S * 0.08);
        } else {
            ctx.moveTo(m, m); ctx.lineTo(S - m, S - m);
            ctx.moveTo(S - m, m); ctx.lineTo(m, S - m);
        }
        ctx.stroke();
    }

    const canvas = document.createElement('canvas');
    canvas.getContext('2d', { willReadFrequently: true });
    return sizes.map(S => {
        canvas.width = S;
        canvas.height = S;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, S, S);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        switch (spec.state) {
            case 'finished': drawMark(ctx, S, 'tick'); break;
            case 'failed': drawMark(ctx, S, 'cross'); break;
            case 'printing':
            case 'paused':
            case 'preparing':
                if (spec.style === 'ring') { drawRing(ctx, S); } else { drawNumber(ctx, S); }
                break;
            default: drawPrinter(ctx, S); // idle, offline
        }
        if (!rawRgba) { return canvas.toDataURL('image/png'); }
        // Straight (non-premultiplied) RGBA as base64, for building .ico files in the main process.
        const bytes = ctx.getImageData(0, 0, S, S).data;
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
        }
        return btoa(binary);
    });
}
