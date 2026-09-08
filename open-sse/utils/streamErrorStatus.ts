type StreamErrorStatusKind = "rate_limit" | "authentication" | "permission" | "client" | "server";

type StreamErrorStatusMapping = {
  responses: {
    type: string;
    code: string;
  };
  claude: {
    type: string;
  };
};

function getStreamErrorStatusKind(statusCode: number): StreamErrorStatusKind {
  if (statusCode === 429) return "rate_limit";
  if (statusCode === 401) return "authentication";
  if (statusCode === 403) return "permission";
  if (statusCode >= 400 && statusCode < 500) return "client";
  return "server";
}

export function getStreamErrorStatusMapping(statusCode: number): StreamErrorStatusMapping {
  switch (getStreamErrorStatusKind(statusCode)) {
    case "rate_limit":
      return {
        responses: { type: "rate_limit_error", code: "rate_limit_exceeded" },
        claude: { type: "rate_limit_error" },
      };
    case "authentication":
      return {
        responses: { type: "authentication_error", code: "invalid_authentication" },
        claude: { type: "authentication_error" },
      };
    case "permission":
      return {
        responses: { type: "authentication_error", code: "permission_denied" },
        claude: { type: "permission_error" },
      };
    case "client":
      return {
        responses: { type: "invalid_request_error", code: "bad_request" },
        claude: { type: "invalid_request_error" },
      };
    case "server":
      return {
        responses: { type: "server_error", code: "server_error" },
        claude: { type: "api_error" },
      };
    default:
      return {
        responses: { type: "server_error", code: "server_error" },
        claude: { type: "api_error" },
      };
  }
}
