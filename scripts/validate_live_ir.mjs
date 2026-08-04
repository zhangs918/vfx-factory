import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runtimeFingerprint } from './runtime_fingerprint.mjs';

const root = path.resolve(import.meta.dirname, '..');
const assetRoot = path.join(root, 'public/assets/quarks');
const manifest = JSON.parse(fs.readFileSync(path.join(assetRoot, 'manifest.json'), 'utf8'));
const failures = [];
const adapterRegistryPath = path.join(root, 'config/semantic-adapters.json');
const adapterRegistryRaw = fs.readFileSync(adapterRegistryPath);
const adapterRegistry = JSON.parse(adapterRegistryRaw);
const adapterRegistryHash = crypto.createHash('sha256').update(adapterRegistryRaw).digest('hex');
const runtimeHash = runtimeFingerprint(root);
const adapters = new Map(adapterRegistry.adapters.map((adapter) => [`${adapter.id}@${adapter.version}`, adapter]));

for (const entry of manifest.effects ?? []) {
  const file = path.join(assetRoot, entry.file);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const textures = new Map((json.textures ?? []).map((texture) => [texture.uuid, texture]));
  const ir = json.vfxIR;
  if (ir?.representation !== 'live-particles@1') failures.push(`${entry.id}: production representation is not live-particles@1`);
  if (ir?.schema !== 'unity-vfx-ir@1' || ir?.policy !== 'strict') failures.push(`${entry.id}: missing strict unity-vfx-ir@1 contract`);
  const lifecycle = ir?.lifecycle;
  if (lifecycle?.schema !== 'effect-lifecycle@1'
      || lifecycle.rootLoopPolicy !== 'one-shot'
      || lifecycle.terminalAction !== 'stop-and-clear'
      || lifecycle.timeDomain !== 'unity-root-fixed-step@60hz'
      || !(Number(lifecycle.terminalTime) > 0)
      || lifecycle.terminalTime > Math.max(...(ir?.captureTimes ?? []), 0) + 1e-6) {
    failures.push(`${entry.id}: missing valid one-shot effect-lifecycle@1 contract`);
  }
  if ((ir?.diagnostics ?? []).some((d) => d.severity === 'error')) failures.push(`${entry.id}: live IR contains error diagnostics`);
  if (!['live', 'hybrid-live'].includes(ir?.editability?.simulation) || ir?.editability?.material !== 'live-ir') {
    failures.push(`${entry.id}: missing explicit editability contract`);
  }
  if (![
    'calibrated-spawn-state@1',
    'calibrated-spawn-state+schedule@1',
    'deterministic-random-lanes@1',
  ].includes(ir?.editability?.spawnInitialization)) {
    failures.push(`${entry.id}: undeclared spawn initialization semantics`);
  }
  for (const material of json.materials ?? []) {
    if ('cfxr' in material) failures.push(`${entry.id}/${material.name}: legacy property-guess block is present`);
    const program = material.vfxProgram;
    if (program?.schema !== 'particle-material-program@2') failures.push(`${entry.id}/${material.name}: missing material program`);
    if (program?.lowering !== 'verified-supported-subset') {
      const adapter = adapters.get(program?.lowering);
      if (!adapter || adapter.kind !== 'material' || adapter.sourceGraphHash !== program?.sourceGraphHash) {
        failures.push(`${entry.id}/${material.name}: manual lowering/hash pair was not reviewed`);
      }
    }
    if (!program?.sourceGraphHash) failures.push(`${entry.id}/${material.name}: missing source graph fingerprint`);
    const mainTexture = textures.get(program?.mainTexture);
    if (mainTexture && !['input', 'grayscale', 'none'].includes(mainTexture.alphaSource)) {
      failures.push(`${entry.id}/${material.name}: missing/invalid TextureImporter alpha source`);
    }
    if (mainTexture?.alphaSource === 'grayscale' && program?.coverageSource === 'alpha') {
      failures.push(`${entry.id}/${material.name}: grayscale-generated Unity alpha was not lowered to scalar coverage`);
    }
    for (const operation of program?.operations ?? []) {
      if (operation?.op === 'dynamic-alpha-clip'
          && ![
            'custom1.x', 'custom1.y', 'custom1.z', 'custom1.w',
            'uv1.x', 'uv1.y',
          ].includes(operation.source)) {
        failures.push(`${entry.id}/${material.name}: invalid dynamic alpha clip source '${operation.source}'`);
      }
    }
  }
  const attestationFile = path.join(assetRoot, 'attestations', `${entry.id}.json`);
  if (!fs.existsSync(attestationFile)) {
    failures.push(`${entry.id}: missing oracle promotion attestation`);
  } else {
    const attestation = JSON.parse(fs.readFileSync(attestationFile, 'utf8'));
    const assetHash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (attestation.schema !== 'live-ir-promotion@1' || attestation.passed !== true)
      failures.push(`${entry.id}: invalid/failed promotion attestation`);
    if (attestation.assetSha256 !== assetHash)
      failures.push(`${entry.id}: promotion attestation is stale for asset`);
    if (attestation.adapterRegistrySha256 !== adapterRegistryHash)
      failures.push(`${entry.id}: promotion attestation is stale for adapter registry`);
    if (attestation.runtimeSha256 !== runtimeHash)
      failures.push(`${entry.id}: promotion attestation is stale for WebGL runtime`);
  }
}

const oracleRoot = path.join(assetRoot, 'oracles');
if (fs.existsSync(oracleRoot)) {
  for (const name of fs.readdirSync(oracleRoot).filter((candidate) => candidate.endsWith('.json'))) {
    const oracle = JSON.parse(fs.readFileSync(path.join(oracleRoot, name), 'utf8'));
    if (oracle.vfxIR?.representation !== 'camera-baked@1') failures.push(`${name}: oracle is not camera-baked@1`);
  }
}
if ((manifest.effects ?? []).some((entry) => entry.file.includes('oracle'))) {
  failures.push('oracle leaked into production manifest');
}
for (const name of fs.readdirSync(assetRoot).filter((candidate) => candidate.endsWith('.json'))) {
  const json = JSON.parse(fs.readFileSync(path.join(assetRoot, name), 'utf8'));
  if (json.vfxIR?.representation === 'camera-baked@1') {
    failures.push(`${name}: camera-baked asset must live under oracles/, never the production asset root`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Validated ${(manifest.effects ?? []).length} strict live effect(s); camera-baked assets are oracle-only.`);
}
