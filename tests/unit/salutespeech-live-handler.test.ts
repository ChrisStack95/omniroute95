import test from "node:test";
import assert from "node:assert/strict";

const { openSaluteSpeechLiveRecognition, setSaluteSpeechLiveDependenciesForTests } =
  await import("../../open-sse/handlers/saluteSpeechLive.ts");

test.afterEach(() => setSaluteSpeechLiveDependenciesForTests(null));

test("SaluteSpeech live recognition exchanges managed OAuth credentials and normalizes events", async () => {
  const listeners = new Map();
  const writes = [];
  const metadataValues = [];
  setSaluteSpeechLiveDependenciesForTests({
    fetch: async () =>
      new Response(JSON.stringify({ access_token: "salute-access-token" }), {
        headers: { "content-type": "application/json" },
      }),
    createClient: () => ({
      Recognize(metadata) {
        metadataValues.push(metadata.get("authorization")[0]);
        return {
          write(value) {
            writes.push(value);
            return true;
          },
          end() {},
          cancel() {},
          on(event, listener) {
            listeners.set(event, listener);
            return this;
          },
        };
      },
      close() {},
    }),
  });
  const events = [];
  const recognition = await openSaluteSpeechLiveRecognition({
    credentials: { apiKey: "client-secret", providerSpecificData: { clientId: "client-id" } },
    language: "ru-RU",
    model: "general",
    sampleRate: 16000,
    onResult: (event) => events.push(event),
    onError: () => assert.fail("unexpected provider error"),
    onEnd: () => {},
  });

  listeners.get("data")({
    transcription: {
      eou: false,
      results: [{ normalized_text: "частичный текст", confidence: 0.9 }],
    },
  });
  recognition.writeAudio(Buffer.from([0, 0]));
  recognition.close();

  assert.equal(metadataValues[0], "Bearer salute-access-token");
  assert.deepEqual(events, [{ type: "partial", text: "частичный текст", confidence: 0.9 }]);
  assert.equal(writes[0].options.sample_rate, 16000);
  assert.deepEqual(writes.at(-1), { audio_chunk: Buffer.from([0, 0]) });
});
