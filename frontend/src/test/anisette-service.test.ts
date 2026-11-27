import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ANISETTE_CLIENT_INFO,
  DEFAULT_ANISETTE_USER_AGENT,
  getAnisetteClientInfo,
  getAnisetteData,
  getAnisetteEndpoint,
  toAnisetteData,
} from '../anisette-service';
import { ANISETTE_CLIENT_INFO_STORAGE_KEY, ANISETTE_URL_STORAGE_KEY } from '../lib/storage';

const REMOTE_HEADERS: Record<string, string> = {
  'X-Apple-I-MD-M': 'MACHINE-123',
  'X-Apple-I-MD': '123456',
  'X-Apple-I-MD-LU': 'USER-XYZ',
  'X-Apple-I-MD-RINFO': '17106115362251952706',
  'X-Mme-Device-Id': 'DEVICE-UDID',
  'X-Apple-I-SRL-NO': 'SERIAL01',
  'X-Apple-I-Client-Time': '2026-11-27T00:00:00Z',
  'X-Apple-Locale': 'en_US',
  'X-Apple-I-TimeZone': '+0800',
  'X-MMe-Client-Info': '<MacBookPro13,3> <Mac OS X;10.12.6;16G29> <com.apple.AuthKit/1 (com.apple.akd/1.0)>',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fetchMock(): ReturnType<typeof vi.fn> {
  return globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('getAnisetteClientInfo', () => {
  it('claims the modern macOS identity AuthKit sends so GSA acceptance matches', () => {
    expect(DEFAULT_ANISETTE_CLIENT_INFO).toBe(
      '<MacBookPro18,3> <macOS;26.6;25F84> <com.apple.AuthKit/1 (com.apple.akd/1.0)>',
    );
    expect(DEFAULT_ANISETTE_USER_AGENT).toBe(
      'AuthKit/1 (Macintosh; OS X 26.6) (com.apple.dt.Xcode/26.0)',
    );
    expect(getAnisetteClientInfo()).toBe(DEFAULT_ANISETTE_CLIENT_INFO);
  });

  it('honours the localStorage override and ignores a blank one', () => {
    window.localStorage.setItem(ANISETTE_CLIENT_INFO_STORAGE_KEY, '<MacBookPro18,3> <macOS;15.2;24C101>');
    expect(getAnisetteClientInfo()).toBe('<MacBookPro18,3> <macOS;15.2;24C101>');

    window.localStorage.setItem(ANISETTE_CLIENT_INFO_STORAGE_KEY, '   ');
    expect(getAnisetteClientInfo()).toBe(DEFAULT_ANISETTE_CLIENT_INFO);
  });
});

describe('getAnisetteEndpoint', () => {
  it('derives the same-origin /anisette route by default', () => {
    expect(getAnisetteEndpoint()).toBe(`${location.origin}/anisette`);
  });

  it('derives https from the configured WISP URL', () => {
    vi.stubEnv('VITE_WISP_URL', 'wss://sideload.shin.workers.dev/wisp/');
    expect(getAnisetteEndpoint()).toBe('https://sideload.shin.workers.dev/anisette');
  });

  it('uses VITE_ANISETTE_URL when provided', () => {
    vi.stubEnv('VITE_ANISETTE_URL', 'https://example.dev/anisette');
    expect(getAnisetteEndpoint()).toBe('https://example.dev/anisette');
  });

  it('lets localStorage point at a different anisette service', () => {
    window.localStorage.setItem(ANISETTE_URL_STORAGE_KEY, ' https://ani.example.dev/ ');
    expect(getAnisetteEndpoint()).toBe('https://ani.example.dev/');

    window.localStorage.setItem(ANISETTE_URL_STORAGE_KEY, ' ');
    expect(getAnisetteEndpoint()).toBe(`${location.origin}/anisette`);
  });
});

describe('toAnisetteData', () => {
  it('maps the Apple header names exposed by anisette servers', () => {
    const data = toAnisetteData(REMOTE_HEADERS);

    expect(data.machineID).toBe('MACHINE-123');
    expect(data.oneTimePassword).toBe('123456');
    expect(data.localUserID).toBe('USER-XYZ');
    expect(data.routingInfo).toBe(17106115362251952706);
    expect(data.deviceUniqueIdentifier).toBe('DEVICE-UDID');
    expect(data.deviceSerialNumber).toBe('SERIAL01');
    expect(data.date.toISOString()).toBe('2026-11-27T00:00:00.000Z');
    expect(data.locale).toBe('en_US');
    expect(data.timeZone).toBe('+0800');
  });

  it('always uses the local client info, not the upstream identity', () => {
    const data = toAnisetteData(REMOTE_HEADERS);
    expect(data.deviceDescription).toBe(DEFAULT_ANISETTE_CLIENT_INFO);
    expect(data.deviceDescription).not.toContain('MacBookPro13,3');
  });

  it('creates a single coherent identity across the header set', () => {
    const data = toAnisetteData(REMOTE_HEADERS);
    // GSA correlates the OS label with the GsService2 user agent; the pair must
    // not mix an older client-info with a newer UA or vice versa.
    expect(data.deviceDescription).toContain('macOS;26.6');
    expect(DEFAULT_ANISETTE_USER_AGENT).toContain('OS X 26.6');
  });

  it('falls back for optional headers', () => {
    const data = toAnisetteData(REMOTE_HEADERS, 'custom');
    expect(data.deviceDescription).toBe('custom');
    const minimal = {
      'X-Apple-I-MD-M': 'm',
      'X-Apple-I-MD': 'o',
      'X-Apple-I-MD-LU': 'u',
      'X-Apple-I-MD-RINFO': '42',
      'X-Mme-Device-Id': 'd',
      'X-Apple-I-Client-Time': '2026-11-27T00:00:00Z',
    };
    const fallback = toAnisetteData(minimal);
    expect(fallback.deviceSerialNumber).toBe('0');
    expect(fallback.locale).toBe('en_US');
    expect(fallback.timeZone).toBe('+0000');
  });

  it('rejects a missing required header by name', () => {
    const broken: Record<string, string> = { ...REMOTE_HEADERS };
    delete broken['X-Apple-I-MD'];
    expect(() => toAnisetteData(broken)).toThrow(/missing X-Apple-I-MD$/);
  });

  it('rejects an invalid client time', () => {
    expect(() =>
      toAnisetteData({ ...REMOTE_HEADERS, 'X-Apple-I-Client-Time': 'not-a-date' }),
    ).toThrow(/invalid X-Apple-I-Client-Time/);
  });
});

describe('getAnisetteData', () => {
  it('fetches a fresh header set every time', async () => {
    fetchMock().mockImplementation(async () => jsonResponse(REMOTE_HEADERS));

    const first = await getAnisetteData();
    const second = await getAnisetteData();

    expect(first.oneTimePassword).toBe('123456');
    expect(second.oneTimePassword).toBe('123456');
    expect(fetchMock()).toHaveBeenCalledTimes(2);
    expect(fetchMock()).toHaveBeenCalledWith(`${location.origin}/anisette`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
  });

  it('reports HTTP failures with the endpoint', async () => {
    fetchMock().mockResolvedValue(jsonResponse({ error: 'boom' }, 502));
    await expect(getAnisetteData()).rejects.toThrow(/Anisette service failed: HTTP 502/);
  });

  it('reports unreachable services with a relay hint', async () => {
    fetchMock().mockRejectedValue(new Error('Failed to fetch'));
    await expect(getAnisetteData()).rejects.toThrow(/unreachable/);
    await expect(getAnisetteData()).rejects.toThrow(/relay serves \/anisette/);
  });

  it('reports invalid JSON', async () => {
    fetchMock().mockResolvedValue(new Response('<html>', { status: 200 }));
    await expect(getAnisetteData()).rejects.toThrow(/invalid JSON/);
  });

  it('reports non-object payloads', async () => {
    fetchMock().mockResolvedValue(jsonResponse([1, 2, 3]));
    await expect(getAnisetteData()).rejects.toThrow(/unexpected payload/);
  });
});
