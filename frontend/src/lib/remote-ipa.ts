import { IPA_PROXY_STORAGE_KEY, loadText } from './storage';

export type IpaSource =
  | { kind: 'url'; url: string; label: string }
  | { kind: 'github'; owner: string; repo: string; tag?: string; label: string };

export type GithubIpaSource = Extract<IpaSource, { kind: 'github' }>;

export interface RemoteIpaAsset {
  name: string;
  url: string;
  size: number;
  digest: string | null;
  releaseTag: string;
}

/** GitHub's release CDN sends no CORS headers; this mirror re-serves it with `Access-Control-Allow-Origin`. */
export const DEFAULT_GITHUB_PROXY = 'https://gh-proxy.com/';

const GITHUB_PROXY_HOSTS = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Accepts both legacy hashes (`#gh=owner/repo`, `#ipa=<url>`) and the route
 * form (`#/sign?gh=owner/repo`, `#/login?ipa=<url>`) used to keep the source
 * in the URL across page changes.
 */
export function parseIpaSource(hash: string): IpaSource | null {
  let raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw.startsWith('/')) {
    const queryStart = raw.indexOf('?');
    if (queryStart < 0) return null;
    raw = raw.slice(queryStart + 1);
  }
  const eq = raw.indexOf('=');
  if (eq <= 0) return null;
  const key = raw.slice(0, eq).toLowerCase();
  const value = safeDecode(raw.slice(eq + 1)).trim();
  if (!value) return null;

  if (key === 'ipa' || key === 'url') {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const fileName = url.pathname.split('/').filter(Boolean).pop() || url.hostname;
    return { kind: 'url', url: url.toString(), label: fileName };
  }

  if (key === 'gh' || key === 'github' || key === 'repo') {
    const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:@(.+))?$/.exec(value);
    if (!match) return null;
    const [, owner, repo, tag] = match;
    const trimmedTag = tag?.trim() || undefined;
    return {
      kind: 'github',
      owner,
      repo,
      tag: trimmedTag,
      label: `${owner}/${repo}${trimmedTag ? `@${trimmedTag}` : ''}`,
    };
  }

  return null;
}

/** Serializes a source into the route query that `parseIpaSource` understands. */
export function ipaSourceQuery(source: IpaSource): string {
  if (source.kind === 'github') {
    const repo = source.tag ? `${source.owner}/${source.repo}@${source.tag}` : `${source.owner}/${source.repo}`;
    return `gh=${encodeURIComponent(repo)}`;
  }
  return `ipa=${encodeURIComponent(source.url)}`;
}

interface GithubReleaseJson {
  tag_name?: string;
  assets?: Array<{
    name?: string;
    size?: number;
    digest?: string | null;
    browser_download_url?: string;
  }>;
}

export async function resolveGithubIpaAsset(
  source: GithubIpaSource,
  fetchImpl: typeof fetch = fetch,
): Promise<RemoteIpaAsset> {
  const base = `https://api.github.com/repos/${source.owner}/${source.repo}/releases`;
  const endpoint = source.tag ? `${base}/tags/${encodeURIComponent(source.tag)}` : `${base}/latest`;
  const response = await fetchImpl(endpoint, {
    headers: { Accept: 'application/vnd.github+json' },
    cache: 'no-store',
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        source.tag
          ? `release tag "${source.tag}" not found on ${source.owner}/${source.repo}`
          : `${source.owner}/${source.repo} has no published release`,
      );
    }
    if (response.status === 403 || response.status === 429) {
      throw new Error('GitHub API rate limit reached, try again later');
    }
    throw new Error(`GitHub API responded ${response.status}`);
  }

  const release = (await response.json()) as GithubReleaseJson;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const ipa = assets.find(
    (asset) =>
      typeof asset.name === 'string' &&
      /\.ipa$/i.test(asset.name) &&
      typeof asset.browser_download_url === 'string',
  );
  if (!ipa?.name || !ipa.browser_download_url) {
    const tag = release.tag_name ? ` ${release.tag_name}` : '';
    throw new Error(
      assets.length > 0
        ? `release${tag} has no .ipa asset (${assets.map((a) => a.name).filter(Boolean).join(', ')})`
        : `release${tag} has no assets`,
    );
  }

  return {
    name: ipa.name,
    url: ipa.browser_download_url,
    size: typeof ipa.size === 'number' ? ipa.size : 0,
    digest: typeof ipa.digest === 'string' && ipa.digest.length > 0 ? ipa.digest : null,
    releaseTag: release.tag_name ?? '',
  };
}

