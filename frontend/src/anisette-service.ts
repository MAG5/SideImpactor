import { ANISETTE_CLIENT_INFO_STORAGE_KEY, ANISETTE_URL_STORAGE_KEY, loadText } from './lib/storage';
import { resolveAnisetteUrl } from './lib/relay';

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
 * legacy `<macOS;…>` OS label. Keep a currently accepted Mac identity, and let
 * it be overridden via localStorage so Apple's next change doesn't need a rebuild.
 */
export const DEFAULT_ANISETTE_CLIENT_INFO =
  '<Mac14,15> <Mac OS X;27.0.1;26A434> <com.apple.AuthKit/1 (com.apple.akd/1.0)>';

export function getAnisetteClientInfo(): string {
  const override = loadText(ANISETTE_CLIENT_INFO_STORAGE_KEY)?.trim();
  return override && override.length > 0 ? override : DEFAULT_ANISETTE_CLIENT_INFO;
}

/**
 * Apple no longer accepts new identities provisioned by the Android CoreADI
 * libraries that anisette-js runs in WASM (`finishMachineProvisioning` answers
 * HTTP 401 with ec=-29003 "possible environment mismatch"), and a failed start
 * leaves a pending ADI session that makes every retry fail with -45063. The
 * headers therefore come from a Mac-side anisette service through the relay.
 */
export function getAnisetteEndpoint(): string {
  const override = loadText(ANISETTE_URL_STORAGE_KEY)?.trim();
  return override && override.length > 0 ? override : resolveAnisetteUrl();
}

type AnisetteHeaders = Record<string, string>;

function requireHeader(headers: AnisetteHeaders, name: string): string {
  const value = headers[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Anisette service response is missing ${name}`);
  }
  return value;
}

export function toAnisetteData(headers: AnisetteHeaders, deviceDescription = getAnisetteClientInfo()): AnisetteData {
  const clientTime = requireHeader(headers, 'X-Apple-I-Client-Time');
  const date = new Date(clientTime);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Anisette service returned an invalid X-Apple-I-Client-Time: ${clientTime}`);
  }

  return {
    machineID: requireHeader(headers, 'X-Apple-I-MD-M'),
    oneTimePassword: requireHeader(headers, 'X-Apple-I-MD'),
    localUserID: requireHeader(headers, 'X-Apple-I-MD-LU'),
    routingInfo: Number.parseInt(requireHeader(headers, 'X-Apple-I-MD-RINFO'), 10),
    deviceUniqueIdentifier: requireHeader(headers, 'X-Mme-Device-Id'),
    deviceDescription,
    deviceSerialNumber: headers['X-Apple-I-SRL-NO'] || '0',
    date,
    locale: headers['X-Apple-Locale'] || 'en_US',
    timeZone: headers['X-Apple-I-TimeZone'] || '+0000',
  };
}

export async function getAnisetteData(): Promise<AnisetteData> {
  const endpoint = getAnisetteEndpoint();
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
  } catch (error) {
    throw new Error(
      `Anisette service unreachable at ${endpoint} (${
        error instanceof Error ? error.message : String(error)
      }). Check that the relay serves /anisette.`,
    );
  }

  if (!response.ok) {
    throw new Error(`Anisette service failed: HTTP ${response.status} from ${endpoint}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Anisette service returned invalid JSON from ${endpoint}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Anisette service returned an unexpected payload from ${endpoint}`);
  }

  return toAnisetteData(payload as AnisetteHeaders);
}
