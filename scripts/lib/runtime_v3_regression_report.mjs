export const REGRESSION_REPORT_SCHEMA = 'vfx-runtime-regression-report@1';
export const DEFAULT_REGRESSION_REPORT = '/tmp/vfx-runtime-v3-regression-report.json';

function sameTime(left, right) {
  return Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right));
}

export function assertRegressionReport(report) {
  if (!report || report.schema !== REGRESSION_REPORT_SCHEMA
    || !/^[a-f0-9]{64}$/.test(report.runtimeFingerprint ?? '')
    || !report.artifactFingerprints || typeof report.artifactFingerprints !== 'object'
    || typeof report.thinPlayer !== 'boolean'
    || !Array.isArray(report.captureTimes) || !report.captureTimes.length
    || report.captureTimes.some((time) => !Number.isFinite(time))
    || !Array.isArray(report.results)) {
    throw new Error('Invalid runtime-v3 regression report');
  }
  for (const result of report.results) {
    if (!result || typeof result.id !== 'string' || !result.id
      || !Number.isFinite(result.captureTime)
      || !['PASS', 'FAIL'].includes(result.status)
      || !Number.isInteger(result.changedPixels) || result.changedPixels < 0
      || !Number.isInteger(result.maxChannelDelta) || result.maxChannelDelta < 0) {
      throw new Error('Invalid runtime-v3 regression result row');
    }
  }
  for (const id of report.requestedIds ?? []) {
    if (!/^[a-f0-9]{64}$/.test(report.artifactFingerprints[id] ?? '')) {
      throw new Error(`Invalid or missing artifact fingerprint for '${id}'`);
    }
  }
  return report;
}

/** An effect passes only when the report has exactly one zero-delta PASS for
 * every requested capture time. Partial output and duplicate rows fail closed. */
export function classifyRegressionReport(report, ids, expectedCaptureTimes, options = {}) {
  assertRegressionReport(report);
  const requireThin = options.requireThin ?? false;
  if (requireThin && !report.thinPlayer) {
    return { passed: [], failed: [...ids], reason: 'report-did-not-exercise-thin-player' };
  }
  const passed = [];
  for (const id of ids) {
    const rows = report.results.filter((row) => row.id === id);
    const complete = expectedCaptureTimes.every((time) => {
      const matches = rows.filter((row) => sameTime(row.captureTime, time));
      return matches.length === 1 && matches[0].status === 'PASS'
        && matches[0].changedPixels === 0 && matches[0].maxChannelDelta === 0;
    }) && rows.length === expectedCaptureTimes.length;
    if (complete) passed.push(id);
  }
  return { passed, failed: ids.filter((id) => !passed.includes(id)) };
}
