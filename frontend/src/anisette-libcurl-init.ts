import { loadLibcurl, libcurl } from './wasm/libcurl';

let initialized = false;
let initPromise: Promise<void> | null = null;

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

export async function initLibcurl(): Promise<void> {
  if (initialized) {
    return;
  }
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    let loadedLibcurl;
    try {
      loadedLibcurl = await loadLibcurl();
    } catch (error) {
      initPromise = null;
      throw new Error(`Failed to load libcurl WASM module. ${error instanceof Error ? error.message : String(error)}`);
    }
    loadedLibcurl.set_websocket(resolveWispUrl());
    try {
      await loadedLibcurl.load_wasm();
    } catch (error) {
      initPromise = null;
      throw new Error(
        `Failed to initialize libcurl (is the WISP backend running?). ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    initialized = true;
  })();

  return initPromise;
}

export { libcurl };
