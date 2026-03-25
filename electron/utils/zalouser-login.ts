/**
 * Zalo Personal (zalouser) Login Manager
 * Handles QR-based login for Zalo Personal accounts using zca-js.
 * Mirrors the startZaloQrLogin pattern from OpenClaw's extensions/zalouser/src/zalo-js.ts.
 */
import { join } from 'path';
import { EventEmitter } from 'events';
import { getOpenClawConfigDir } from './paths';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const zcaJsRuntime = require('zca-js') as { Zalo: unknown };

// Use undici's fetch instead of Electron's patched globalThis.fetch.
// Electron intercepts fetch with redirect:"manual" and returns an opaque response
// (status=0, no headers), so zca-js's checkSession can't follow the redirect to
// chat.zalo.me and getUserInfo returns logged:false → "Can't login".
// undici's fetch returns the real 302 response with the location header intact.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const undiciRuntime = require('undici') as { fetch: typeof globalThis.fetch };
const undiciFetch = undiciRuntime.fetch;

type LoginQRCallbackEvent =
    | { type: 0; data: { code: string; image: string }; actions: { saveToFile: (p?: string) => Promise<unknown>; retry: () => unknown; abort: () => unknown } }
    | { type: 1; data: null; actions: { retry: () => unknown; abort: () => unknown } }
    | { type: 2; data: { avatar: string; display_name: string }; actions: { retry: () => unknown; abort: () => unknown } }
    | { type: 3; data: { code: string }; actions: { retry: () => unknown; abort: () => unknown } }
    | { type: 4; data: { cookie: unknown; imei: string; userAgent: string }; actions: null };

const LoginQRCallbackEventType = {
    QRCodeGenerated: 0,
    QRCodeExpired: 1,
    QRCodeScanned: 2,
    QRCodeDeclined: 3,
    GotLoginInfo: 4,
} as const;

interface ZaloCtor {
    new(options?: { logging?: boolean; selfListen?: boolean; polyfill?: typeof globalThis.fetch }): {
        loginQR(
            options?: { userAgent?: string; language?: string; qrPath?: string },
            callback?: (event: LoginQRCallbackEvent) => unknown,
        ): Promise<ZcaApi>;
    };
}

interface ZcaApi {
    getContext(): { imei: string; userAgent: string; language?: string };
    getCookie(): { toJSON(): { cookies: unknown[] } };
}

const Zalo = zcaJsRuntime.Zalo as unknown as ZaloCtor;

interface StoredCredentials {
    imei: string;
    cookie: unknown;
    userAgent: string;
    language?: string;
    createdAt: string;
    lastUsedAt?: string;
}

interface ActiveQrLogin {
    id: string;
    profile: string;
    startedAt: number;
    connected: boolean;
    waitPromise: Promise<void>;
    qrDataUrl?: string;
    error?: string;
    abort?: () => void;
}

function credentialsFilename(profile: string): string {
    const trimmed = profile.trim().toLowerCase();
    if (!trimmed || trimmed === 'default') {
        return 'credentials.json';
    }
    return `credentials-${encodeURIComponent(trimmed)}.json`;
}

function resolveCredentialsDir(): string {
    return join(getOpenClawConfigDir(), 'credentials', 'zalouser');
}

function resolveCredentialsPath(profile: string): string {
    return join(resolveCredentialsDir(), credentialsFilename(profile));
}

function readCredentials(profile: string): StoredCredentials | null {
    const filePath = resolveCredentialsPath(profile);
    try {
        if (!existsSync(filePath)) {
            console.log('[ZaloUserLogin] readCredentials: file not found:', filePath);
            return null;
        }
        const raw = readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
        if (typeof parsed.imei !== 'string' || !parsed.imei) {
            console.warn('[ZaloUserLogin] readCredentials: invalid imei');
            return null;
        }
        if (!parsed.cookie) {
            console.warn('[ZaloUserLogin] readCredentials: missing cookie');
            return null;
        }
        if (typeof parsed.userAgent !== 'string' || !parsed.userAgent) {
            console.warn('[ZaloUserLogin] readCredentials: invalid userAgent');
            return null;
        }
        console.log('[ZaloUserLogin] readCredentials: ok | cookie type:', Array.isArray(parsed.cookie) ? `array[${(parsed.cookie as unknown[]).length}]` : typeof parsed.cookie);
        return {
            imei: parsed.imei,
            cookie: parsed.cookie,
            userAgent: parsed.userAgent,
            language: typeof parsed.language === 'string' ? parsed.language : undefined,
            createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
            lastUsedAt: typeof parsed.lastUsedAt === 'string' ? parsed.lastUsedAt : undefined,
        };
    } catch (err) {
        console.error('[ZaloUserLogin] readCredentials: parse error:', err);
        return null;
    }
}

function writeCredentials(
    profile: string,
    credentials: Omit<StoredCredentials, 'createdAt' | 'lastUsedAt'>,
): void {
    const dir = resolveCredentialsDir();
    mkdirSync(dir, { recursive: true });
    const existing = readCredentials(profile);
    const now = new Date().toISOString();
    const next: StoredCredentials = {
        ...credentials,
        createdAt: existing?.createdAt ?? now,
        lastUsedAt: now,
    };
    const filePath = resolveCredentialsPath(profile);
    console.log('[ZaloUserLogin] writeCredentials:', filePath,
        '| cookie:', Array.isArray(next.cookie) ? `array[${(next.cookie as unknown[]).length}]` : typeof next.cookie,
    );
    writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf-8');
    console.log('[ZaloUserLogin] writeCredentials: done');
}

