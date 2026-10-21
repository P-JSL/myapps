import assert from 'node:assert/strict';

/** Advisory evidence is time-limited and bound to the exact resolved lockfile. */
export function validateDependencyAudit(report, packageLockSha256, now = Date.now()) {
  assert.equal(report?.version, 1, 'Unsupported dependency audit evidence');
  assert.equal(report.status, 'passed', 'A successful online dependency audit is required');
  assert.equal(report.registry, 'https://registry.npmjs.org', 'Use the configured official registry');
  assert.equal(report.packageLockSha256, packageLockSha256, 'Dependencies changed since vulnerability audit');
  const timestamp = Date.parse(report.checkedAtUtc);
  assert(Number.isFinite(timestamp) && timestamp <= now + 5 * 60_000 && now - timestamp <= 24 * 60 * 60_000,
    'Dependency audit is stale or has an invalid timestamp; run npm run check:dependencies');
  const audit = report.audit;
  assert.equal(audit?.auditReportVersion, 2, 'Unsupported npm audit response');
  assert(!audit.error && audit.vulnerabilities && Object.keys(audit.vulnerabilities).length === 0, 'Known dependency vulnerabilities must be resolved before packaging');
  const counts = audit.metadata?.vulnerabilities;
  for (const severity of ['info', 'low', 'moderate', 'high', 'critical', 'total']) assert.equal(counts?.[severity], 0, `Unresolved ${severity} dependency vulnerabilities`);
  return true;
}
