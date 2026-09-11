import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { credentials, loadPackageDefinition, Metadata } from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import type { SaluteSpeechCredentials } from "./saluteSpeechTranscription.ts";

const GRPC_HOST = "smartspeech.sber.ru:443";
const OAUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const OAUTH_SCOPE = "SALUTE_SPEECH_PERS";
const PROTO_PATH = join(process.cwd(), "open-sse", "proto", "salutespeech", "recognitionv2.proto");

export type SaluteSpeechLiveCall = {
  write(value: unknown): boolean;
  end(): void;
  cancel(): void;
  on(event: "data", listener: (response: unknown) => void): SaluteSpeechLiveCall;
  on(event: "error", listener: (error: Error) => void): SaluteSpeechLiveCall;
  on(event: "end", listener: () => void): SaluteSpeechLiveCall;
};

type SaluteSpeechLiveClient = {
  Recognize(metadata: Metadata): SaluteSpeechLiveCall;
  close(): void;
};

type Dependencies = {
  fetch: typeof globalThis.fetch;
  createClient: () => SaluteSpeechLiveClient;
};

function createClient(): SaluteSpeechLiveClient {
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
        v2: { SmartSpeech: new (host: string, sslCredentials: object) => SaluteSpeechLiveClient };
      };
    };
  };
  return new loaded.smartspeech.recognition.v2.SmartSpeech(GRPC_HOST, credentials.createSsl());
}

const defaults: Dependencies = { fetch: globalThis.fetch, createClient };
let dependencies = defaults;

export function setSaluteSpeechLiveDependenciesForTests(
  overrides: Partial<Dependencies> | null
): void {
  dependencies = overrides ? { ...defaults, ...overrides } : defaults;
}

function getClientId(credentialsInput: SaluteSpeechCredentials): string | null {
  const value = credentialsInput.providerSpecificData?.clientId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function getAccessToken(credentialsInput: SaluteSpeechCredentials): Promise<string> {
  const clientId = getClientId(credentialsInput);
  const clientSecret = credentialsInput.apiKey || credentialsInput.accessToken;
  if (!clientId || !clientSecret)
    throw new Error("SaluteSpeech OAuth client ID and secret are required");

  let response: Response;
  try {
    response = await dependencies.fetch(OAUTH_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        RqUID: randomUUID(),
      },
      body: new URLSearchParams({ scope: OAUTH_SCOPE }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("SaluteSpeech authorization is unavailable");
  }
  const payload = (await response.json().catch(() => null)) as { access_token?: unknown } | null;
  if (!response.ok || typeof payload?.access_token !== "string" || !payload.access_token) {
    throw new Error("SaluteSpeech authorization failed");
  }
  return payload.access_token;
}

export async function openSaluteSpeechLiveRecognition(input: {
  credentials: SaluteSpeechCredentials;
  language: string;
  model: "general" | "callcenter";
  sampleRate: 8000 | 16000 | 48000;
  onResult: (result: {
    type: "partial" | "final";
    text: string;
    confidence?: number;
    channel?: number;
    reason?: string;
  }) => void;
  onError: () => void;
  onEnd: () => void;
}): Promise<{ writeAudio(chunk: Buffer): boolean; close(): void }> {
  const token = await getAccessToken(input.credentials);
  const client = dependencies.createClient();
  const metadata = new Metadata();
  metadata.set("authorization", `Bearer ${token}`);
  const call = client.Recognize(metadata);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      call.end();
    } catch {}
    try {
      client.close();
    } catch {}
  };

  call.on("data", (response) => {
    const transcription = (
      response as {
        transcription?: {
          eou?: unknown;
          eou_reason?: unknown;
          channel?: unknown;
          results?: Array<{ normalized_text?: unknown; text?: unknown; confidence?: unknown }>;
        };
      }
    ).transcription;
    const result = transcription?.results?.[0];
    const text =
      typeof result?.normalized_text === "string"
        ? result.normalized_text
        : typeof result?.text === "string"
          ? result.text
          : "";
    if (!text) return;
    input.onResult({
      type: transcription?.eou === true ? "final" : "partial",
      text,
      ...(typeof result?.confidence === "number" ? { confidence: result.confidence } : {}),
      ...(typeof transcription?.channel === "number" ? { channel: transcription.channel } : {}),
      ...(typeof transcription?.eou_reason === "string"
        ? { reason: transcription.eou_reason }
        : {}),
    });
  });
  call.on("error", input.onError);
  call.on("end", input.onEnd);
  call.write({
    options: {
      audio_encoding: "PCM_S16LE",
      sample_rate: input.sampleRate,
      channels_count: 1,
      language: input.language,
      model: input.model,
      hypotheses_count: 1,
      enable_partial_results: { enable: true },
      enable_multi_utterance: { enable: true },
      no_speech_timeout: { seconds: 7 },
      max_speech_timeout: { seconds: 20 },
      normalization_options: {
        enable: { enable: true },
        capitalization: { enable: true },
        punctuation: { enable: true },
      },
    },
  });

  return { writeAudio: (chunk) => call.write({ audio_chunk: chunk }), close };
}
