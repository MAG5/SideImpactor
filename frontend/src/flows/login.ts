import type { AnisetteData } from '../anisette-service';
import type { AppleDeveloperContext, TwoFactorContext } from '../apple-signing';
import { shortToken } from '../lib/ids';

type AnisetteService = typeof import('../anisette-service');
type AppleSigningModule = typeof import('../apple-signing');

let anisetteServicePromise: Promise<AnisetteService> | null = null;
let appleSigningModulePromise: Promise<AppleSigningModule> | null = null;

export async function loadAnisetteService(): Promise<AnisetteService> {
  if (!anisetteServicePromise) {
    anisetteServicePromise = import('../anisette-service');
  }
  return await anisetteServicePromise;
}

export async function loadAppleSigningModule(): Promise<AppleSigningModule> {
  if (!appleSigningModulePromise) {
    appleSigningModulePromise = import('../apple-signing');
  }
  return await appleSigningModulePromise;
}

export interface EnsureAnisetteResult {
  anisetteData: AnisetteData;
  provisioned: boolean;
}

export async function ensureAnisetteData(
  log: (msg: string) => void,
): Promise<EnsureAnisetteResult> {
  const anisetteService = await loadAnisetteService();
  log('login: fetching anisette headers...');
  // OTPs are single-use, so always take a fresh set instead of reusing a
  // stored one (reuse makes Apple reject the request with -22421).
  const anisetteData = await anisetteService.getAnisetteData();
  log(`login: anisette ready (${shortToken(anisetteData.machineID)})`);
  return { anisetteData, provisioned: true };
}

export async function checkAnisetteProvisioned(): Promise<boolean> {
  return true;
}

export interface LoginRequest {
  appleId: string;
  password: string;
  anisetteData: AnisetteData;
  log: (msg: string) => void;
  onTwoFactorRequired: (ctx: TwoFactorContext) => void;
}

export async function loginAccount(req: LoginRequest): Promise<AppleDeveloperContext> {
  const appleSigning = await loadAppleSigningModule();
  req.log('login: authenticating Apple account...');
  const context = await appleSigning.loginAppleDeveloperAccount({
    anisetteData: req.anisetteData,
    credentials: { appleId: req.appleId, password: req.password },
    onLog: req.log,
    onTwoFactorRequired: req.onTwoFactorRequired,
  });
  return await appleSigning.refreshAppleDeveloperContext(context, req.log);
}
