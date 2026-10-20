// Read-only, offline admission check for two ECR CLI JSON responses fetched by
// immutable digest. Fetching or scanning an image is a separate approved step.
const assert = require('node:assert/strict');
const fs = require('node:fs');

function timestamp(value) {
  const parsed = typeof value === 'number' ? value * 1000 : Date.parse(value);
  assert(Number.isFinite(parsed), 'scan or push timestamp missing');
  return parsed;
}

function verify(digest, repository, imageResponse, scanResponse) {
  assert(/^sha256:[a-f0-9]{64}$/.test(digest), 'exact image digest required');
  assert(/^[a-z0-9._/-]+$/.test(repository), 'repository name required');
  assert(!imageResponse.nextToken && !scanResponse.nextToken && !scanResponse.imageScanFindings?.nextToken,
    'paginated image metadata or scan findings are incomplete');
  const details = imageResponse.imageDetails;
  assert(Array.isArray(details) && details.length === 1, 'one exact image detail required');
  assert.equal(details[0].repositoryName, repository);
  assert.equal(details[0].imageDigest, digest);
  assert.equal(scanResponse.repositoryName, repository);
  assert.equal(scanResponse.imageId?.imageDigest, digest);
  assert.equal(scanResponse.imageScanStatus?.status, 'COMPLETE', 'exact image scan incomplete');
  const scan = scanResponse.imageScanFindings;
  assert(scan && Array.isArray(scan.findings) && scan.findingSeverityCounts && typeof scan.findingSeverityCounts === 'object', 'complete findings and severity counts required');
  assert(timestamp(scan.imageScanCompletedAt) >= timestamp(details[0].imagePushedAt), 'scan predates immutable image push');
  for (const severity of ['CRITICAL', 'HIGH']) {
    assert.equal(scan.findingSeverityCounts[severity] || 0, 0, `${severity} findings remain`);
    assert(!scan.findings.some(row => row.severity === severity), `${severity} finding present despite summary`);
  }
  return { status: 'PASS_EXACT_DIGEST_SCAN', repository, digest, scanCompletedAt: scan.imageScanCompletedAt,
    critical: 0, high: 0, findings: scan.findings.length };
}

if (require.main === module) {
  try {
    const [digest, repository, detailsFile, findingsFile] = process.argv.slice(2);
    assert(digest && repository && detailsFile && findingsFile, 'usage: verify-alpine-amd64-scan.cjs <digest> <repository> <describe-images.json> <describe-image-scan-findings.json>');
    const result = verify(digest, repository, JSON.parse(fs.readFileSync(detailsFile, 'utf8')), JSON.parse(fs.readFileSync(findingsFile, 'utf8')));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ status: 'HOLD', reason: error.message }));
    process.exitCode = 1;
  }
}

module.exports = { verify };
