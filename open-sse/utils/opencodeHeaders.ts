import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setUserAgentHeader } from "../executors/base.ts";
import { generateSessionId } from "../services/sessionManager.ts";

export const DEFAULT_OPENCODE_USER_AGENT = "opencode/1.18.31";
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
export const OPENCODE_REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MINIMUM_OPENCODE_MINOR_VERSION = 17;

let lastSessionTimestamp = 0;
let sessionCounter = 0;

function randomBase62(length: number): string {
  const bytes = randomBytes(length);
  return Array.from(bytes, (byte) => BASE62_CHARS[byte % BASE62_CHARS.length]).join("");
}

function generateOpenCodeIdentifier(prefix: "ses_" | "msg_"): string {
  const timestamp = Date.now();
  let sequence = 1;
  if (prefix === "ses_") {
    if (timestamp === lastSessionTimestamp) {
      sessionCounter += 1;
    } else {
      lastSessionTimestamp = timestamp;
      sessionCounter = 1;
    }
    sequence = sessionCounter;
  }

  const rawValue = BigInt(timestamp) * 0x1000n + BigInt(sequence);
  const value = prefix === "ses_" ? ~rawValue : rawValue;
  const encodedTimestamp = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");

  return `${prefix}${encodedTimestamp}${randomBase62(14)}`;
}

