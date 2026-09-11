import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { credentials, loadPackageDefinition, Metadata, status } from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";

const DEFAULT_GRPC_HOST = "smartspeech.sber.ru:443";
const DEFAULT_OAUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const DEFAULT_OAUTH_SCOPE = "SALUTE_SPEECH_PERS";
const PROTO_PATH = join(process.cwd(), "open-sse", "proto", "salutespeech", "recognitionv2.proto");
const AUDIO_CHUNK_BYTES = 64 * 1024;

type SaluteSpeechProviderData = Record<string, unknown>;

export type SaluteSpeechCredentials = {
  apiKey?: string;
  accessToken?: string;
  providerSpecificData?: SaluteSpeechProviderData;
};

type GrpcDuplexCall = {
  write(value: unknown): boolean;
  end(): void;
  cancel(): void;
  on(event: "data", listener: (response: unknown) => void): GrpcDuplexCall;
  on(event: "error", listener: (error: Error & { code?: number }) => void): GrpcDuplexCall;
  on(event: "end", listener: () => void): GrpcDuplexCall;
};

type SaluteSpeechClient = {
  Recognize(metadata: Metadata): GrpcDuplexCall;
  close(): void;
};

type TranscriptionDependencies = {
  fetch: typeof globalThis.fetch;
  createClient: (host: string) => SaluteSpeechClient;
};

function getProviderString(data: SaluteSpeechProviderData | undefined, key: string): string | null {
  const value = data?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getAudioEncoding(file: Blob): "MP3" | "FLAC" | "OPUS" | "PCM_S16LE" | null {
  const type = file.type.toLowerCase();
  if (type === "audio/mpeg" || type === "audio/mp3") return "MP3";
  if (type === "audio/flac" || type === "audio/x-flac") return "FLAC";
  if (type === "audio/ogg" || type.includes("opus")) return "OPUS";
  if (type === "audio/l16" || type === "audio/pcm" || type === "audio/s16le") return "PCM_S16LE";
  return null;
}

function resolveSampleRate(formData: FormData, encoding: string): number | undefined {
  if (encoding !== "PCM_S16LE") return undefined;
  const value = formData.get("sample_rate");
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 16_000;
}

function createRecognitionClient(host: string): SaluteSpeechClient {
  const definition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [join(process.cwd(), "node_modules", "protobufjs")],
  });
  const loaded = loadPackageDefinition(definition) as unknown as {
    smartspeech: {
      recognition: {
        v2: { SmartSpeech: new (target: string, sslCredentials: object) => SaluteSpeechClient };
      };
    };
  };
  return new loaded.smartspeech.recognition.v2.SmartSpeech(host, credentials.createSsl());
}

const defaultDependencies: TranscriptionDependencies = {
  fetch: globalThis.fetch,
  createClient: createRecognitionClient,
};

let dependencies = defaultDependencies;

export function setSaluteSpeechTranscriptionDependenciesForTests(
  overrides: Partial<TranscriptionDependencies> | null
) {
  dependencies = overrides ? { ...defaultDependencies, ...overrides } : defaultDependencies;
}

