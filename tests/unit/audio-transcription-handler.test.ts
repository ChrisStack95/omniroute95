import test from "node:test";
import assert from "node:assert/strict";

const { handleAudioTranscription } = await import("../../open-sse/handlers/audioTranscription.ts");
const { setSaluteSpeechTranscriptionDependenciesForTests } =
  await import("../../open-sse/handlers/saluteSpeechTranscription.ts");

type ErrorPayload = { error: { message: string } };

async function readErrorPayload(response: Response): Promise<ErrorPayload> {
  return (await response.json()) as ErrorPayload;
}

function buildFile(contents, name, type) {
  return new File([Buffer.from(contents)], name, { type });
}

function immediateTimeout(callback, _ms, ...args) {
  if (typeof callback === "function") callback(...args);
  return 0;
}

function createSaluteSpeechClient(onWrite) {
  const listeners = new Map();
  return {
    Recognize(metadata) {
      const writes = [];
      return {
        write(value) {
          writes.push(value);
          onWrite?.({ metadata, writes, value });
          return true;
        },
        end() {
          listeners.get("data")?.({
            transcription: {
              eou: false,
              results: [{ normalized_text: "partial text" }],
            },
          });
          listeners.get("data")?.({
            transcription: {
              eou: true,
              results: [{ normalized_text: "final transcript" }],
            },
          });
          listeners.get("end")?.();
        },
        cancel() {},
        on(event, listener) {
          listeners.set(event, listener);
          return this;
        },
      };
    },
    close() {},
  };
}

test.afterEach(() => {
  setSaluteSpeechTranscriptionDependenciesForTests(null);
});

test("handleAudioTranscription requires model", async () => {
  const formData = new FormData();
  formData.append("file", buildFile("abc", "audio.wav", "audio/wav"));

  const response = await handleAudioTranscription({ formData, credentials: { apiKey: "x" } });
  const payload = await readErrorPayload(response);

  assert.equal(response.status, 400);
  assert.equal(payload.error.message, "model is required");
});

test("handleAudioTranscription requires a file upload", async () => {
  const formData = new FormData();
  formData.append("model", "openai/whisper-1");

  const response = await handleAudioTranscription({ formData, credentials: { apiKey: "x" } });
  const payload = await readErrorPayload(response);

  assert.equal(response.status, 400);
  assert.equal(payload.error.message, "file is required");
});

