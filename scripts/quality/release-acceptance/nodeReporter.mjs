const SUBTEST = /^# Subtest:\s+(\S+)/;
const RESULT = /^(ok|not ok)\s+\d+\s+-\s+(\S+)/;

export function fromNodeTestTap(tapText, argvFiles) {
  const completed = [];
  const seen = new Set();
  const lines = String(tapText ?? "").split(/\r?\n/);
  let pending = null;
  for (const line of lines) {
    const sub = line.match(SUBTEST);
    if (sub) {
      pending = sub[1];
      continue;
    }
    const res = line.match(RESULT);
    if (res) {
      const file = pending || res[2];
      if (file && !seen.has(file)) {
        completed.push(file);
        seen.add(file);
      }
      pending = null;
    }
  }
  const attempted = [...argvFiles];
  const missing = attempted.filter((f) => !seen.has(f));
  const duplicates = [];
  const counts = new Map();
  for (const f of completed) {
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  for (const [f, n] of counts) {
    if (n > 1) duplicates.push(f);
  }
  return {
    completed,
    attempted,
    missing,
    duplicates,
    pass: completed.length > 0 && missing.length === 0,
  };
}
