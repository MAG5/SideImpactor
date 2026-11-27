import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GITHUB_PROXY,
  deleteCachedIpa,
  digestMatches,
  downloadIpaBytes,
  IpaDownloadError,
  ipaFileName,
  parseIpaSource,
  proxyDownloadUrl,
  readCachedIpa,
  resolveGithubIpaAsset,
  resolveProxyTemplate,
  sha256Hex,
  writeCachedIpa,
} from '../lib/remote-ipa';
import { IPA_PROXY_STORAGE_KEY } from '../lib/storage';

describe('parseIpaSource', () => {
  it('accepts a plain or URL-encoded #ipa link', () => {
    expect(parseIpaSource('#ipa=https://cdn.example.com/app.ipa')).toEqual({
      kind: 'url',
      url: 'https://cdn.example.com/app.ipa',
      label: 'app.ipa',
    });
    expect(parseIpaSource('#ipa=https%3A%2F%2Fcdn.example.com%2Fa%20b.ipa')?.kind).toBe('url');
  });

  it('accepts #gh owner/repo with an optional tag', () => {
    expect(parseIpaSource('#gh=mag5/ipa-releases')).toEqual({
      kind: 'github',
      owner: 'mag5',
      repo: 'ipa-releases',
      tag: undefined,
      label: 'mag5/ipa-releases',
    });
    expect(parseIpaSource('#github=mag5/ipa-releases@v1.2.3')).toEqual({
      kind: 'github',
      owner: 'mag5',
      repo: 'ipa-releases',
      tag: 'v1.2.3',
      label: 'mag5/ipa-releases@v1.2.3',
    });
  });

  it('ignores app routes and non-http schemes', () => {
    expect(parseIpaSource('#/login')).toBeNull();
    expect(parseIpaSource('#ipa=javascript:alert(1)')).toBeNull();
    expect(parseIpaSource('')).toBeNull();
  });
});

describe('resolveGithubIpaAsset', () => {
  const source = { kind: 'github' as const, owner: 'mag5', repo: 'ipa-releases', label: 'mag5/ipa-releases' };

  it('picks the .ipa asset and keeps its digest', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          tag_name: 'v1.0.0',
          assets: [
            { name: 'notes.txt', size: 10, browser_download_url: 'https://github.com/x/notes.txt' },
            {
              name: 'App.IPA',
              size: 2048,
              digest: 'sha256:abc',
              browser_download_url: 'https://github.com/mag5/ipa-releases/releases/download/v1.0.0/App.IPA',
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const asset = await resolveGithubIpaAsset(source, fetchMock as unknown as typeof fetch);
    expect(asset).toMatchObject({ name: 'App.IPA', size: 2048, digest: 'sha256:abc', releaseTag: 'v1.0.0' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/mag5/ipa-releases/releases/latest',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('reports missing releases and rate limits', async () => {
    const notFound = vi.fn(async () => new Response('{}', { status: 404 }));
    await expect(
      resolveGithubIpaAsset(source, notFound as unknown as typeof fetch),
    ).rejects.toThrow(/has no published release/);

    const limited = vi.fn(async () => new Response('{}', { status: 403 }));
    await expect(resolveGithubIpaAsset(source, limited as unknown as typeof fetch)).rejects.toThrow(
      /rate limit/,
    );
  });
});

describe('downloadIpaBytes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('streams the body and reports progress', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(payload, { status: 200, headers: { 'content-length': String(payload.byteLength) } }),
      ),
    );

    const progress: Array<{ loaded: number; total: number }> = [];
    const buffer = await downloadIpaBytes('https://cdn.example.com/app.ipa', {
      onProgress: (p) => progress.push(p),
    });

    expect(Array.from(new Uint8Array(buffer))).toEqual([1, 2, 3, 4]);
    expect(progress.at(-1)).toEqual({ loaded: 4, total: 4 });
  });

  it('flags cross-origin failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    await expect(downloadIpaBytes('https://github.com/x/y.ipa')).rejects.toMatchObject({
      name: 'IpaDownloadError',
      corsBlocked: true,
    });
    await expect(downloadIpaBytes('https://github.com/x/y.ipa')).rejects.toBeInstanceOf(IpaDownloadError);
  });
});

