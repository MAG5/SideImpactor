import { connect } from "cloudflare:sockets";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";

const APPLE_HOSTNAME_WHITELIST = [
  /^auth\.itunes\.apple\.com$/,
  /^buy\.itunes\.apple\.com$/,
  /^init\.itunes\.apple\.com$/,
  /^p\d+-buy\.itunes\.apple\.com$/,
  /^gsa\.apple\.com$/,
  /^developerservices2\.apple\.com$/,
];

/**
 * Apple rejects identities provisioned by the Android CoreADI libraries inside
 * anisette-js (`finishMachineProvisioning` -> 401 / ec=-29003), so browsers now
 * take anisette headers from a Mac-side service. Upstreams are fixed here to
 * avoid turning this Worker into an open proxy.
 *
 * Only servers with a STABLE machine identity belong here. A GS token is bound
 * to the X-Apple-I-MD-M that minted it, so an upstream that provisions a fresh
 * machine per request (new.ani.sidestore.io rotated through ~10 identities in
 * 30 samples) makes every later developer-services call fail with 1100
 * "session expired". Clients pin the host that served their login with
 * `?upstream=<host>`; the order below is only the default for first logins.
 */
const ANISETTE_UPSTREAMS = [
  "https://mac-ani.jkcoxson.com/",
  "https://ani.npeg.us/",
  "https://anisette.crystall1ne.dev/",
  "https://omni.ethxn.xyz/",
];

const ANISETTE_TIMEOUT_MS = 8000;

/** Every successful payload must carry these or GSA rejects the login later. */
const REQUIRED_ANISETTE_HEADERS = [
  "X-Apple-I-MD-M",
  "X-Apple-I-MD",
  "X-Apple-I-MD-LU",
  "X-Apple-I-MD-RINFO",
  "X-Mme-Device-Id",
  "X-Apple-I-Client-Time",
];

const ANISETTE_CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "accept",
  "access-control-expose-headers": "x-anisette-upstream",
};

function hasRequiredAnisetteHeaders(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const keys = new Set(Object.keys(payload as Record<string, unknown>).map((key) => key.toLowerCase()));
  return REQUIRED_ANISETTE_HEADERS.every((name) => keys.has(name.toLowerCase()));
}

wisp.options.hostname_whitelist = APPLE_HOSTNAME_WHITELIST;
wisp.options.port_whitelist = [443];
wisp.options.allow_direct_ip = false;
wisp.options.allow_private_ips = false;
wisp.options.allow_loopback_ips = false;
wisp.options.allow_udp_streams = false;
wisp.options.allow_tcp_streams = true;
wisp.options.wisp_version = 1;

class AsyncQueue<T> {
  private queue: T[] = [];
  private resolvers: Array<(value: T | null) => void> = [];
  private closed = false;

  put(value: T): void {
    if (this.closed) {
      return;
    }
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver(value);
      return;
    }
    this.queue.push(value);
  }

  async get(): Promise<T | null> {
    if (this.queue.length > 0) {
      return this.queue.shift() ?? null;
    }
    if (this.closed) {
      return null;
    }
    return await new Promise<T | null>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      resolver?.(null);
    }
    this.queue.length = 0;
  }
}

class WorkerTCPSocket {
  hostname: string;
  port: number;

  private socket: Socket | null = null;
  private reader: ReadableStreamDefaultReader | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private recvQueue = new AsyncQueue<Uint8Array>();

  constructor(hostname: string, port: number) {
    this.hostname = hostname;
    this.port = port;
  }

  async connect(): Promise<void> {
    this.socket = connect(
      { hostname: this.hostname, port: this.port },
      { secureTransport: "off", allowHalfOpen: false },
    );

    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();

    void this.pumpReadable();
  }

  private async pumpReadable(): Promise<void> {
    if (!this.reader) {
      return;
    }

    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) {
          break;
        }
        if (value) {
          this.recvQueue.put(value instanceof Uint8Array ? value : new Uint8Array(value));
        }
      }
    } catch {
      // Ignore socket read errors and surface as stream close.
    } finally {
      this.recvQueue.close();
      await this.close();
    }
  }

  async recv(): Promise<Uint8Array | null> {
    return await this.recvQueue.get();
  }

  async send(data: Uint8Array | ArrayBuffer | ArrayBufferView): Promise<void> {
    if (!this.writer) {
      throw new Error("TCP socket writer is not ready");
    }

    let chunk: Uint8Array;
    if (data instanceof Uint8Array) {
      chunk = data;
    } else if (data instanceof ArrayBuffer) {
      chunk = new Uint8Array(data);
    } else {
      chunk = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }

    await this.writer.write(chunk);
  }

  async close(): Promise<void> {
    this.recvQueue.close();

    try {
      await this.reader?.cancel();
    } catch {
      // Ignore close errors.
    }

    try {
      await this.writer?.close();
    } catch {
      // Ignore close errors.
    }

    try {
      await this.socket?.close();
    } catch {
      // Ignore close errors.
    }

    this.reader = null;
    this.writer = null;
    this.socket = null;
  }

  pause(): void {}

  resume(): void {}
}

class WorkerWebSocketCompat {
  readonly OPEN = 1;

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  private readonly socket: WebSocket;

  constructor(socket: WebSocket) {
    this.socket = socket;

    this.socket.addEventListener("open", (event) => {
      this.onopen?.(event as Event);
    });
    this.socket.addEventListener("message", (event) => {
      this.onmessage?.(event as MessageEvent);
    });
    this.socket.addEventListener("close", (event) => {
      this.onclose?.(event as CloseEvent);
    });
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  get bufferedAmount(): number {
    // Workers WebSocket server side does not reliably expose bufferedAmount.
    // Returning 0 keeps wisp-js from stalling in its backpressure loop.
    return 0;
  }

  send(message: ArrayBuffer | ArrayBufferView | string): void {
    this.socket.send(message);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }
}

class UnsupportedUDPSocket {
  hostname: string;
  port: number;

