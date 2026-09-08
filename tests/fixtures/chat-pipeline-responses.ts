export function buildOpenAIResponse(text = "ok", model = "gpt-4o-mini", usage = null) {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_json",
      object: "chat.completion",
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      usage: usage || {
        prompt_tokens: 4,
        completion_tokens: 2,
        total_tokens: 6,
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

export function buildOpenAIToolCallResponse({
  model = "gpt-4o-mini",
  toolName = "lookupWeather@1.0.0",
  toolCallId = "call_weather",
  argumentsObject = { location: "Sao Paulo" },
} = {}) {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_tool",
      object: "chat.completion",
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: toolCallId,
                type: "function",
                function: {
                  name: toolName,
                  arguments: JSON.stringify(argumentsObject),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 6,
        completion_tokens: 4,
        total_tokens: 10,
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

export function buildClaudeResponse(text = "ok", model = "claude-3-5-sonnet-20241022") {
  return new Response(
    JSON.stringify({
      id: "msg_json",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 4,
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

export function buildClaudeStreamResponse(
  text = "streamed from claude",
  model = "claude-sonnet-4-6"
) {
  return new Response(
    [
      "event: message_start",
      `data: ${JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_stream",
          type: "message",
          role: "assistant",
          model,
          usage: { input_tokens: 12, output_tokens: 0 },
        },
      })}`,
      "",
      "event: content_block_start",
      `data: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })}`,
      "",
      "event: content_block_delta",
      `data: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      })}`,
      "",
      "event: message_delta",
      `data: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 3 },
      })}`,
      "",
      "event: message_stop",
      `data: ${JSON.stringify({ type: "message_stop" })}`,
      "",
    ].join("\n"),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }
  );
}

export function buildGeminiResponse(text = "ok", model = "gemini-2.5-flash") {
  return new Response(
    JSON.stringify({
      responseId: "resp_gemini",
      modelVersion: model,
      createTime: "2026-04-05T12:00:00.000Z",
      candidates: [
        {
          content: {
            parts: [{ text }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 7,
        totalTokenCount: 12,
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

export function buildOpenAIStreamResponse(text = "streamed from openai") {
  return new Response(
    [
      `data: ${JSON.stringify({
        id: "chatcmpl_stream",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: text } }],
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }
  );
}

export function buildOpenAIResponsesSSE({
  text = "responses streamed from codex",
  model = "gpt-5.1-codex",
  usage = null,
} = {}) {
  return new Response(
    [
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_stream",
          object: "response",
          status: "completed",
          model,
          output: [
            {
              id: "msg_stream",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text, annotations: [] }],
            },
          ],
          usage: usage || {
            input_tokens: 120,
            output_tokens: 30,
            prompt_tokens_details: {
              cached_tokens: 40,
            },
            cache_creation_input_tokens: 11,
            completion_tokens_details: {
              reasoning_tokens: 13,
            },
          },
        },
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }
  );
}

export function buildOpenAIResponsesJson({
  text = "responses compacted from codex",
  model = "gpt-5.5",
  usage = null,
} = {}) {
  return new Response(
    JSON.stringify({
      id: "resp_compact",
      object: "response",
      status: "completed",
      model,
      output: [
        {
          id: "msg_compact",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
      output_text: text,
      usage: usage || {
        input_tokens: 90,
        output_tokens: 15,
        total_tokens: 105,
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}
