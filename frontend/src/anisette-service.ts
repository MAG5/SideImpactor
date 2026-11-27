import { Anisette, loadWasmModule } from '@lbr77/anisette-js';
import { initLibcurl } from './anisette-libcurl-init';
import { LibcurlHttpClient } from './anisette-libcurl-http';
import { ANISETTE_CLIENT_INFO_STORAGE_KEY, loadText } from './lib/storage';

export interface AnisetteData {
  machineID: string;
  oneTimePassword: string;
  localUserID: string;
  routingInfo: number;
  deviceUniqueIdentifier: string;
  deviceDescription: string;
  deviceSerialNumber: string;
  date: Date;
  locale: string;
  timeZone: string;
}

/**
 * Apple's GSA edge answers HTTP 503 to any `X-MMe-Client-Info` that carries the
 * legacy `<macOS;…>` OS label or the `com.apple.dt.Xcode` AuthKit identifier.
 * Keep the default on a currently accepted Mac identity, and let it be
 * overridden via localStorage so Apple's next change doesn't need a rebuild.
 */
export const DEFAULT_ANISETTE_CLIENT_INFO =
  '<Mac14,15> <Mac OS X;27.0.1;26A434> <com.apple.AuthKit/1 (com.apple.akd/1.0)>';

export function getAnisetteClientInfo(): string {
  const override = loadText(ANISETTE_CLIENT_INFO_STORAGE_KEY)?.trim();
  return override && override.length > 0 ? override : DEFAULT_ANISETTE_CLIENT_INFO;
}

let anisetteInstance: Anisette | null = null;

export async function initAnisette(): Promise<Anisette> {
  if (anisetteInstance) {
    return anisetteInstance;
  }

  await initLibcurl();
  const httpClient = new LibcurlHttpClient();

  const wasmModule = await loadWasmModule();
  const assetBase = import.meta.env.BASE_URL;
  const [storeservicescore, coreadi] = await Promise.all([
    fetch(`${assetBase}anisette/libstoreservicescore.so`)
      .then((response) => response.arrayBuffer())
      .then((arr) => new Uint8Array(arr)),
    fetch(`${assetBase}anisette/libCoreADI.so`)
      .then((response) => response.arrayBuffer())
      .then((arr) => new Uint8Array(arr)),
  ]);

  anisetteInstance = await Anisette.fromSo(storeservicescore, coreadi, wasmModule, {
    httpClient,
    init: {
      libraryPath: './anisette/',
      deviceConfig: {
        serverFriendlyDescription: getAnisetteClientInfo(),
      },
    },
  });

  return anisetteInstance;
}

export async function provisionAnisette(): Promise<void> {
  const anisette = await initAnisette();
  if (!anisette.isProvisioned) {
    await anisette.provision();
  }
}

export async function getAnisetteData(): Promise<AnisetteData> {
  const anisette = await initAnisette();

  if (!anisette.isProvisioned) {
    await anisette.provision();
  }

  const headers = await anisette.getData();

  return {
    machineID: headers['X-Apple-I-MD-M'],
    oneTimePassword: headers['X-Apple-I-MD'],
    localUserID: headers['X-Apple-I-MD-LU'],
    routingInfo: Number.parseInt(headers['X-Apple-I-MD-RINFO'], 10),
    deviceUniqueIdentifier: headers['X-Mme-Device-Id'],
    deviceDescription: headers['X-MMe-Client-Info'],
    deviceSerialNumber: headers['X-Apple-I-SRL-NO'] || '0',
    date: new Date(headers['X-Apple-I-Client-Time']),
    locale: headers['X-Apple-Locale'],
    timeZone: headers['X-Apple-I-TimeZone'],
  };
}

export function clearAnisetteCache(): void {
  anisetteInstance = null;
}