export class ZaloUserLoginManager extends EventEmitter {
    private readonly loginState = new Map<string, ActiveQrLogin>();

    constructor() {
        super();
    }

    async startZaloQrLogin(accountId: string = 'default'): Promise<void> {
        const profile = accountId;
        const existing = this.loginState.get(profile);

        // Reuse if a QR is already being shown
        if (existing && !existing.connected && !existing.error) {
            if (existing.qrDataUrl) {
                this.emit('qr', { qr: existing.qrDataUrl });
            }
            return;
        }

        // Clear any stale state
        if (existing) {
            this.loginState.delete(profile);
        }

        const loginId = Date.now().toString(36) + Math.random().toString(36).slice(2);
        const login: ActiveQrLogin = {
            id: loginId,
            profile,
            startedAt: Date.now(),
            connected: false,
            waitPromise: Promise.resolve(),
        };

        login.waitPromise = (async () => {
            let capturedCredentials: { imei: string; cookie: unknown; userAgent: string; language?: string } | null = null;
            try {
                console.log('[ZaloUserLogin] Starting loginQR for profile:', profile, '| undici fetch:', typeof undiciFetch);
                const zalo = new Zalo({ logging: false, selfListen: false, polyfill: undiciFetch });
                const api = await zalo.loginQR(undefined, (event: LoginQRCallbackEvent) => {
                    const current = this.loginState.get(profile);
                    if (!current || current.id !== loginId) return;

                    if (event.actions?.abort) {
                        current.abort = () => {
                            try { event.actions?.abort?.(); } catch { /* ignore */ }
                        };
                    }

                    switch (event.type) {
                        case LoginQRCallbackEventType.QRCodeGenerated: {
                            console.log('[ZaloUserLogin] QR generated for profile:', profile);
                            const raw = event.data.image;
                            const qrDataUrl = raw.startsWith('data:image') ? raw : `data:image/png;base64,${raw}`;
                            current.qrDataUrl = qrDataUrl;
                            this.emit('qr', { qr: qrDataUrl });
                            break;
                        }
                        case LoginQRCallbackEventType.QRCodeExpired: {
                            console.log('[ZaloUserLogin] QR expired, retrying...');
                            try {
                                event.actions.retry();
                            } catch {
                                current.error = 'QR expired before confirmation. Start login again.';
                                this.emit('error', current.error);
                            }
                            break;
                        }
                        case LoginQRCallbackEventType.QRCodeScanned: {
                            console.log('[ZaloUserLogin] QR scanned');
                            this.emit('scanned', {
                                displayName: event.data?.display_name,
                                avatar: event.data?.avatar,
                            });
                            break;
                        }
                        case LoginQRCallbackEventType.QRCodeDeclined: {
                            console.log('[ZaloUserLogin] QR declined by user');
                            current.error = 'QR login was declined on the phone.';
                            this.emit('error', current.error);
                            break;
                        }
                        case LoginQRCallbackEventType.GotLoginInfo: {
                            console.log('[ZaloUserLogin] GotLoginInfo fired | hascookie:', !!event.data?.cookie);
                            capturedCredentials = {
                                imei: event.data.imei,
                                cookie: event.data.cookie,
                                userAgent: event.data.userAgent,
                            };
                            break;
                        }
                        default:
                            console.log('[ZaloUserLogin] Unknown event type:', (event as unknown as { type: number }).type);
                            break;
                    }
                });

                const current = this.loginState.get(profile);
                if (!current || current.id !== loginId) return;

                console.log('[ZaloUserLogin] loginQR resolved | capturedCredentials:', capturedCredentials ? 'yes' : 'no (using fallback)');

                // Fallback: extract credentials from the API object if GotLoginInfo never fired
                if (!capturedCredentials) {
                    const ctx = api.getContext();
                    const cookieJar = api.getCookie();
                    const cookieJson = cookieJar.toJSON();
                    console.log('[ZaloUserLogin] Fallback ctx | cookies count:', cookieJson?.cookies?.length);
                    capturedCredentials = {
                        imei: ctx.imei,
                        cookie: cookieJson?.cookies ?? [],
                        userAgent: ctx.userAgent,
                        language: ctx.language,
                    };
                }

                const credPath = resolveCredentialsPath(profile);
                console.log('[ZaloUserLogin] Writing credentials to:', credPath);
                writeCredentials(profile, capturedCredentials);
                console.log('[ZaloUserLogin] Credentials written successfully');
                current.connected = true;
                this.emit('success', { accountId: profile });
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                console.error('[ZaloUserLogin] loginQR threw error:', msg);
                const current = this.loginState.get(profile);
                if (current && current.id === loginId) {
                    current.error = msg;
                    this.emit('error', msg);
                }
            }
        })();

        this.loginState.set(profile, login);

        // Wait briefly for QR to be generated before returning
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            const active = this.loginState.get(profile);
            if (!active || active.id !== loginId) return;
            if (active.error) return;
            if (active.qrDataUrl) return;
            await new Promise(r => setTimeout(r, 150));
        }
    }

    async logoutZaloProfile(accountId: string = 'default'): Promise<void> {
        const profile = accountId;
        const login = this.loginState.get(profile);
        if (login) {
            if (login.abort && !login.connected) {
                try { login.abort(); } catch { /* ignore */ }
            }
            this.loginState.delete(profile);
        }
    }
}

export const zaloUserLoginManager = new ZaloUserLoginManager();
