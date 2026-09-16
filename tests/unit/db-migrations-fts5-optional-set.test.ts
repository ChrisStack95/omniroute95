import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OPTIONAL_FTS5_MIGRATION_VERSIONS } from "../../src/lib/db/migrationRunner/constants.ts";

const migrationsDir = fileURLToPath(new URL("../../src/lib/db/migrations/", import.meta.url));

test("OptionalFts5Set_CoversEveryMigrationThatTouchesMemoryFts", () => {
  const touching = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .filter((file) =>
      /\bmemory_fts\b/.test(fs.readFileSync(path.join(migrationsDir, file), "utf8"))
    )
    .map((file) => file.slice(0, 3));
  assert.ok(touching.length >= 4, touching.join(","));
  const missing = touching.filter((version) => !OPTIONAL_FTS5_MIGRATION_VERSIONS.has(version));
  assert.deepEqual(
    missing,
    [],
    `migrations that touch memory_fts must be deferred on drivers without FTS5: ${missing.join(", ")}`
  );
});
