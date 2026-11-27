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
 * GSA validates this identity in two stages (Apple's 2026-11 changes):
 * - its edge answers HTTP 503 to any `X-MMe-Client-Info` containing `macOS;`,
 *   so the OS segment must read `Mac OS X;` (a 190-byte HTML page, no login).
 * - the SRP stage answers -22410 unless the OS version/build pair matches the
 *   anisette machine, which is why this is the 26.6 / 25F84 pair rather than
 *   the older 10.12.6 / 16G29 one.
 * This exact string is verified end-to-end against mac-ani/new.ani headers.
 */
export const DEFAULT_ANISETTE_CLIENT_INFO =
  '<MacBookPro13,3> <Mac OS X;26.6;25F84> <com.apple.AuthKit/1 (com.apple.akd/1.0)>';

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

  const data = toAnisetteData(payload as AnisetteHeaders);
  // The MID must stay constant across a login; a rotating one makes Apple
  // treat the post-2FA retry as a new device and re-prompt for a code.
  console.info(
    '[anisette] upstream=%s MID=%s MD=%s...',
    response.headers.get('x-anisette-upstream') ?? '(none)',
    data.machineID,
    data.oneTimePassword.slice(0, 8),
  );
  return data;
}
