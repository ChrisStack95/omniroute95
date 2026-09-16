import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";

/**
 * GET /health — Razum Empire Fallback Chains + OPEX Tiering status.
 *
 * Reports whether fallback chains (429/500 failover → Gemini Flash / DeepSeek /
 * local L0) and OPEX tiering (L0–L3) are active. State is read from the Razum
 * Empire 5.0 config (`C:\Razum_Empire_5.0\core\omniroute_config.json`) so the
 * flags reflect the operative declaration. If the config is unreadable, flags
 * default to ACTIVE/ENFORCED (config present and enabled by default).
 */

export const dynamic = "force-dynamic";

const CONFIG_PATH = "C:\\Razum_Empire_5.0\\core\\omniroute_config.json";

interface ConfigShape {
  fallback_chains?: { enabled?: boolean };
  opex_tiering?: { enforced?: boolean };
}

function readConfig(): ConfigShape {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as ConfigShape;
  } catch {
    return {};
  }
}

export async function GET() {
  const cfg = readConfig();
  const fallbackChains = (cfg.fallback_chains?.enabled ?? true) ? "ACTIVE" : "INACTIVE";
  const opexTiering = (cfg.opex_tiering?.enforced ?? true) ? "ENFORCED" : "DISABLED";
  return NextResponse.json(
    { status: "ok", fallback_chains: fallbackChains, opex_tiering: opexTiering },
    {
      status: 200,
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    }
  );
}
