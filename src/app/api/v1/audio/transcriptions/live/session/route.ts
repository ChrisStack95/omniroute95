import { z } from "zod";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { getProviderCredentialsWithQuotaPreflight } from "@/sse/services/auth";
import { createLiveSttSession } from "@/lib/liveStt/session";
import { isValidApiKey } from "@/sse/services/auth";

const requestSchema = z.object({
  language: z
    .string()
    .trim()
    .regex(/^[a-z]{2,3}-[A-Z]{2}$/)
    .max(16)
    .default("ru-RU"),
  model: z.enum(["general", "callcenter"]).default("general"),
});

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    },
  });
}

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid live STT session request");

  const origin = request.headers.get("origin");
  if (!origin) return errorResponse(HTTP_STATUS.FORBIDDEN, "Live STT requires an Origin header");
  try {
    new URL(origin);
  } catch {
    return errorResponse(HTTP_STATUS.FORBIDDEN, "Invalid request origin");
  }

  const policy = await enforceApiKeyPolicy(request, `salutespeech/${parsed.data.model}`);
  if (policy.rejection) return policy.rejection;
  if (!policy.apiKey)
    return errorResponse(HTTP_STATUS.UNAUTHORIZED, "API key is required for live transcription");
  if (!(await isValidApiKey(policy.apiKey))) {
    return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  const credentials = await getProviderCredentialsWithQuotaPreflight(
    "salutespeech",
    null,
    policy.apiKeyInfo?.allowedConnections ?? null,
    parsed.data.model
  );
  if (!credentials?.connectionId) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "No active SaluteSpeech connection");
  }

  try {
    const session = await createLiveSttSession({
      apiKeyId: policy.apiKeyInfo?.id ?? null,
      connectionId: credentials.connectionId,
      origin,
      language: parsed.data.language,
      model: parsed.data.model,
    });
    return Response.json({
      url: "/v1/audio/transcriptions/live",
      token: session.token,
      expiresAt: session.expiresAt,
      input: { format: "pcm_s16le", channels: 1, sampleRates: [8000, 16000, 48000] },
    });
  } catch {
    return errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, "Live STT is unavailable");
  }
}
