const SUBTEST = /^# Subtest:\s+(\S+)/;
const RESULT = /^(ok|not ok)\s+\d+\s+-\s+(\S+)/;

export function fromNodeTestTap(tapText, argvFiles) {
  const completed = [];
  const failed = [];
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
      const file = pending;
      const ok = res[1] === "ok";
      if (file && !seen.has(file)) {
        seen.add(file);
        if (ok) completed.push(file);
        else failed.push(file);
      }
      pending = null;
    }
  }
  const attempted = [...argvFiles];
  const missing = attempted.filter((f) => !seen.has(f));
  return {
    completed,
    attempted,
    missing,
    failed,
    pass: completed.length > 0 && missing.length === 0 && failed.length === 0,
  };
}
