import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const dir = path.join(root, 'public/assets/frozen-quarks');
const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as { effects: any[] };
const materials = new Map<string, any>();
const effects: any[] = [];

// Unity's ShaderLab material defaults can be serialized as -1 when the author leaves
// SrcBlend/DstBlend on "Auto". That value is not an executable blend factor in the web
// artifact. Resolve it once here from the semantic blend mode; the player must never guess.
const normalizeBlendFactors = (blend: string, src: number, dst: number) => {
  if (src >= 0 && dst >= 0) return { src, dst };
  switch (blend) {
    case 'additive': return { src: 1, dst: 1 };
    case 'premultiplied-alpha':
    case 'premultiplied': return { src: 1, dst: 10 };
    case 'multiply': return { src: 0, dst: 2 };
    case 'opaque': return { src: 1, dst: 0 };
    default: return { src: 5, dst: 10 }; // SrcAlpha, OneMinusSrcAlpha
  }
};

for (const entry of manifest.effects.filter((item) => item.status === 'compiled')) {
  const artifact = JSON.parse(await readFile(path.join(dir, entry.file), 'utf8'));
  const payload = artifact.webRuntime.payload;
  const refs: Record<string, string> = {};
  for (const material of payload.materials ?? []) {
    const program = material.userData?.vfxProgram;
    if (!program) continue;
    const profile = program.profile ?? {};
    // Quarks material UUIDs are only unique inside one exported effect. The
    // corpus intentionally reuses values such as `quarks_material-40`; using
    // that local UUID as a global key aliases unrelated authored materials and
    // makes the last effect in the manifest silently define every earlier one.
    const id = `mat-${entry.id}-${material.uuid}`;
    refs[material.uuid] = id;
    if (!materials.has(id)) {
      const blend = program.blend ?? profile.blendMode ?? 'alpha';
      const factors = normalizeBlendFactors(
        blend,
        Number(profile.srcBlend ?? program.srcBlend ?? -1),
        Number(profile.dstBlend ?? program.dstBlend ?? -1),
      );
      materials.set(id, {
        id,
        shaderFamily: profile.shaderFamily ?? program.shaderFamily ?? 'unknown',
        blend,
        srcBlend: factors.src,
        dstBlend: factors.dst,
        zWrite: Boolean(profile.effectiveZWrite ?? profile.zWrite ?? program.zWrite),
        alphaTest: Number(profile.cutoff ?? program.cutoff ?? 0),
        operations: program.operations ?? [],
        textureSlots: material.userData?.maps ?? {},
        shaderStatus: 'requires-offline-glsl-emission',
      });
    }
  }
  effects.push({ id: entry.id, file: entry.file, materials: refs });
}

await writeFile(path.join(dir, 'materials.manifest.json'), JSON.stringify({
  schema: 'vfx-material-index@1', materials: [...materials.values()], effects,
}, null, 2));
console.log(`indexed ${effects.length} effects, ${materials.size} unique materials`);