export class IpaDownloadError extends Error {
  readonly corsBlocked: boolean;

  constructor(message: string, corsBlocked = false) {
    super(message);
    this.name = 'IpaDownloadError';
    this.corsBlocked = corsBlocked;
  }
}

export interface DownloadProgress {
  loaded: number;
  total: number;
}

export interface DownloadOptions {
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
}

export async function downloadIpaBytes(
  url: string,
  { onProgress, signal }: DownloadOptions = {},
): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      credentials: 'omit',
      cache: 'no-store',
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new IpaDownloadError(
      'the file host did not allow cross-origin download (CORS). Links must be served with Access-Control-Allow-Origin.',
      true,
    );
  }

  if (!response.ok) {
    throw new IpaDownloadError(`download failed with HTTP ${response.status}`);
  }

  const declaredTotal = Number(response.headers.get('content-length')) || 0;

  if (!response.body) {
    const buffer = await response.arrayBuffer();
    onProgress?.({ loaded: buffer.byteLength, total: declaredTotal || buffer.byteLength });
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({ loaded, total: declaredTotal });
  }

  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer as ArrayBuffer;
}

export function resolveProxyTemplate(): string | null {
  const stored = loadText(IPA_PROXY_STORAGE_KEY)?.trim();
  if (stored) return stored === 'off' ? null : stored;

  const env = (import.meta.env.VITE_IPA_PROXY as string | undefined)?.trim();
  if (env === 'off') return null;
  if (env) return env;

  return DEFAULT_GITHUB_PROXY;
}

/**
 * Rewrites a GitHub-hosted download so it can be fetched cross-origin. Accepts a
 * prefix (`https://mirror/`) or a template containing `{url}`. Returns null for
 * anything that is not GitHub-hosted.
 */
export function proxyDownloadUrl(
  url: string,
  template: string | null = resolveProxyTemplate(),
): string | null {
  if (!template) return null;

  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!GITHUB_PROXY_HOSTS.has(hostname)) return null;

  if (template.includes('{url}')) {
    return template.replaceAll('{url}', encodeURIComponent(url));
  }
  return `${template.replace(/\/+$/, '')}/${url}`;
}

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

const IPA_CACHE_NAME = 'sideimpactor-ipa-v1';

function getCacheStorage(): CacheStorage | null {
  try {
    return typeof caches === 'undefined' ? null : caches;
  } catch {
    return null;
  }
}

/** Completed downloads are kept across reloads; returns null when unavailable or missing. */
export async function readCachedIpa(url: string): Promise<ArrayBuffer | null> {
  const storage = getCacheStorage();
  if (!storage) return null;
  try {
    const cache = await storage.open(IPA_CACHE_NAME);
    const response = await cache.match(url);
    return response ? await response.arrayBuffer() : null;
  } catch {
    return null;
  }
}

export async function writeCachedIpa(url: string, bytes: ArrayBuffer): Promise<boolean> {
  const storage = getCacheStorage();
  if (!storage) return false;
  try {
    const cache = await storage.open(IPA_CACHE_NAME);
    await cache.put(
      url,
      new Response(bytes, {
        headers: {
          'content-type': 'application/octet-stream',
          'x-ipa-cached-at': new Date().toISOString(),
        },
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export async function deleteCachedIpa(url: string): Promise<void> {
  const storage = getCacheStorage();
  if (!storage) return;
  try {
    const cache = await storage.open(IPA_CACHE_NAME);
    await cache.delete(url);
  } catch {
    // A missing cache is equivalent to a successful delete.
  }
}

export function digestMatches(digest: string | null | undefined, hex: string): boolean {
  if (!digest) return false;
  const separator = digest.indexOf(':');
  if (separator < 0) return false;
  const algorithm = digest.slice(0, separator).toLowerCase();
  const expected = digest.slice(separator + 1).toLowerCase();
  return algorithm === 'sha256' && expected === hex.toLowerCase();
}

export function ipaFileName(name: string, fallbackUrl: string): string {
  const base =
    name.trim().replace(/[\\/]+/g, '_') ||
    (() => {
      try {
        return new URL(fallbackUrl).pathname.split('/').filter(Boolean).pop() ?? 'remote.ipa';
      } catch {
        return 'remote.ipa';
      }
    })();
  return /\.ipa$/i.test(base) ? base : `${base}.ipa`;
}
