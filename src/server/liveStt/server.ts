import { createServer, type IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { consumeLiveSttSession } from "@/lib/liveStt/session";
import { openSaluteSpeechLiveRecognition } from "@omniroute/open-sse/handlers/saluteSpeechLive.ts";

const DEFAULT_PORT = 20133;
const DEFAULT_HOST = "127.0.0.1";
const MAX_AUDIO_CHUNK_BYTES = 64 * 1024;
const MAX_SESSION_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_SESSION_DURATION_MS = 300 * 1000;
const MAX_CONCURRENT_SESSIONS = 5;

let activeSessions = 0;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getProtocolToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value) return null;
  const protocol = value
    .split(",")
    .map((part) => part.trim())
    .find((part) => part.startsWith("live-stt."));
  const token = protocol?.slice("live-stt.".length) ?? "";
  return /^[A-Za-z0-9._-]{32,4096}$/.test(token) ? token : null;
}

function send(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function close(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(code, reason.slice(0, 123));
  }
}

function parseStartMessage(data: WebSocket.RawData): { sampleRate: 8000 | 16000 | 48000 } | null {
  if (!Buffer.isBuffer(data)) return null;
  try {
    const payload = JSON.parse(data.toString("utf8")) as { type?: unknown; sampleRate?: unknown };
    if (payload.type !== "start") return null;
    if (payload.sampleRate !== 8000 && payload.sampleRate !== 16000 && payload.sampleRate !== 48000)
      return null;
    return { sampleRate: payload.sampleRate };
  } catch {
    return null;
  }
}

async function getConnectionCredentials(connectionId: string) {
  const { getProviderCredentialsWithQuotaPreflight } = await import("@/sse/services/auth");
  return getProviderCredentialsWithQuotaPreflight("salutespeech", null, null, null, {
    forcedConnectionId: connectionId,
  });
}

async function handleConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
  const token = getProtocolToken(request.headers["sec-websocket-protocol"]);
  const origin = request.headers.origin;
  if (
    !token ||
    !origin ||
    activeSessions >=
      parsePositiveInt(process.env.LIVE_STT_MAX_CONCURRENT_SESSIONS, MAX_CONCURRENT_SESSIONS)
  ) {
    close(socket, 1008, "Live STT is unavailable");
    return;
  }

  let session;
  try {
    session = await consumeLiveSttSession(token, origin);
  } catch {
    close(socket, 1008, "Invalid live STT session");
    return;
  }

  activeSessions += 1;
  let settled = false;
  let started = false;
  let initializing = false;
  let receivedBytes = 0;
  let recognition: Awaited<ReturnType<typeof openSaluteSpeechLiveRecognition>> | null = null;
  const timeout = setTimeout(
    () => close(socket, 1000, "Live STT session duration limit reached"),
    parsePositiveInt(process.env.LIVE_STT_MAX_SESSION_SECONDS, MAX_SESSION_DURATION_MS / 1000) *
      1000
  );

  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    recognition?.close();
    activeSessions = Math.max(0, activeSessions - 1);
  };

  socket.once("close", finish);
  socket.once("error", finish);
  send(socket, { type: "ready", language: session.language, model: session.model });

  socket.on("message", async (data, isBinary) => {
    if (settled) return;
    if (!started) {
      if (isBinary) {
        close(socket, 1008, "Send start options before audio");
        return;
      }
      const start = parseStartMessage(data);
      if (!start) {
        close(socket, 1008, "Invalid start options");
        return;
      }
      started = true;
      initializing = true;
      try {
        const credentials = await getConnectionCredentials(session.connectionId);
        if (!credentials) throw new Error("No active SaluteSpeech connection");
        recognition = await openSaluteSpeechLiveRecognition({
          credentials,
          language: session.language,
          model: session.model,
          sampleRate: start.sampleRate,
          onResult: (result) => send(socket, result),
          onError: () => {
            send(socket, {
              type: "error",
              code: "provider_error",
              message: "Speech recognition provider failed",
            });
            close(socket, 1011, "Speech recognition provider failed");
          },
          onEnd: () => close(socket, 1000, "Speech recognition finished"),
        });
        initializing = false;
        send(socket, { type: "started", sampleRate: start.sampleRate });
      } catch {
        initializing = false;
        send(socket, {
          type: "error",
          code: "provider_unavailable",
          message: "Live STT is unavailable",
        });
        close(socket, 1011, "Live STT is unavailable");
      }
      return;
    }

    if (!isBinary || !recognition) {
      if (!initializing) close(socket, 1008, "Audio frames must be binary PCM");
      return;
    }
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    const maxChunkBytes = parsePositiveInt(
      process.env.LIVE_STT_MAX_AUDIO_CHUNK_BYTES,
      MAX_AUDIO_CHUNK_BYTES
    );
    if (chunk.length === 0 || chunk.length > maxChunkBytes || chunk.length % 2 !== 0) {
      close(socket, 1009, "Invalid audio frame");
      return;
    }
    receivedBytes += chunk.length;
    if (
      receivedBytes >
      parsePositiveInt(process.env.LIVE_STT_MAX_SESSION_AUDIO_BYTES, MAX_SESSION_AUDIO_BYTES)
    ) {
      close(socket, 1009, "Live STT audio limit reached");
      return;
    }
    recognition.writeAudio(chunk);
  });
}

export function startLiveSttServer(
  port = DEFAULT_PORT,
  host = DEFAULT_HOST
): Promise<import("node:http").Server> {
  const server = createServer((request, response) => {
    if (request.url === "/readyz") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end('{"error":"not_found"}');
  });
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: parsePositiveInt(process.env.LIVE_STT_MAX_AUDIO_CHUNK_BYTES, MAX_AUDIO_CHUNK_BYTES),
  });

  server.on("upgrade", (request, socket, head) => {
    if (
      new URL(request.url ?? "/", "http://localhost").pathname !== "/v1/audio/transcriptions/live"
    ) {
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      void handleConnection(websocket, request);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function isBuildOrTest(): boolean {
  return (
    process.env.NEXT_PHASE === "phase-production-build" ||
    process.env.NODE_ENV === "test" ||
    process.argv.some((arg) => arg.includes("test"))
  );
}

if (!isBuildOrTest() && process.env.OMNIROUTE_ENABLE_LIVE_STT !== "0") {
  startLiveSttServer(
    Number.parseInt(process.env.LIVE_STT_PORT ?? String(DEFAULT_PORT), 10),
    process.env.LIVE_STT_HOST ?? DEFAULT_HOST
  )
    .then(() => console.log("[LiveSTT] SaluteSpeech WebSocket server listening on 127.0.0.1:20133"))
    .catch((error: unknown) => {
      console.warn(
        "[LiveSTT] Failed to start SaluteSpeech WebSocket server:",
        error instanceof Error ? error.message : error
      );
    });
}
