/**
 * Apple's GSA edge rejects the legacy `<macOS;…>` OS label and the
 * `com.apple.dt.Xcode` AuthKit identifier in `X-MMe-Client-Info` with HTTP
 * 503, so the anisette device description must be overridable and must not
 * fall back to that combination.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANISETTE_CLIENT_INFO_STORAGE_KEY } from '../lib/storage';

interface FromSoOptions {
  init: {
    libraryPath: string;
    deviceConfig: { serverFriendlyDescription: string };
  };
}

const fromSo = vi.fn();
const fetchMock = vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }));

function makeHeaders(clientInfo: string) {
  return {
    'X-Apple-I-Client-Time': '2026-11-27T00:00:00Z',
    'X-Apple-I-MD': 'otp',
    'X-Apple-I-MD-LU': 'local-user',
    'X-Apple-I-MD-M': 'machine',
    'X-Apple-I-MD-RINFO': '17',
    'X-Apple-I-SRL-NO': '0',
    'X-Apple-I-TimeZone': '+0000',
    'X-Apple-Locale': 'en_US',
    'X-MMe-Client-Info': clientInfo,
    'X-Mme-Device-Id': 'device-id',
  };
}

async function loadService() {
  fromSo.mockImplementation(
    async (_storeservicescore: Uint8Array, _coreadi: Uint8Array, _wasm: unknown, options: FromSoOptions) => ({
      isProvisioned: true,
      provision: async () => {},
      getData: async () => makeHeaders(options.init.deviceConfig.serverFriendlyDescription),
    }),
  );
  vi.doMock('@lbr77/anisette-js', () => ({
    Anisette: { fromSo },
    loadWasmModule: async () => ({}),
  }));
  vi.doMock('../anisette-libcurl-init', () => ({ initLibcurl: async () => {} }));
  vi.doMock('../anisette-libcurl-http', () => ({ LibcurlHttpClient: class {} }));
  vi.stubGlobal('fetch', fetchMock);
  return await import('../anisette-service');
}

function capturedClientInfo(): string {
  const options = fromSo.mock.calls[0]?.[3] as FromSoOptions;
  return options.init.deviceConfig.serverFriendlyDescription;
}

beforeEach(() => {
  vi.resetModules();
  fromSo.mockReset();
  fetchMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('anisette client info', () => {
  it('passes a GSA-accepted default client info to anisette-js', async () => {
    const service = await loadService();
    await service.initAnisette();

    expect(fromSo).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${import.meta.env.BASE_URL}anisette/libstoreservicescore.so`);
    expect(fetchMock).toHaveBeenCalledWith(`${import.meta.env.BASE_URL}anisette/libCoreADI.so`);
    expect(capturedClientInfo()).toBe(service.DEFAULT_ANISETTE_CLIENT_INFO);
    expect(capturedClientInfo()).toContain('<Mac OS X;');
    expect(capturedClientInfo()).not.toContain('<macOS;');
    expect(capturedClientInfo()).not.toContain('com.apple.dt.Xcode');
  });

  it('honours a localStorage override', async () => {
    const custom = '<MacBookPro13,3> <Mac OS X;26.6;25F84> <com.apple.AuthKit/1 (com.apple.akd/1.0)>';
    window.localStorage.setItem(ANISETTE_CLIENT_INFO_STORAGE_KEY, `  ${custom}  `);

    const service = await loadService();
    await service.initAnisette();

    expect(capturedClientInfo()).toBe(custom);
    expect(service.getAnisetteClientInfo()).toBe(custom);
  });

  it('surfaces the client info through getAnisetteData', async () => {
    const service = await loadService();
    const data = await service.getAnisetteData();

    expect(data.deviceDescription).toBe(service.DEFAULT_ANISETTE_CLIENT_INFO);
  });
});