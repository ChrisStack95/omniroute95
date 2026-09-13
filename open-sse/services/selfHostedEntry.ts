/**
 * Self-hosted unified OpenAI-compatible entry (D4 — 接入即用).
 *
 * Exposes OmniRoute's existing /v1/chat/completions route as a self-hosted
 * gateway: one OpenAI-compatible contract in, auto-route to the runtime-selected
 * provider, standard OpenAI error shape out.
 *
 * Design (KISS / RIC-738):
 *  - Reuses the provider adapters from `providerAdapters.ts` (RIC-737) — no new
 *    abstraction layer. This module only orchestrates: load config → auth → pick
 *    provider → dispatch → normalize response.
 *  - Config is declarative YAML (env string or file path); credentials live in
 *    the file/env at runtime and are never logged or persisted (RIC-737 contract).
 *  - Auto-route = header override -> model-prefix match -> first configured
 *    provider. No predictive routing (M2 owns deterministic strategies).
 *  - The API-key check is a scaffold reserved for the D5 quota-key system: when
 *    `OMNIROUTE_SELF_HOSTED_API_KEY` is unset the route is open (loopback /
 *    trusted-network deployment), exactly like the existing self-hosted local
 *    providers.
 */

import * as yaml from "js-yaml";
import { readFile } from "node:fs/promises";
import { errorResponse, buildErrorBody, parseUpstreamError } from "../utils/error.ts";
import { stripSensitiveResponseHeaders } from "../utils/upstreamResponseHeaders.ts";
import type { ChatRequest, ProviderConfig } from "./providerAdapters.ts";
import { ProviderRouter } from "./providerAdapters.ts";

/** Env var holding the inline YAML provider config (runtime-only credentials). */
export const CONFIG_ENV = "OMNIROUTE_SELF_HOSTED_PROVIDERS";
/** Env var pointing at a YAML file with the provider config. */
export const CONFIG_FILE_ENV = "OMNIROUTE_SELF_HOSTED_PROVIDERS_FILE";
/** Optional shared API key for the unified entry (D5 reserved). */
export const API_KEY_ENV = "OMNIROUTE_SELF_HOSTED_API_KEY";
/** Provider-selector header recognized by the unified entry. */
export const PROVIDER_SELECTOR_HEADER = "x-omniroute-provider";
/** Marker header added to responses routed through the unified entry. */
export const ROUTED_BY_HEADER = "x-omniroute-routed-by";
const ROUTED_BY_VALUE = "self-hosted-openai-compat";

/**
 * Provider id -> model mapping fallback when the request body carries no `model`
 * and the client opted out of the model-prefix convention. Kept empty: with no
 * model and no header the first configured provider is used (deterministic first
 * provider, matching `ProviderRouter.select()`).
 */
export interface SelfHostedOptions {
  providers?: string;
  providersFile?: string;
  apiKey?: string;
}

let cachedRouter: ProviderRouter | null = null;
let cachedConfigSignature = "";
let failedConfigLoad: string | null = null;

/** Resolve provider config from env/file; caches by content signature. */
export async function loadSelfHostedConfig(
  options: SelfHostedOptions = {}
): Promise<ProviderRouter | null> {
  const providersYaml = options.providers ?? process.env[CONFIG_ENV] ?? undefined;
  const providersFile = options.providersFile ?? process.env[CONFIG_FILE_ENV] ?? undefined;

  if (!providersYaml && !providersFile) return null;

  let source: string;
  if (providersYaml) {
    source = providersYaml;
  } else {
    source = providersFile ? await readFile(providersFile, "utf8") : "";
  }

  const signature = `${providersFile ?? ""}:${source.length}:${source.slice(0, 64)}`;
  if (cachedRouter && cachedConfigSignature === signature) {
    return cachedRouter;
  }

  try {
    const parsed = parseProvidersYaml(source);
    cachedRouter = new ProviderRouter(parsed);
    cachedConfigSignature = signature;
    failedConfigLoad = null;
    return cachedRouter;
  } catch (error) {
    failedConfigLoad = error instanceof Error ? error.message : String(error);
    return null;
  }
}