async function getAccessToken(credentialsInput: SaluteSpeechCredentials): Promise<string> {
  const providerData = credentialsInput.providerSpecificData;
  const clientId = getProviderString(providerData, "clientId");
  const clientSecret = credentialsInput.apiKey || credentialsInput.accessToken;
  if (!clientId || !clientSecret) {
    throw new SaluteSpeechError(401, "SaluteSpeech OAuth client ID and secret are required");
  }

  const scope = DEFAULT_OAUTH_SCOPE;
  let response: Response;
  try {
    response = await dependencies.fetch(DEFAULT_OAUTH_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        RqUID: randomUUID(),
      },
      body: new URLSearchParams({ scope }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new SaluteSpeechError(502, "SaluteSpeech authorization is unavailable");
  }

  const payload = (await response.json().catch(() => null)) as { access_token?: unknown } | null;
  if (
    !response.ok ||
    !payload ||
    typeof payload.access_token !== "string" ||
    !payload.access_token
  ) {
    throw new SaluteSpeechError(
      response.status === 401 || response.status === 403 ? 401 : 502,
      response.status === 401 || response.status === 403
        ? "SaluteSpeech authorization failed"
        : "SaluteSpeech authorization is unavailable"
    );
  }

  return payload.access_token;
}

class SaluteSpeechError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

function mapGrpcError(error: Error & { code?: number }): SaluteSpeechError {
  if (error.code === status.UNAUTHENTICATED || error.code === status.PERMISSION_DENIED) {
    return new SaluteSpeechError(401, "SaluteSpeech authorization failed");
  }
  if (error.code === status.INVALID_ARGUMENT) {
    return new SaluteSpeechError(400, "SaluteSpeech rejected the audio request");
  }
  if (error.code === status.RESOURCE_EXHAUSTED) {
    return new SaluteSpeechError(429, "SaluteSpeech rate limit exceeded");
  }
  return new SaluteSpeechError(502, "SaluteSpeech transcription failed");
}

function extractFinalText(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const transcription = (response as { transcription?: unknown }).transcription;
  if (!transcription || typeof transcription !== "object") return null;
  if ((transcription as { eou?: unknown }).eou !== true) return null;
  const result = (transcription as { results?: unknown }).results;
  if (
    !Array.isArray(result) ||
    result.length === 0 ||
    !result[0] ||
    typeof result[0] !== "object"
  ) {
    return null;
  }
  const hypothesis = result[0] as { normalized_text?: unknown; text?: unknown };
  if (typeof hypothesis.normalized_text === "string" && hypothesis.normalized_text.trim()) {
    return hypothesis.normalized_text.trim();
  }
  return typeof hypothesis.text === "string" && hypothesis.text.trim()
    ? hypothesis.text.trim()
    : null;
}

export async function transcribeWithSaluteSpeech({
  file,
  formData,
  modelId,
  credentials: credentialsInput,
}: {
  file: Blob;
  formData: FormData;
  modelId: string | null;
  credentials: SaluteSpeechCredentials;
}): Promise<string> {
  const encoding = getAudioEncoding(file);
  if (!encoding) {
    throw new SaluteSpeechError(
      400,
      "SaluteSpeech supports MP3, FLAC, Opus, and raw PCM S16LE audio"
    );
  }

  const accessToken = await getAccessToken(credentialsInput);
  const providerData = credentialsInput.providerSpecificData;
  const host = DEFAULT_GRPC_HOST;
  const languageValue = formData.get("language");
  const language =
    typeof languageValue === "string" && languageValue.trim() ? languageValue.trim() : "ru-RU";
  const audio = Buffer.from(await file.arrayBuffer());

  return await new Promise<string>((resolve, reject) => {
    const client = dependencies.createClient(host);
    const metadata = new Metadata();
    metadata.set("authorization", `Bearer ${accessToken}`);
    const call = client.Recognize(metadata);
    const results: string[] = [];
    let settled = false;
    const finish = (error?: SaluteSpeechError) => {
      if (settled) return;
      settled = true;
      client.close();
      if (error) reject(error);
      else resolve(results.join(" ").trim());
    };

    call.on("data", (response) => {
      const text = extractFinalText(response);
      if (text) results.push(text);
    });
    call.on("error", (error) => finish(mapGrpcError(error)));
    call.on("end", () => finish());

    call.write({
      options: {
        audio_encoding: encoding,
        sample_rate: resolveSampleRate(formData, encoding),
        channels_count: 1,
        language,
        model: modelId || "general",
        enable_partial_results: { enable: false },
        normalization_options: { enable: { enable: true } },
      },
    });
    for (let offset = 0; offset < audio.length; offset += AUDIO_CHUNK_BYTES) {
      call.write({ audio_chunk: audio.subarray(offset, offset + AUDIO_CHUNK_BYTES) });
    }
    call.end();
  });
}

export function isSaluteSpeechError(error: unknown): error is SaluteSpeechError {
  return error instanceof SaluteSpeechError;
}
