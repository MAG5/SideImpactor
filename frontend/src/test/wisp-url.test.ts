import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../wasm/libcurl', () => ({ loadLibcurl: vi.fn(), libcurl: undefined }));

import { resolveWispUrl } from '../anisette-libcurl-init';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveWispUrl', () => {
  it('defaults to the same-origin Wisp endpoint', () => {
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    expect(resolveWispUrl()).toBe(`${wsProto}//${location.host}/wisp/`);
  });

  it('uses VITE_WISP_URL when provided', () => {
    vi.stubEnv('VITE_WISP_URL', 'wss://sideload.nvme0n1p.dev/wisp/');
    expect(resolveWispUrl()).toBe('wss://sideload.nvme0n1p.dev/wisp/');
  });

  it('trims whitespace and ignores blank overrides', () => {
    vi.stubEnv('VITE_WISP_URL', '   ');
    const url = resolveWispUrl();
    expect(url).toMatch(/\/wisp\/$/);
    expect(url).not.toContain(' ');
  });
});