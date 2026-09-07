import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

/** Carries an authenticated client address across Next's socket-less boundary. */
export const CLIENT_IP_HEADER = "x-omniroute-client-ip";

function mac(ip: string, token: string): Buffer {
  return createHmac("sha256", token).update(`omniroute-client-ip-v1\n${ip}`).digest();
}

export function stampClientIp(ip: string, token: string | undefined): string | null {
  if (!token || !isIP(ip)) return null;
  return `${ip}|${mac(ip, token).toString("hex")}`;
}

export function resolveClientIpStamp(
  value: string | null,
  token: string | undefined
): string | null {
  if (!value || !token) return null;
  const [ip, signature, ...extra] = value.split("|");
  if (extra.length || !isIP(ip) || !/^[a-f0-9]{64}$/.test(signature || "")) return null;
  const provided = Buffer.from(signature, "hex");
  return timingSafeEqual(provided, mac(ip, token)) ? ip : null;
}