describe('proxy selection', () => {
  it('rewrites only GitHub release URLs', () => {
    expect(proxyDownloadUrl('https://github.com/a/b/releases/download/v1/x.ipa', 'https://mirror.test/')).toBe(
      'https://mirror.test/https://github.com/a/b/releases/download/v1/x.ipa',
    );
    expect(proxyDownloadUrl('https://github.com/a/b/releases/download/v1/x.ipa', 'https://mirror.test/{url}')).toBe(
      `https://mirror.test/${encodeURIComponent('https://github.com/a/b/releases/download/v1/x.ipa')}`,
    );
    expect(proxyDownloadUrl('https://cdn.example.com/x.ipa', 'https://mirror.test/')).toBeNull();
  });

  it('defaults to the public GitHub mirror and can be disabled', () => {
    window.localStorage.removeItem(IPA_PROXY_STORAGE_KEY);
    expect(resolveProxyTemplate()).toBe(DEFAULT_GITHUB_PROXY);
    window.localStorage.setItem(IPA_PROXY_STORAGE_KEY, 'off');
    expect(resolveProxyTemplate()).toBeNull();
  });
});

describe('digest helpers', () => {
  it('matches sha256 digests from the GitHub API', async () => {
    const buffer = new TextEncoder().encode('hello').buffer;
    const hex = await sha256Hex(buffer);
    expect(hex).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(digestMatches(`sha256:${hex}`, hex)).toBe(true);
    expect(digestMatches('sha1:abc', hex)).toBe(false);
    expect(digestMatches(null, hex)).toBe(false);
  });

  it('keeps .ipa extensions on generated file names', () => {
    expect(ipaFileName('App.IPA', 'https://x/y.ipa')).toBe('App.IPA');
    expect(ipaFileName('', 'https://x/path/Download?id=1')).toBe('Download.ipa');
    expect(ipaFileName('a/b', 'https://x/y.ipa')).toBe('a_b.ipa');
  });
});

describe('ipa cache', () => {
  const store = new Map<string, Response>();
  const fakeCache = {
    match: async (url: string) => store.get(url),
    put: async (url: string, response: Response) => {
      store.set(url, response);
    },
    delete: async (url: string) => store.delete(url),
  };

  beforeEach(() => {
    store.clear();
  });

  it('round-trips bytes through the named cache', async () => {
    const open = vi.fn(async () => fakeCache);
    vi.stubGlobal('caches', { open });
    try {
      const bytes = new Uint8Array([9, 8, 7]).buffer;
      expect(await writeCachedIpa('https://cdn.example.com/a.ipa', bytes)).toBe(true);
      expect(open).toHaveBeenCalledWith('sideimpactor-ipa-v1');

      const cached = await readCachedIpa('https://cdn.example.com/a.ipa');
      expect(cached && [...new Uint8Array(cached)]).toEqual([9, 8, 7]);

      await deleteCachedIpa('https://cdn.example.com/a.ipa');
      expect(await readCachedIpa('https://cdn.example.com/a.ipa')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('degrades gracefully when Cache Storage is unavailable', async () => {
    vi.stubGlobal('caches', undefined);
    try {
      expect(await readCachedIpa('https://cdn.example.com/a.ipa')).toBeNull();
      expect(await writeCachedIpa('https://cdn.example.com/a.ipa', new ArrayBuffer(1))).toBe(false);
      await expect(deleteCachedIpa('https://cdn.example.com/a.ipa')).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns null and false when the cache operations throw', async () => {
    vi.stubGlobal('caches', {
      open: async () => {
        throw new Error('quota exceeded');
      },
    });
    try {
      expect(await readCachedIpa('https://cdn.example.com/a.ipa')).toBeNull();
      expect(await writeCachedIpa('https://cdn.example.com/a.ipa', new ArrayBuffer(1))).toBe(false);
      await expect(deleteCachedIpa('https://cdn.example.com/a.ipa')).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
