import { readFileSync, existsSync } from "node:fs";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const CONFIG_PATH = "C:\\Razum_Empire_5.0\\core\\omniroute_config.json";
const RULES_FILE_DEFAULT = "C:\\Razum_Empire_5.0\\core\\omniroute\\providerErrorRules.ts";

interface ConfigShape {
  bound_rules_file?: string;
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

/** Rules module present → operator-declared 429/500 rules are injectable by the engine. */
function rulesBound(cfg: ConfigShape): boolean {
  const rulesPath = cfg.bound_rules_file ?? RULES_FILE_DEFAULT;
  return existsSync(rulesPath);
}

export async function GET() {
  const cfg = readConfig();
  const fallbackEngine =
    cfg.fallback_chains?.enabled && rulesBound(cfg) ? "BOUND_ACTIVE" : "INACTIVE";
  const opexTiering = cfg.opex_tiering?.enforced ? "ENFORCED" : "DISABLED";
  return NextResponse.json(
    { status: "ok", fallback_engine: fallbackEngine, opex_tiering: opexTiering },
    {
      status: 200,
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    }
  );
}