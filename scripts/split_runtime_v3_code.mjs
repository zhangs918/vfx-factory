import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const artifactDir = process.env.VFX_V3_ARTIFACT_DIR
  ? path.resolve(root, process.env.VFX_V3_ARTIFACT_DIR)
  : path.join(root, 'public/assets/v3-artifacts');
const codeDir = process.env.VFX_V3_CODE_DIR
  ? path.resolve(root, process.env.VFX_V3_CODE_DIR)
  : path.join(root, 'public/assets/v3-code');
const requested = new Set(
  process.argv.slice(2)
    .filter((arg) => !arg.startsWith('-'))
    .map((id) => String(id).toLowerCase()),
);
const manifest = JSON.parse(await readFile(path.join(artifactDir, 'manifest.json'), 'utf8'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const writeHashed = async (file, bytes) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return digest(bytes);
};

const effects = manifest.effects.filter((entry) => (
  !requested.size || requested.has(String(entry.id).toLowerCase())
));
for (const entry of effects) {
  const artifactFile = path.join(artifactDir, entry.file);
  const artifact = JSON.parse(await readFile(artifactFile, 'utf8'));
  const base = path.join(codeDir, entry.id);
  const configBytes = Buffer.from(JSON.stringify({
    quarksConfig: artifact.simulation,
    runtimeState: artifact.runtimeState,
    metadata: artifact.metadata,
  }));
  const configName = 'config.json';
  const configHash = await writeHashed(path.join(base, configName), configBytes);
  const shaderFiles = {};
  for (const [shaderId, shader] of Object.entries(artifact.shaders ?? {})) {
    const vertexName = `${shaderId}.vert.glsl`;
    const fragmentName = `${shaderId}.frag.glsl`;
    const vertexBytes = Buffer.from(shader.vertex);
    const fragmentBytes = Buffer.from(shader.fragment);
    const vertexHash = await writeHashed(path.join(base, vertexName), vertexBytes);
    const fragmentHash = await writeHashed(path.join(base, fragmentName), fragmentBytes);
    shaderFiles[shaderId] = {
      id: shaderId,
      vertex: { uri: `/assets/v3-code/${entry.id}/${vertexName}`, sha256: vertexHash, bytes: vertexBytes.length },
      fragment: { uri: `/assets/v3-code/${entry.id}/${fragmentName}`, sha256: fragmentHash, bytes: fragmentBytes.length },
      uniforms: shader.uniforms,
      attributes: shader.attributes,
      varyings: shader.varyings,
      execution: shader.execution,
      vertexExecution: shader.vertexExecution,
    };
  }
  artifact.files = {
    config: { uri: `/assets/v3-code/${entry.id}/${configName}`, sha256: configHash },
    shaders: shaderFiles,
  };
  await writeFile(artifactFile, JSON.stringify(artifact));
}
const codeManifestPath = path.join(codeDir, 'manifest.json');
if (requested.size) {
  let priorIds = [];
  try {
    priorIds = JSON.parse(await readFile(codeManifestPath, 'utf8')).effects ?? [];
  } catch {
    // First targeted split.
  }
  const ids = new Set(priorIds.map(String));
  for (const entry of effects) ids.add(entry.id);
  await writeFile(
    codeManifestPath,
    JSON.stringify({ schema: 'vfx-code-manifest@1', effects: [...ids] }, null, 2),
  );
  console.log(`split code/config for ${effects.length} v3 artifacts (targeted; manifest merged)`);
} else {
  await writeFile(
    codeManifestPath,
    JSON.stringify({ schema: 'vfx-code-manifest@1', effects: manifest.effects.map((e) => e.id) }, null, 2),
  );
  console.log(`split code/config for ${effects.length} v3 artifacts`);
}
