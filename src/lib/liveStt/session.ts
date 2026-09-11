import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

const LIVE_STT_AUDIENCE = "omniroute-salutespeech-live-stt";
const DEFAULT_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 300;

export type LiveSttSessionInput = {
  apiKeyId: string | null;
  connectionId: string;
  origin: string;
  language: string;
  model: "general" | "callcenter";
};

export type VerifiedLiveSttSession = LiveSttSessionInput & {
  jti: string;
  expiresAt: string;
};

const consumedSessions = new Map<string, number>();

function getSecret(): Uint8Array {
  const value = process.env.LIVE_STT_TOKEN_SECRET?.trim() || process.env.JWT_SECRET?.trim();
  if (!value) throw new Error("Live STT session signing secret is not configured");
  return new TextEncoder().encode(value);
}

function getTtlSeconds(): number {
  const value = Number.parseInt(process.env.LIVE_STT_SESSION_TTL_SECONDS ?? "", 10);
  if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_TTL_SECONDS;
  return Math.min(value, MAX_TTL_SECONDS);
}

function cleanupConsumedSessions(now: number): void {
  for (const [jti, expiresAt] of consumedSessions) {
    if (expiresAt <= now) consumedSessions.delete(jti);
  }
}

export async function createLiveSttSession(input: LiveSttSessionInput): Promise<{
  token: string;
  expiresAt: string;
}> {
  const parsedOrigin = new URL(input.origin);
  const ttlSeconds = getTtlSeconds();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const jti = randomUUID();
  const token = await new SignJWT({
    connectionId: input.connectionId,
    origin: parsedOrigin.origin,
    language: input.language,
    model: input.model,
    apiKeyId: input.apiKeyId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(LIVE_STT_AUDIENCE)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(getSecret());

  return { token, expiresAt: expiresAt.toISOString() };
}

export async function consumeLiveSttSession(
  token: string,
  origin: string
): Promise<VerifiedLiveSttSession> {
  const { payload } = await jwtVerify(token, getSecret(), {
    algorithms: ["HS256"],
    audience: LIVE_STT_AUDIENCE,
  });
  const connectionId = typeof payload.connectionId === "string" ? payload.connectionId : "";
  const sessionOrigin = typeof payload.origin === "string" ? payload.origin : "";
  const language = typeof payload.language === "string" ? payload.language : "";
  const model =
    payload.model === "general" || payload.model === "callcenter" ? payload.model : null;
  const jti = typeof payload.jti === "string" ? payload.jti : "";
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  const apiKeyId = typeof payload.apiKeyId === "string" ? payload.apiKeyId : null;
  if (!connectionId || !sessionOrigin || !language || !model || !jti || sessionOrigin !== origin) {
    throw new Error("Invalid live STT session");
  }

  const now = Date.now();
  cleanupConsumedSessions(now);
  const expiresAtMs = exp * 1000;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now || consumedSessions.has(jti)) {
    throw new Error("Live STT session is unavailable");
  }
  consumedSessions.set(jti, expiresAtMs);

  return {
    apiKeyId,
    connectionId,
    origin: sessionOrigin,
    language,
    model,
    jti,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export function resetLiveSttSessionsForTests(): void {
  consumedSessions.clear();
}