  constructor(hostname: string, port: number) {
    this.hostname = hostname;
    this.port = port;
  }

  async connect(): Promise<void> {
    throw new Error("UDP streams are disabled in this Worker demo");
  }

  async recv(): Promise<null> {
    return null;
  }

  async send(): Promise<void> {
    throw new Error("UDP streams are disabled in this Worker demo");
  }

  async close(): Promise<void> {}

  pause(): void {}

  resume(): void {}
}

function stripTrailingSlashToken(token: string): string {
  return token.replace(/\/+$/, "");
}

function timingSafeEqualString(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  if (aBytes.length !== bBytes.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < aBytes.length; i += 1) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

let passwordHashCache: { source: string; hash: string } | null = null;

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function getExpectedToken(env: Env): Promise<string> {
  const runtimeEnv = env as unknown as {
    ACCESS_TOKEN_HASH?: unknown;
    ACCESS_PASSWORD?: unknown;
  };

  const rawHash = runtimeEnv.ACCESS_TOKEN_HASH;
  const hash = typeof rawHash === "string" ? rawHash.trim() : "";
  if (hash) {
    return hash;
  }

  const rawPassword = runtimeEnv.ACCESS_PASSWORD;
  const password = typeof rawPassword === "string" ? rawPassword.trim() : "";
  if (!password) {
    return "";
  }

  if (!passwordHashCache || passwordHashCache.source !== password) {
    passwordHashCache = {
      source: password,
      hash: await sha256Hex(password),
    };
  }

  return passwordHashCache.hash;
}

function isWebSocketUpgrade(request: Request): boolean {
  const upgrade = request.headers.get("Upgrade");
  return upgrade !== null && upgrade.toLowerCase() === "websocket";
}

async function handleWispSession(serverSocket: WebSocket, path: string): Promise<void> {
  const compatSocket = new WorkerWebSocketCompat(serverSocket);

  const conn = new wisp.ServerConnection(compatSocket as unknown as WebSocket, path, {
    TCPSocket: WorkerTCPSocket,
    UDPSocket: UnsupportedUDPSocket,
    ping_interval: 30,
    wisp_version: 1,
  });

  await conn.setup();
  await conn.run();
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function handleAnisette(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: ANISETTE_CORS_HEADERS });
  }
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ ok: false, error: "GET required" }), {
      status: 405,
      headers: {
        ...ANISETTE_CORS_HEADERS,
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  // The calling session remembers which upstream minted its GS token and asks
  // for the same one, so the machine identity stays consistent across logins
  // and later signing calls. Unknown hosts are ignored, not proxied.
  const requestedHost = (new URL(request.url).searchParams.get("upstream") || "").trim().toLowerCase();
  const upstreams = [...ANISETTE_UPSTREAMS];
  if (requestedHost) {
    const index = upstreams.findIndex((upstream) => new URL(upstream).host === requestedHost);
    if (index > 0) {
      upstreams.unshift(upstreams.splice(index, 1)[0]);
    }
  }

  // Every attempt returns a fresh one-time password, so responses are never cached.
  for (const upstream of upstreams) {
    try {
      const response = await fetch(upstream, {
        headers: { accept: "application/json" },
        redirect: "follow",
        signal: AbortSignal.timeout(ANISETTE_TIMEOUT_MS),
      });
      if (!response.ok) {
        console.warn("Anisette upstream responded", upstream, response.status);
        continue;
      }
      const body = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        console.warn("Anisette upstream returned non-JSON", upstream);
        continue;
      }
      if (!hasRequiredAnisetteHeaders(payload)) {
        console.warn("Anisette upstream payload missing required headers", upstream);
        continue;
      }
      return new Response(body, {
        status: 200,
        headers: {
          ...ANISETTE_CORS_HEADERS,
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          // Lets the client log which server minted this OTP when diagnosing.
          "x-anisette-upstream": new URL(upstream).host,
        },
      });
    } catch (error) {
      console.warn("Anisette upstream failed", upstream, error);
    }
  }

  return new Response(JSON.stringify({ ok: false, error: "anisette upstream unavailable" }), {
    status: 502,
    headers: {
      ...ANISETTE_CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/healthz") {
      return json(200, {
        ok: true,
        service: "sideload-relay",
        now: new Date().toISOString(),
      });
    }

    if (url.pathname === "/anisette") {
      return await handleAnisette(request);
    }

    if (url.pathname.startsWith("/wisp")) {
      if (!isWebSocketUpgrade(request)) {
        return json(426, {
          ok: false,
          error: "WebSocket upgrade required for /wisp/",
        });
      }

      if (!url.pathname.endsWith("/")) {
        return json(404, {
          ok: false,
          error: "Only /wisp/ is supported in this demo",
        });
      }

      const expectedToken = await getExpectedToken(env);
      if (expectedToken) {
        const token = stripTrailingSlashToken(url.searchParams.get("token") || "");
        if (!timingSafeEqualString(token, expectedToken)) {
          return json(401, { ok: false, error: "Invalid token" });
        }
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();

      ctx.waitUntil(
        handleWispSession(server, url.pathname).catch((error) => {
          console.error("Wisp session failed", error);
          try {
            server.close(1011, "Internal Wisp Error");
          } catch {
            // Ignore close errors.
          }
        }),
      );

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    return await env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