test("handleAudioTranscription proxies OpenAI-compatible multipart requests and forwards optional params", async () => {
  const originalFetch = globalThis.fetch;
  let captured;

  globalThis.fetch = async (url, options = {}) => {
    captured = {
      url: String(url),
      headers: options.headers,
      body: options.body,
    };

    return new Response(JSON.stringify({ text: "hello" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const formData = new FormData();
    formData.append("model", "openai/whisper-1");
    formData.append("file", buildFile("abc", "clip.webm", "audio/webm"));
    formData.append("language", "pt");
    formData.append("prompt", "meeting");
    formData.append("response_format", "verbose_json");
    formData.append("temperature", "0.1");
    formData.append("timestamp_granularities[]", "word");

    const response = await handleAudioTranscription({
      formData,
      credentials: { apiKey: "openai-key" },
    });

    assert.equal(response.status, 200);
    assert.equal(captured.url, "https://api.openai.com/v1/audio/transcriptions");
    assert.equal(captured.headers.Authorization, "Bearer openai-key");
    assert.ok(captured.body instanceof Uint8Array);
    assert.match(captured.headers["Content-Type"], /^multipart\/form-data; boundary=/);

    const bodyText = new TextDecoder().decode(captured.body);
    assert.ok(bodyText.includes('name="model"'));
    assert.ok(bodyText.includes("whisper-1"));
    assert.ok(bodyText.includes('name="language"'));
    assert.ok(bodyText.includes("pt"));
    assert.ok(bodyText.includes('name="prompt"'));
    assert.ok(bodyText.includes("meeting"));
    assert.ok(bodyText.includes('name="response_format"'));
    assert.ok(bodyText.includes("verbose_json"));
    assert.ok(bodyText.includes('name="temperature"'));
    assert.ok(bodyText.includes("0.1"));
    assert.ok(bodyText.includes('name="timestamp_granularities[]"'));
    assert.ok(bodyText.includes("word"));
    assert.ok(bodyText.includes('name="file"'));
    assert.ok(bodyText.includes('filename="clip.webm"'));
    assert.deepEqual(await response.json(), { text: "hello" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleAudioTranscription routes Deepgram with binary upload and language passthrough", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl;
  let capturedHeaders;
  let capturedBody;

  globalThis.fetch = async (url, options = {}) => {
    capturedUrl = String(url);
    capturedHeaders = options.headers;
    capturedBody = options.body;

    return new Response(
      JSON.stringify({
        results: {
          channels: [{ alternatives: [{ transcript: "ola mundo" }] }],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const formData = new FormData();
    formData.append("model", "deepgram/nova-3");
    formData.append("file", buildFile("abc", "clip.mp4", "video/mp4"));
    formData.append("language", "pt-BR");

    const response = await handleAudioTranscription({
      formData,
      credentials: { apiKey: "dg-key" },
    });
    const payload = await readErrorPayload(response);

    const url = new URL(capturedUrl);
    assert.equal(url.origin + url.pathname, "https://api.deepgram.com/v1/listen");
    assert.equal(url.searchParams.get("model"), "nova-3");
    assert.equal(url.searchParams.get("language"), "pt-BR");
    assert.equal(url.searchParams.get("detect_language"), null);
    assert.equal(capturedHeaders.Authorization, "Token dg-key");
    assert.equal(capturedHeaders["Content-Type"], "audio/mp4");
    assert.ok(capturedBody instanceof ArrayBuffer);
    assert.deepEqual(payload, { text: "ola mundo", noSpeechDetected: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleAudioTranscription marks noSpeechDetected when Deepgram returns no transcript", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        results: {
          channels: [{ alternatives: [{ transcript: "" }] }],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  try {
    const formData = new FormData();
    formData.append("model", "deepgram/nova-3");
    formData.append("file", buildFile("abc", "clip.wav", "audio/wav"));

    const response = await handleAudioTranscription({
      formData,
      credentials: { apiKey: "dg-key" },
    });

    assert.deepEqual(await response.json(), { text: "", noSpeechDetected: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleAudioTranscription normalizes Nvidia responses to text", async () => {
  const originalFetch = globalThis.fetch;
  let captured;

  globalThis.fetch = async (_url, options = {}) => {
    captured = {
      headers: options.headers,
      body: options.body,
    };

    return new Response(JSON.stringify({ transcript: "nvidia text" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    for (const [requestModel, upstreamModel] of [
      ["nvidia/nvidia/parakeet-ctc-1.1b-asr", "nvidia/parakeet-ctc-1.1b-asr"],
      ["nvidia/openai/whisper-large-v3", "openai/whisper-large-v3"],
    ]) {
      const formData = new FormData();
      formData.append("model", requestModel);
      formData.append("file", buildFile("abc", "clip.wav", "audio/wav"));

      const response = await handleAudioTranscription({
        formData,
        credentials: { apiKey: "nvidia-key" },
      });

      assert.equal(captured.headers.Authorization, "Bearer nvidia-key");
      assert.ok(captured.body instanceof Uint8Array);
      assert.match(captured.headers["Content-Type"], /^multipart\/form-data; boundary=/);

      const bodyText = new TextDecoder().decode(captured.body);
      assert.ok(bodyText.includes('name="file"'));
      assert.ok(bodyText.includes('filename="clip.wav"'));
      assert.ok(bodyText.includes('name="model"'));
      assert.ok(bodyText.includes(upstreamModel));
      assert.deepEqual(await response.json(), { text: "nvidia text" });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleAudioTranscription rejects invalid HuggingFace model paths", async () => {
  const formData = new FormData();
  formData.append("model", "huggingface/../escape");
  formData.append("file", buildFile("abc", "clip.wav", "audio/wav"));

  const response = await handleAudioTranscription({
    formData,
    credentials: { apiKey: "hf-key" },
  });
  const payload = await readErrorPayload(response);

  assert.equal(response.status, 400);
  assert.equal(payload.error.message, "Invalid model ID");
});

test("handleAudioTranscription requires credentials for authenticated providers", async () => {
  const formData = new FormData();
  formData.append("model", "openai/whisper-1");
  formData.append("file", buildFile("abc", "clip.wav", "audio/wav"));

  const response = await handleAudioTranscription({ formData, credentials: null });
  const payload = await readErrorPayload(response);

  assert.equal(response.status, 401);
  assert.equal(payload.error.message, "No credentials for transcription provider: openai");
});

test("handleAudioTranscription routes AssemblyAI uploads and polls until completion", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const calls = [];

  globalThis.setTimeout = immediateTimeout;
  globalThis.fetch = async (url, options = {}) => {
    const stringUrl = String(url);
    calls.push({ url: stringUrl, method: options?.method || "GET" });

    if (stringUrl === "https://api.assemblyai.com/v2/upload") {
      assert.ok(options.body instanceof ArrayBuffer);
      return new Response(JSON.stringify({ upload_url: "https://upload.example.com/audio.wav" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (stringUrl === "https://api.assemblyai.com/v2/transcript") {
      const payload = JSON.parse(String(options.body || "{}"));
      assert.deepEqual(payload, {
        audio_url: "https://upload.example.com/audio.wav",
        speech_models: ["universal-3-pro"],
        language_detection: true,
      });
      return new Response(JSON.stringify({ id: "transcript-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (stringUrl === "https://api.assemblyai.com/v2/transcript/transcript-1") {
      return new Response(JSON.stringify({ status: "completed", text: "assembly result" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`Unexpected URL: ${stringUrl}`);
  };

  try {
    const formData = new FormData();
    formData.append("model", "assemblyai/universal-3-pro");
    formData.append("file", buildFile("abc", "clip.wav", "audio/wav"));

    const response = await handleAudioTranscription({
      formData,
      credentials: { apiKey: "assembly-key" },
    });

    assert.deepEqual(await response.json(), { text: "assembly result" });
    assert.deepEqual(
      calls.map((entry) => entry.url),
      [
        "https://api.assemblyai.com/v2/upload",
        "https://api.assemblyai.com/v2/transcript",
        "https://api.assemblyai.com/v2/transcript/transcript-1",
      ]
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("handleAudioTranscription returns an error when AssemblyAI reports a terminal failure", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;

  globalThis.setTimeout = immediateTimeout;
  globalThis.fetch = async (url) => {
    const stringUrl = String(url);

    if (stringUrl === "https://api.assemblyai.com/v2/upload") {
      return new Response(JSON.stringify({ upload_url: "https://upload.example.com/audio.wav" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (stringUrl === "https://api.assemblyai.com/v2/transcript") {
      return new Response(JSON.stringify({ id: "transcript-2" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (stringUrl === "https://api.assemblyai.com/v2/transcript/transcript-2") {
      return new Response(JSON.stringify({ status: "error", error: "corrupt audio payload" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`Unexpected URL: ${stringUrl}`);
  };

  try {
    const formData = new FormData();
    formData.append("model", "assemblyai/universal-2");
    formData.append("file", buildFile("abc", "clip.wav", "audio/wav"));

    const response = await handleAudioTranscription({
      formData,
      credentials: { apiKey: "assembly-key" },
    });
    const payload = await readErrorPayload(response);

    assert.equal(response.status, 500);
    assert.equal(payload.error.message, "corrupt audio payload");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("handleAudioTranscription routes HuggingFace providers with raw audio uploads", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl;
  let capturedHeaders;
  let capturedBody;

  globalThis.fetch = async (url, options = {}) => {
    capturedUrl = String(url);
    capturedHeaders = options.headers;
    capturedBody = options.body;

    return new Response(JSON.stringify({ text: "huggingface transcript" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const formData = new FormData();
    formData.append("model", "huggingface/openai/whisper-large-v3");
    formData.append("file", buildFile("abc", "clip.mp3", "audio/mpeg"));

    const response = await handleAudioTranscription({
      formData,
      credentials: { apiKey: "hf-key" },
    });

    assert.equal(
      capturedUrl,
      "https://api-inference.huggingface.co/models/openai/whisper-large-v3"
    );
    assert.equal(capturedHeaders.Authorization, "Bearer hf-key");
    assert.equal(capturedHeaders["Content-Type"], "audio/mpeg");
    assert.ok(capturedBody instanceof ArrayBuffer);
    assert.deepEqual(await response.json(), { text: "huggingface transcript" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleAudioTranscription exchanges SaluteSpeech OAuth credentials and returns the final transcript", async () => {
  const oauthCalls = [];
  const grpcWrites = [];
  setSaluteSpeechTranscriptionDependenciesForTests({
    fetch: async (url, options = {}) => {
      oauthCalls.push({ url: String(url), options });
      return new Response(JSON.stringify({ access_token: "salute-access-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    createClient: (host) => {
      assert.equal(host, "smartspeech.sber.ru:443");
      return createSaluteSpeechClient(({ metadata, writes }) => {
        grpcWrites.push({
          authorization: metadata.get("authorization")[0],
          writes: [...writes],
        });
      });
    },
  });

  const formData = new FormData();
  formData.append("model", "salutespeech/general");
  formData.append("language", "ru-RU");
  formData.append("file", buildFile("audio-bytes", "clip.mp3", "audio/mpeg"));

  const response = await handleAudioTranscription({
    formData,
    credentials: {
      apiKey: "salute-client-secret",
      providerSpecificData: { clientId: "salute-client-id" },
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: "final transcript" });
  assert.equal(oauthCalls.length, 1);
  assert.equal(oauthCalls[0].url, "https://ngw.devices.sberbank.ru:9443/api/v2/oauth");
  assert.equal(
    oauthCalls[0].options.headers.Authorization,
    `Basic ${Buffer.from("salute-client-id:salute-client-secret").toString("base64")}`
  );
  assert.equal(oauthCalls[0].options.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(String(oauthCalls[0].options.body), "scope=SALUTE_SPEECH_PERS");
  assert.equal(grpcWrites.at(-1).authorization, "Bearer salute-access-token");
  assert.deepEqual(grpcWrites[0].writes[0], {
    options: {
      audio_encoding: "MP3",
      sample_rate: undefined,
      channels_count: 1,
      language: "ru-RU",
      model: "general",
      enable_partial_results: { enable: false },
      normalization_options: { enable: { enable: true } },
    },
  });
  assert.deepEqual(grpcWrites.at(-1).writes.at(-1), {
    audio_chunk: Buffer.from("audio-bytes"),
  });
});

test("handleAudioTranscription rejects unsupported SaluteSpeech audio formats before authorization", async () => {
  let called = false;
  setSaluteSpeechTranscriptionDependenciesForTests({
    fetch: async () => {
      called = true;
      return new Response();
    },
  });
  const formData = new FormData();
  formData.append("model", "salutespeech/general");
  formData.append("file", buildFile("audio-bytes", "clip.wav", "audio/wav"));

  const response = await handleAudioTranscription({
    formData,
    credentials: {
      apiKey: "salute-client-secret",
      providerSpecificData: { clientId: "salute-client-id" },
    },
  });
  const payload = await readErrorPayload(response);

  assert.equal(response.status, 400);
  assert.equal(
    payload.error.message,
    "SaluteSpeech supports MP3, FLAC, Opus, and raw PCM S16LE audio"
  );
  assert.equal(called, false);
});

test("handleAudioTranscription rejects unsupported providers", async () => {
  const formData = new FormData();
  formData.append("model", "unknown/provider");
  formData.append("file", buildFile("abc", "clip.wav", "audio/wav"));

  const response = await handleAudioTranscription({
    formData,
    credentials: { apiKey: "x" },
  });
  const payload = await readErrorPayload(response);

  assert.equal(response.status, 400);
  assert.match(
    payload.error.message,
    /No transcription provider found for model "unknown\/provider"/
  );
});

test("handleAudioTranscription surfaces parsed upstream errors for OpenAI-compatible providers", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "too many requests" } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });

  try {
    const formData = new FormData();
    formData.append("model", "openai/whisper-1");
    formData.append("file", buildFile("abc", "clip.wav", "audio/wav"));

    const response = await handleAudioTranscription({
      formData,
      credentials: { apiKey: "openai-key" },
    });
    const payload = await readErrorPayload(response);

    assert.equal(response.status, 429);
    assert.equal(payload.error.message, "too many requests");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleAudioTranscription returns a 500 when upstream fetch throws", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    throw new Error("network timeout");
  };

  try {
    const formData = new FormData();
    formData.append("model", "openai/whisper-1");
    formData.append("file", buildFile("abc", "clip.wav", "audio/wav"));

    const response = await handleAudioTranscription({
      formData,
      credentials: { apiKey: "openai-key" },
    });
    const payload = await readErrorPayload(response);

    assert.equal(response.status, 500);
    assert.equal(payload.error.message, "Transcription request failed: network timeout");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("buildMultipartBody produces valid multipart with correct boundary", async () => {
  const { buildMultipartBody } = await import("../../open-sse/handlers/audioTranscription.ts");
  const file = new File([Buffer.from("hello")], "audio.wav", { type: "audio/wav" });
  const { body, contentType } = await buildMultipartBody(file, {
    model: "whisper-1",
    language: "en",
  });

  assert.ok(body instanceof Uint8Array);
  assert.match(contentType, /^multipart\/form-data; boundary=/);

  const boundary = contentType.split("boundary=")[1];
  const bodyText = new TextDecoder().decode(body);

  assert.ok(bodyText.startsWith("--" + boundary));
  assert.ok(bodyText.endsWith("--" + boundary + "--\r\n"));
  assert.ok(bodyText.includes('name="model"'));
  assert.ok(bodyText.includes("whisper-1"));
  assert.ok(bodyText.includes('name="language"'));
  assert.ok(bodyText.includes("en"));
  assert.ok(bodyText.includes('name="file"'));
  assert.ok(bodyText.includes('filename="audio.wav"'));
  assert.ok(bodyText.includes("Content-Type: audio/wav"));
  assert.ok(bodyText.includes("hello"));
});

test("buildMultipartBody sanitizes filename with quotes and newlines", async () => {
  const { buildMultipartBody } = await import("../../open-sse/handlers/audioTranscription.ts");
  const rawName = 'bad"name\r\n.wav';
  const file = new File([Buffer.from("x")], rawName, { type: "audio/wav" });
  const { body } = await buildMultipartBody(file, { model: "test" });

  const bodyText = new TextDecoder().decode(body);
  assert.ok(bodyText.includes('filename="bad_name__.wav"'));
  assert.ok(!bodyText.includes(rawName));
});

test("buildMultipartBody defaults to audio.wav for unnamed files", async () => {
  const { buildMultipartBody } = await import("../../open-sse/handlers/audioTranscription.ts");
  const file = new File([Buffer.from("x")], "", { type: "audio/wav" });
  const { body } = await buildMultipartBody(file, { model: "test" });

  const bodyText = new TextDecoder().decode(body);
  assert.ok(bodyText.includes('filename="audio.wav"'));
});

test("buildMultipartBody uses application/octet-stream for unknown MIME types", async () => {
  const { buildMultipartBody } = await import("../../open-sse/handlers/audioTranscription.ts");
  const file = new File([Buffer.from("x")], "data.bin", { type: "" });
  const { body } = await buildMultipartBody(file, { model: "test" });

  const bodyText = new TextDecoder().decode(body);
  assert.ok(bodyText.includes("Content-Type: application/octet-stream"));
});
