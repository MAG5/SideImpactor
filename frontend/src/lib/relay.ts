/**
 * Static hosts (GitHub Pages) have no same-origin Wisp relay, so the endpoint
 * can be pointed elsewhere at build time via VITE_WISP_URL.
 */
export function resolveWispUrl(): string {
  const override = (import.meta.env.VITE_WISP_URL as string | undefined)?.trim();
  if (override) {
    return override;
  }
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${location.host}/wisp/`;
}

/** Derive the HTTP anisette endpoint from the relay (wss://host/wisp/ -> https://host/anisette). */
export function resolveAnisetteUrl(): string {
  const configured = (import.meta.env.VITE_ANISETTE_URL as string | undefined)?.trim();
  if (configured) {
    return configured;
  }
  const url = new URL(resolveWispUrl());
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/anisette';
  url.search = '';
  url.hash = '';
  return url.toString();
}
