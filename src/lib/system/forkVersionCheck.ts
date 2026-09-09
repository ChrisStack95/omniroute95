import { z } from "zod";

const REPOSITORY = "fenix007/OmniRoute";
const API_BASE = `https://api.github.com/repos/${REPOSITORY}`;
export const FORK_UPDATE_MESSAGE =
  "Update this maintained fork by deploying its published Docker image.";

const publishedRunsSchema = z.object({
  workflow_runs: z.array(
    z.object({
      id: z.number().int().positive(),
      head_sha: z.string().regex(/^[a-f0-9]{40}$/),
      head_branch: z.literal("stable"),
      status: z.literal("completed"),
      conclusion: z.literal("success"),
    })
  ),
});
const comparisonSchema = z.object({
  status: z.enum(["ahead", "behind", "identical", "diverged"]),
});

export function getForkBuildVersion(): string | null {
  return process.env.NEXT_PUBLIC_OMNIROUTE_FORK_VERSION?.trim() || null;
}

function getBuildRef(version: string): string | null {
  const sha = /^fork · sha-([a-f0-9]{7,40})$/.exec(version);
  if (sha) return sha[1];
  return /^v?\d+\.\d+\.\d+-fork\.\d+$/.test(version) ? version : null;
}

let cachedCheck:
  | { current: string; expiresAt: number; result: ReturnType<typeof lookupForkVersionInfo> }
  | undefined;

export function resolveForkVersionInfo(current: string, fetchImpl?: typeof fetch) {
  if (fetchImpl) return lookupForkVersionInfo(current, fetchImpl);
  // The version route is force-dynamic. Cache the complete check here, including
  // in-flight requests and outages, instead of relying on Next's fetch cache.
  if (cachedCheck?.current === current && cachedCheck.expiresAt > Date.now()) {
    return cachedCheck.result;
  }
  const result = lookupForkVersionInfo(current, fetch);
  cachedCheck = { current, expiresAt: Date.now() + 300_000, result };
  return result;
}

async function lookupForkVersionInfo(current: string, fetchImpl: typeof fetch) {
  const unavailable = {
    current,
    latest: "unavailable",
    updateAvailable: false,
    channel: "fork",
    autoUpdateSupported: false,
    autoUpdateError: FORK_UPDATE_MESSAGE,
    news: null,
    checkStatus: "unavailable",
  };
  const currentRef = getBuildRef(current);
  if (!currentRef) return unavailable;

  const get = async (path: string) => {
    const response = await fetchImpl(`${API_BASE}/${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "omniroute-fork-version-check",
      },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Fork version lookup unavailable");
    return response.json();
  };

  try {
    // A stable branch commit is deployable only after both image builds and
    // manifest publication succeed. Never advertise a pending or failed build.
    const runs = publishedRunsSchema.parse(
      await get(
        "actions/workflows/fork-image-fenix007.yml/runs?branch=stable&status=success&per_page=1"
      )
    );
    const latestRun = runs.workflow_runs[0];
    if (!latestRun) return unavailable;

    let updateAvailable = false;
    if (!latestRun.head_sha.startsWith(currentRef)) {
      const comparison = comparisonSchema.parse(
        await get(`compare/${encodeURIComponent(currentRef)}...${latestRun.head_sha}?per_page=1`)
      );
      // A different SHA alone does not imply an upgrade (rollbacks, newer local
      // builds and diverged branches must not produce a downgrade notification).
      updateAvailable = comparison.status === "ahead";
    }

    const latest = `sha-${latestRun.head_sha.slice(0, 7)}`;
    return {
      ...unavailable,
      latest,
      latestLabel: `fork · ${latest}`,
      releaseUrl: `https://github.com/${REPOSITORY}/actions/runs/${latestRun.id}`,
      updateAvailable,
      checkStatus: "ok",
    };
  } catch {
    // Registry/GitHub outages must never fall back to an upstream npm release.
    return unavailable;
  }
}
