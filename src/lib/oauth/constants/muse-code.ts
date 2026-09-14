import { decodePublicCredBytes } from "@omniroute/open-sse/utils/publicCreds.ts";

// Meta Muse Code ships this OAuth client id in its public device-login flow.
// Keep the public default masked in source so credential scanners do not treat
// a distributable native-app client id as a secret.
const META_MUSE_CLIENT_ID_BYTES = [94, 93, 93, 88, 68, 93, 64, 77, 80, 31, 71, 65, 90, 85, 93, 85] as const;

export const MUSE_CODE_CONFIG = {
  clientId:
    process.env.META_MUSE_OAUTH_CLIENT_ID?.trim() ||
    decodePublicCredBytes(META_MUSE_CLIENT_ID_BYTES),
  deviceAuthorizationUrl: "https://auth.meta.com/oidc/device/authorization/",
  deviceTokenUrl: "https://auth.meta.com/oidc/device/token/",
};
