import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDependencyAudit } from '../scripts/lib/dependency-policy.mjs';

const now = Date.parse('2026-10-21T12:00:00Z');
const clean = () => ({version:1,status:'passed',registry:'https://registry.npmjs.org',checkedAtUtc:new Date(now).toISOString(),packageLockSha256:'current-lock',audit:{auditReportVersion:2,vulnerabilities:{},metadata:{vulnerabilities:{info:0,low:0,moderate:0,high:0,critical:0,total:0}}}});

test('release dependency evidence is fresh and bound to the exact lockfile', () => {
  assert.equal(validateDependencyAudit(clean(),'current-lock',now),true);
  assert.throws(()=>validateDependencyAudit(clean(),'changed-lock',now),/Dependencies changed/);
  for(const offset of [-24*60*60_000-1,5*60_000+1]) {const r=clean();r.checkedAtUtc=new Date(now+offset).toISOString();assert.throws(()=>validateDependencyAudit(r,'current-lock',now),/timestamp|stale/);}
  const bad=clean();bad.checkedAtUtc='not-a-date';assert.throws(()=>validateDependencyAudit(bad,'current-lock',now),/timestamp/);
});

test('failed, partial, inconsistent and advisory-bearing registry responses fail closed', () => {
  for(const change of [r=>r.status='failed',r=>r.audit=null,r=>r.audit.error={code:'ENOTFOUND'},r=>r.registry='https://example.test',r=>r.audit.auditReportVersion=1,r=>r.audit.vulnerabilities.example={severity:'high'},r=>delete r.audit.metadata,r=>r.audit.metadata.vulnerabilities.total=1,r=>r.audit.metadata.vulnerabilities.high=1]) {
    const r=clean();change(r);assert.throws(()=>validateDependencyAudit(r,'current-lock',now));
  }
});