/**
 * Parse the providers document. Flat `providers:` list (see providerAdapters).
 * Public because tests seed config through it directly.
 */
export function parseProvidersYaml(source: string): { providers: ProviderConfig[] } {
  const document = yaml.load(source) as Record<string, unknown> | undefined;
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("Self-hosted providers config must be a mapping");
  }
  const providers = document.providers;
  if (!Array.isArray(providers)) {
    throw new Error("Self-hosted providers config requires a providers list");
  }
  const parsed = providers.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Self-hosted provider ${index} must be a mapping`);
    }
    const item = value as Record<string, unknown>;
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : undefined;
    const kind = item.kind;
    const baseUrl =
      typeof item.baseUrl === "string" && item.baseUrl.trim() ? item.baseUrl.trim() : undefined;
    const model =
      typeof item.model === "string" && item.model.trim() ? item.model.trim() : undefined;
    if (!id || !baseUrl || !model) {
      throw new Error(`Self-hosted provider ${index} requires id/baseUrl/model`);
    }
    if (!(kind === "openai" || kind === "anthropic" || kind === "local")) {
      throw new Error(`Self-hosted provider ${index} kind must be openai/anthropic/local`);
    }
    const provider: ProviderConfig = {
      id,
      kind,
      baseUrl,
      model,
      ...(typeof item.apiKey === "string" && item.apiKey ? { apiKey: item.apiKey } : {}),
    };
    return provider;
  });
  return { providers: parsed };
}

/** Runtime-only API key check. `null` = no key configured (open route). */
export function resolveSelfHostedApiKey(options: SelfHostedOptions = {}): string | null {
  return options.apiKey ?? process.env[API_KEY_ENV] ?? null;
}

/**
 * Provider id normalized for auto-route matching: strips a leading provider
 * prefix separated by `/` or `::` (e.g. `openai/gpt-4o` or `local::llama3`
 * -> `gpt-4o` / `llama3`), matching the m2 deterministic-routing convention.
 */
export function splitProviderModel(value: unknown): { provider?: string; model?: string } {
  if (typeof value !== "string") return {};
  // `provider/model` (single slash) takes precedence over `provider::model`
  // (double colon) — a `local::llama3` model already contains a colon.
  const slash = value.indexOf("/");
  if (slash !== -1 && slash > 0 && slash < value.length - 1) {
    return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
  }
  const doubleColon = value.indexOf("::");
  if (doubleColon !== -1 && doubleColon > 0 && doubleColon < value.length - 2) {
    return { provider: value.slice(0, doubleColon), model: value.slice(doubleColon + 2) };
  }
  return { model: value };
}

/**
 * Select the provider to route a request to.
 *
 * Precedence (deterministic, documented in the README):
 *  1. `x-omniroute-provider` header (exact provider id) — remote client control.
 *  2. `model` prefix match (`provider/model` or `provider::model`).
 *  3. First configured provider (`ProviderRouter.select()` default).
 */
export function selectSelfHostedProvider(
  router: ProviderRouter,
  request: Request,
  body: { model?: unknown } | null
): ProviderConfig {
  const headerId = request.headers.get(PROVIDER_SELECTOR_HEADER)?.trim();
  if (headerId) {
    try {
      return router.select(headerId);
    } catch {
      // fall through to model-prefix / first-provider resolution
    }
  }
  const { provider } = splitProviderModel(body?.model);
  if (provider) {
    try {
      return router.select(provider);
    } catch {
      // fall through to first-provider resolution
    }
  }
  return router.select(undefined);
}

function buildErrorResponse(statusCode: number, message: string): Response {
  return errorResponse(statusCode, message, { type: "invalid_request_error" });
}

/** Headers echoed on upstream pass-through, plus the routed-by marker. */
function passthroughHeaders(upstream: Headers): Headers {
  const headers = stripSensitiveResponseHeaders(upstream);
  headers.set(ROUTED_BY_HEADER, ROUTED_BY_VALUE);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return headers;
}

/**
 * Normalize an upstream Response into the OpenAI-compatible unified response.
 * Non-2xx upstream bodies are parsed through `parseUpstreamError` + `buildErrorBody`
 * so the client always receives a valid OpenAI-shaped JSON error (Hard Rule #12).
 */
export async function normalizeProviderResponse(upstream: Response): Promise<Response> {
  const headers = passthroughHeaders(upstream.headers);
  if (!upstream.ok) {
    const parsed = await parseUpstreamError(upstream, null);
    const errorBody = buildErrorBody(parsed.statusCode, parsed.message, parsed.responseBody);
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(errorBody), { status: parsed.statusCode, headers });
  }

  if (upstream.body) {
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}

/**
 * Dispatch a chat/completions request to the selected provider through the
 * adapter layer and normalize the upstream response.
 */
export async function completeViaSelfHostedRouter(
  config: SelfHostedOptions,
  request: Request,
  body: Record<string, unknown> | null
): Promise<Response> {
  const router = await loadSelfHostedConfig(config);
  if (!router) {
    const detail = failedConfigLoad ? ` (${failedConfigLoad})` : "";
    return buildErrorResponse(
      500,
      `Self-hosted provider config unavailable${detail}. Set ${CONFIG_ENV} or ${CONFIG_FILE_ENV}.`
    );
  }

  const selected = selectSelfHostedProvider(router, request, body);
  let upstream: Response;
  try {
    // Forward the bare model (provider-prefix stripped) so upstream receives the
    // model name its own contract expects — the prefix (`claude/...`) is a
    // routing concern scoped to the unified entry, not an upstream contract.
    const baseBody = {
      messages: Array.isArray(body?.messages) ? body.messages : [],
      ...(body ?? {}),
    };
    const forwardedBody: ChatRequest =
      typeof body?.model === "string" && splitProviderModel(body.model).provider
        ? { ...baseBody, model: splitProviderModel(body.model).model }
        : baseBody;
    upstream = await router.complete(forwardedBody, selected.id);
  } catch (error) {
    // Network-level failure (connection refused / DNS / TLS) never yields an HTTP
    // status to normalize. Surface the standard OpenAI error shape with a stable
    // message so SDKs fail cleanly instead of throwing on a raw fetch rejection.
    const detail = error instanceof Error ? error.message : String(error);
    return buildErrorResponse(502, `Upstream provider unreachable: ${detail}`);
  }
  return normalizeProviderResponse(upstream);
}

/**
 * Route entry — the full pipeline the /v1/chat/completions divert branch calls.
 *
 * Returns `null` ONLY when no self-hosted provider config is present at all
 * (caller continues with the normal cloud pipeline). When config exists but
 * failed to load/parse, returns a 500 error instead — a misconfigured entry
 * must never silently fall through to cloud routing.
 */
export async function handleSelfHostedCompletions(
  request: Request,
  body: Record<string, unknown> | null,
  options: SelfHostedOptions = {}
): Promise<Response | null> {
  const isConfigured = Boolean(
    options.providers ??
    options.providersFile ??
    process.env[CONFIG_ENV] ??
    process.env[CONFIG_FILE_ENV]
  );
  if (!isConfigured) return null;

  const router = await loadSelfHostedConfig(options);
  if (!router) {
    const detail = failedConfigLoad ? ` (${failedConfigLoad})` : "";
    return buildErrorResponse(
      500,
      `Self-hosted provider config unavailable${detail}. Check ${CONFIG_ENV} or ${CONFIG_FILE_ENV}.`
    );
  }

  const apiKey = resolveSelfHostedApiKey(options);
  if (apiKey) {
    const authHeader = request.headers.get("authorization") ?? "";
    const expected = `Bearer ${apiKey}`;
    if (authHeader !== expected) {
      return errorResponse(401, "Invalid API key", { type: "authentication_error" });
    }
  }

  return completeViaSelfHostedRouter(options, request, body);
}