function hasValidOpencodeVersion(userAgent: string): boolean {
  const match = userAgent.match(/opencode\/(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!match) return false;

  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  return major > 1 || (major === 1 && minor >= MINIMUM_OPENCODE_MINOR_VERSION);
}

function translateSessionId(sessionId: string, clientTool: string): string {
  const normalized = sessionId.trim();
  if (OPENCODE_SESSION_RE.test(normalized)) return normalized;

  const digest = createHash("sha256")
    .update(`opencode\0${clientTool || "generic"}\0${normalized}`)
    .digest();
  const translatedSuffix = Array.from(
    digest.subarray(6, 20),
    (byte) => BASE62_CHARS[byte % BASE62_CHARS.length]
  ).join("");
  return `ses_${digest.subarray(0, 6).toString("hex")}${translatedSuffix}`;
}

function normalizeRequestId(requestId: string | undefined): string {
  const normalized = requestId?.trim();
  return normalized && OPENCODE_REQUEST_RE.test(normalized)
    ? normalized
    : generateOpenCodeIdentifier("msg_");
}

function normalizeSessionId(
  sessionId: string | undefined,
  sessionBody:
    | {
        model?: string;
        system?: unknown;
        messages?: Array<{ role?: string; content?: unknown }>;
        input?: Array<{ role?: string; content?: unknown }>;
        tools?: Array<{ name?: string; function?: { name?: string } }>;
      }
    | undefined,
  clientTool: string
): string {
  if (sessionId?.trim()) return translateSessionId(sessionId, clientTool);

  const fingerprint = generateSessionId(sessionBody ?? null);
  return fingerprint
    ? translateSessionId(fingerprint, clientTool)
    : generateOpenCodeIdentifier("ses_");
}

/**
 * Header keys that are forwarded from the client to the upstream provider.
 * Used by both OpencodeExecutor and DefaultExecutor.
 */
const OPENCODE_HEADER_KEYS = [
  "x-opencode-session",
  "x-opencode-request",
  "x-opencode-project",
  "x-opencode-client",
] as const;

/**
 * Common agent-metadata headers used by non-OpenCode clients (custom agents/
 * providers) for upstream request tracking and attribution. Forwarded the same
 * way as the x-opencode-* set: case-insensitive lookup, client value wins.
 * Added for 9router#2413 — these were previously dropped for every client
 * outside the OpenCode allowlist.
 */
const AGENT_METADATA_HEADER_KEYS = ["x-session-id", "x-title"] as const;

/**
 * Case-insensitive lookup for a header in a headers record.
 */
function findHeader(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

/**
 * Forward OpenCode client request metadata headers to the upstream provider.
 *
 * Shared logic used by OpencodeExecutor and DefaultExecutor:
 * 1. Forwards User-Agent from clientHeaders via `setUserAgentHeader()`
 * 2. Forwards x-opencode-session, x-opencode-request, x-opencode-project,
 *    x-opencode-client headers (case-insensitive match)
 * 3. Forwards x-session-id, x-title agent-metadata headers (case-insensitive
 *    match) — common conventions used by non-OpenCode agent clients (9router#2413)
 *
 * @param headers - The outbound headers record to mutate
 * @param clientHeaders - The client-provided headers to forward from
 * @param options.synthesizeRequestId - When true (OpencodeExecutor only), maps
 *   x-session-affinity / x-session-id to x-opencode-session when the latter is
 *   missing, and synthesizes a UUID for x-opencode-request if also missing.
 * @param options.cliDefaults - When provided (OpencodeExecutor only), synthesize
 *   the OpenCode CLI identity headers that Cloudflare requires on VPS egress
 *   (User-Agent, x-opencode-client, x-opencode-project) plus canonical request/session
 *   IDs. Client values are retained when they already satisfy the upstream contract;
 *   foreign session IDs are translated deterministically and invalid request IDs are
 *   replaced. A non-OpenCode or outdated User-Agent is replaced with the versioned
 *   OpenCode default required by the free tier. (#4101, #4105)
 * @param options.sessionBody - Request body fields used to generate a
 *   conversation-stable session fingerprint (model, system, messages, tools).
 *   When provided, x-opencode-session is deterministically translated into the
 *   canonical OpenCode format, so upstream prompt caching hits across requests in
 *   the same conversation.
 */
export function forwardOpencodeClientHeaders(
  headers: Record<string, string>,
  clientHeaders: Record<string, string>,
  options?: {
    synthesizeRequestId?: boolean;
    cliDefaults?: { userAgent: string; client: string; project: string };
    sessionBody?: {
      model?: string;
      system?: unknown;
      messages?: Array<{ role?: string; content?: unknown }>;
      input?: Array<{ role?: string; content?: unknown }>;
      tools?: Array<{ name?: string; function?: { name?: string } }>;
    };
  }
): void {
  // 1. Forward User-Agent
  const clientUA = clientHeaders["User-Agent"] || clientHeaders["user-agent"];
  if (clientUA) {
    setUserAgentHeader(headers, clientUA);
  }

  // 2. Forward x-opencode-* metadata headers
  for (const headerName of OPENCODE_HEADER_KEYS) {
    const value = findHeader(clientHeaders, headerName);
    if (value) {
      headers[headerName] = value;
    }
  }

  // 2b. Forward agent-metadata headers (x-session-id, x-title) — 9router#2413
  for (const headerName of AGENT_METADATA_HEADER_KEYS) {
    const value = findHeader(clientHeaders, headerName);
    if (value) {
      headers[headerName] = value;
    }
  }

  // 3. OpencodeExecutor-only: synthesize session/request id from fallback headers
  if (options?.synthesizeRequestId && !headers["x-opencode-session"]) {
    const sessionAffinity =
      findHeader(clientHeaders, "x-session-affinity") || findHeader(clientHeaders, "x-session-id");
    if (sessionAffinity) {
      headers["x-opencode-session"] = sessionAffinity;

      if (!headers["x-opencode-request"]) {
        headers["x-opencode-request"] = randomUUID();
      }
    }
  }

  // 4. OpencodeExecutor-only: synthesize the OpenCode CLI identity Cloudflare expects
  //    on VPS egress, for any key the client did not supply (#5997).
  if (options?.cliDefaults) {
    applyCliDefaults(headers, options.cliDefaults, options.sessionBody);
  }
}

/**
 * Fill the OpenCode CLI identity headers required by the free tier. Native canonical
 * identifiers are preserved, foreign session identifiers are translated, and invalid
 * request identifiers are regenerated for the current request.
 */
function applyCliDefaults(
  headers: Record<string, string>,
  cliDefaults: { userAgent: string; client: string; project: string },
  sessionBody?: {
    model?: string;
    system?: unknown;
    messages?: Array<{ role?: string; content?: unknown }>;
    input?: Array<{ role?: string; content?: unknown }>;
    tools?: Array<{ name?: string; function?: { name?: string } }>;
  }
): void {
  const existingUa = headers["User-Agent"] || headers["user-agent"];
  const fallbackUa = hasValidOpencodeVersion(cliDefaults.userAgent)
    ? cliDefaults.userAgent
    : DEFAULT_OPENCODE_USER_AGENT;
  const effectiveUa =
    typeof existingUa === "string" && hasValidOpencodeVersion(existingUa.trim())
      ? existingUa.trim()
      : fallbackUa;
  setUserAgentHeader(headers, effectiveUa);
  headers["x-opencode-client"] ||= cliDefaults.client;
  headers["x-opencode-project"] ||= cliDefaults.project;
  headers["x-opencode-request"] = normalizeRequestId(headers["x-opencode-request"]);
  headers["x-opencode-session"] = normalizeSessionId(
    headers["x-opencode-session"],
    sessionBody,
    headers["x-opencode-client"]
  );
}
