import {readdir, readFile} from 'node:fs/promises';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const [summaryPath = 'coverage/coverage-summary.json', rawThreshold = '80'] = process.argv.slice(2);
const threshold = Number(rawThreshold);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coreRoot = join(projectRoot, 'src', 'app', 'core');
const metrics = ['statements', 'branches', 'functions', 'lines'];
const auditedTypeOnlyFiles = new Set([
  'src/app/core/auth/auth.models.ts',
  'src/app/core/models/inspection.models.ts',
  'src/app/core/sync/sync.models.ts',
]);

if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
  throw new Error(`Coverage threshold must be between 0 and 100; received ${rawThreshold}.`);
}

const summary = JSON.parse(await readFile(resolve(projectRoot, summaryPath), 'utf8'));
const measuredFiles = new Map(
  Object.entries(summary)
    .filter(([filePath]) => filePath !== 'total')
    .map(([filePath, coverage]) => [normalizeSourcePath(filePath), coverage]),
);
const requiredCoreFiles = await findRuntimeTypeScriptFiles(coreRoot);
const missingCoreFiles = requiredCoreFiles.filter(filePath => !measuredFiles.has(filePath));
const measuredCoreFiles = requiredCoreFiles
  .map(filePath => [filePath, measuredFiles.get(filePath)])
  .filter(([, coverage]) => coverage);

const reportFailures = metrics.filter(metric => coveragePercent(summary.total?.[metric]) < threshold);
const coreCoverage = Object.fromEntries(
  metrics.map(metric => [metric, aggregateCoverage(measuredCoreFiles, metric)]),
);
const coreFailures = metrics.filter(metric => coveragePercent(coreCoverage[metric]) < threshold);

console.log('Measured coverage report');
for (const metric of metrics) {
  const value = coveragePercent(summary.total?.[metric]);
  console.log(`${metric.padEnd(10)} ${value.toFixed(2)}% (required ${threshold.toFixed(2)}%)`);
}

console.log(`\nCore production logic (${measuredCoreFiles.length}/${requiredCoreFiles.length} files measured)`);
for (const metric of metrics) {
  const value = coveragePercent(coreCoverage[metric]);
  console.log(`${metric.padEnd(10)} ${value.toFixed(2)}% (required ${threshold.toFixed(2)}%)`);
}

const failureReasons = [];
if (missingCoreFiles.length) {
  failureReasons.push(`unmeasured core production files:\n  - ${missingCoreFiles.join('\n  - ')}`);
}
if (reportFailures.length) {
  failureReasons.push(`measured report below threshold: ${reportFailures.join(', ')}`);
}
if (coreFailures.length) {
  failureReasons.push(`core production logic below threshold: ${coreFailures.join(', ')}`);
}

if (failureReasons.length) {
  throw new Error(`Coverage gate failed:\n${failureReasons.join('\n')}`);
}

function normalizeSourcePath(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  const sourceMarker = '/src/';
  const sourceIndex = normalized.lastIndexOf(sourceMarker);

  if (sourceIndex >= 0) {
    return normalized.slice(sourceIndex + 1);
  }

  if (normalized.startsWith('src/')) {
    return normalized;
  }

  return relative(projectRoot, resolve(projectRoot, filePath)).split(sep).join('/');
}

async function findRuntimeTypeScriptFiles(directory) {
  const entries = await readdir(directory, {withFileTypes: true});
  const files = [];

  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findRuntimeTypeScriptFiles(absolutePath));
      continue;
    }

    if (!isRuntimeTypeScriptFile(entry.name)) {
      continue;
    }

    const sourcePath = relative(projectRoot, absolutePath).split(sep).join('/');
    if (!auditedTypeOnlyFiles.has(sourcePath)) {
      files.push(sourcePath);
    }
  }

  return files.sort();
}

function isRuntimeTypeScriptFile(fileName) {
  return fileName.endsWith('.ts')
    && !fileName.endsWith('.spec.ts')
    && !fileName.endsWith('.d.ts');
}

function aggregateCoverage(entries, metric) {
  return entries.reduce(
    (aggregate, [, coverage]) => ({
      covered: aggregate.covered + Number(coverage?.[metric]?.covered ?? 0),
      total: aggregate.total + Number(coverage?.[metric]?.total ?? 0),
    }),
    {covered: 0, total: 0},
  );
}

function coveragePercent(coverage) {
  if (coverage && Number.isFinite(Number(coverage.pct))) {
    return Number(coverage.pct);
  }

  const total = Number(coverage?.total ?? 0);
  const covered = Number(coverage?.covered ?? 0);
  return total === 0 ? 0 : covered / total * 100;
}
