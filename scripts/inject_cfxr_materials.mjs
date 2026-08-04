/**
 * Inject `cfxr` blocks into Quarks JSON from the *exact* Unity materials
 * referenced by a prefab (not texture-name heuristics / HDR-max guessing).
 *
 * Usage:
 *   node scripts/inject_cfxr_materials.mjs \
 *     <quarks.json> <prefab.prefab> [CFXR Assets root for .mat resolve]
 */
import fs from 'fs';
import path from 'path';

const jsonPath = path.resolve(process.argv[2] || 'public/assets/quarks/CFXR3 Fire Explosion B.json');
const prefabPath = path.resolve(
  process.argv[3] ||
    'unity-ref/Assets/JMO Assets/Cartoon FX Remaster/CFXR Prefabs/Explosions/CFXR3 Fire Explosion B.prefab',
);
const unityRoot = path.resolve(
  process.argv[4] || 'unity-ref/Assets/JMO Assets/Cartoon FX Remaster',
);

function walk(dir, pred, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, pred, out);
    else if (pred(name)) out.push(p);
  }
  return out;
}

function buildGuidIndex(root) {
  const map = new Map();
  for (const meta of walk(root, (n) => n.endsWith('.meta'))) {
    const t = fs.readFileSync(meta, 'utf8');
    const g = t.match(/^guid: ([a-f0-9]+)/m);
    if (g) map.set(g[1], meta.replace(/\.meta$/, ''));
  }
  return map;
}

function parseMat(file) {
  const text = fs.readFileSync(file, 'utf8');
  const getFloat = (key, d = 0) => {
    const m = text.match(new RegExp(`- ${key}:\\s*([\\d.eE+-]+)`));
    return m ? parseFloat(m[1]) : d;
  };
  const getColor = (key) => {
    const m = text.match(
      new RegExp(
        `- ${key}:\\s*\\{r:\\s*([\\d.]+),\\s*g:\\s*([\\d.]+),\\s*b:\\s*([\\d.]+),\\s*a:\\s*([\\d.]+)\\}`,
      ),
    );
    return m ? [+m[1], +m[2], +m[3], +m[4]] : [1, 1, 1, 1];
  };
  const kwBlock = text.match(/m_ValidKeywords:\s*\n((?:\s*- .+\n)*)/);
  const keywords = kwBlock
    ? kwBlock[1]
        .split('\n')
        .map((l) => l.replace(/^\s*-\s*/, '').trim())
        .filter(Boolean)
    : [];
  const dissolveGuid = (
    text.match(/- _DissolveTex:\s*\n\s*m_Texture:\s*\{fileID:\s*\d+, guid: ([a-f0-9]+)/) || []
  )[1];
  const shader =
    (text.match(/m_Shader:\s*\{fileID:\s*\d+, guid: [a-f0-9]+, type: \d+\}\s*\n/) && path.basename(file, '.mat')) ||
    path.basename(file, '.mat');

  const useDissolve = getFloat('_UseDissolve', 0) > 0.5 || keywords.includes('_CFXR_DISSOLVE');
  // Unity CFXR: `_InvertDissolveTex <= 0` → invert. Property 0 is the common default.
  const invertProp = getFloat('_InvertDissolveTex', 0);
  return {
    name: path.basename(file, '.mat'),
    shader,
    hdrMultiply: getFloat('_HdrMultiply', 0),
    singleChannel: getFloat('_SingleChannel', 0) > 0.5 || keywords.includes('_CFXR_SINGLE_CHANNEL'),
    useDissolve,
    dissolveSmooth: getFloat('_DissolveSmooth', 0.15),
    invertDissolve: useDissolve ? invertProp <= 0 : false,
    color: getColor('_Color'),
    ringTopOffset: getFloat('_RingTopOffset', 0.07),
    fading: keywords.includes('_FADING_ON') || getFloat('_UseSP', 0) > 0.5,
    additive: keywords.includes('_CFXR_ADDITIVE'),
    proceduralRing: /procedural ring|proc ring/i.test(path.basename(file) + shader),
    dissolveGuid,
  };
}

/** Map emitter GameObject name → material guid via ParticleSystemRenderer (!u!199). */
function prefabNameToMatGuid(prefabText) {
  const goName = new Map();
  const goRe = /--- !u!1 &(\d+)\nGameObject:\n[\s\S]*?m_Name: (.+)/g;
  let m;
  while ((m = goRe.exec(prefabText))) goName.set(m[1], m[2].trim());

  const nameToGuid = new Map();
  const renRe = /--- !u!199 &\d+\nParticleSystemRenderer:\n([\s\S]*?)(?=\n--- !u!|\s*$)/g;
  while ((m = renRe.exec(prefabText))) {
    const block = m[1];
    const go = block.match(/m_GameObject: \{fileID: (\d+)\}/);
    const mat = block.match(/m_Materials:\s*\n\s*- \{fileID: \d+, guid: ([a-f0-9]+)/);
    if (!go || !mat) continue;
    const name = goName.get(go[1]);
    if (name) nameToGuid.set(name, mat[1]);
  }
  return nameToGuid;
}

function collectEmitters(node, out = []) {
  if (!node) return out;
  if (node.type === 'ParticleEmitter') out.push(node);
  if (Array.isArray(node.children)) node.children.forEach((c) => collectEmitters(c, out));
  return out;
}

const guidIndex = buildGuidIndex(unityRoot);
const prefabText = fs.readFileSync(prefabPath, 'utf8');
const nameToGuid = prefabNameToMatGuid(prefabText);

const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const root = json.object || json;
const emitters = collectEmitters(root);
const matByUuid = new Map((json.materials || []).map((m) => [m.uuid, m]));

/** CustomData.custom1.x keyframes (dissolveTime) per GameObject name. */
function prefabCustom1xCurves(prefabText) {
  const goName = new Map();
  const goRe = /--- !u!1 &(\d+)\nGameObject:\n[\s\S]*?m_Name: (.+)/g;
  let m;
  while ((m = goRe.exec(prefabText))) goName.set(m[1], m[2].trim());

  // ParticleSystem !u!198 holds CustomDataModule
  const out = new Map();
  const psRe = /--- !u!198 &\d+\nParticleSystem:\n([\s\S]*?)(?=\n--- !u!|\s*$)/g;
  while ((m = psRe.exec(prefabText))) {
    const block = m[1];
    const go = block.match(/m_GameObject: \{fileID: (\d+)\}/);
    const name = go ? goName.get(go[1]) : null;
    if (!name) continue;
    // CustomDataModule is last in Unity PS YAML; block already ends before next --- !u!
    const cd = block.match(/CustomDataModule:\n([\s\S]*)$/);
    if (!cd || !/^\s*enabled: 1/m.test(cd[1])) continue;
    const v0 = cd[1].match(/vector0_0:\n([\s\S]*?)(?:vector0_1:|vectorLabel0)/);
    if (!v0) continue;
    const maxCurve = v0[1].match(/maxCurve:\n([\s\S]*?)minCurve:/);
    const src = maxCurve ? maxCurve[1] : v0[1];
    const keys = [...src.matchAll(/time: ([\d.]+)\n\s+value: ([\d.eE+-]+)/g)].map((x) => ({
      t: +x[1],
      v: +x[2],
    }));
    const uniq = [];
    for (const k of keys) {
      if (uniq.length && k.t < uniq[uniq.length - 1].t) break;
      if (!uniq.length || k.t !== uniq[uniq.length - 1].t) uniq.push(k);
      if (uniq.length >= 8) break;
    }
    if (uniq.length >= 2) out.set(name, { keys: uniq });
  }
  return out;
}

const custom1x = prefabCustom1xCurves(prefabText);

let n = 0;
for (const em of emitters) {
  const guid = nameToGuid.get(em.name);
  if (!guid) {
    console.warn('no prefab mat for emitter', em.name);
    continue;
  }
  const matPath = guidIndex.get(guid);
  if (!matPath || !fs.existsSync(matPath)) {
    console.warn('missing mat file', guid);
    continue;
  }
  const src = parseMat(matPath);
  if (src.dissolveGuid) {
    const dp = guidIndex.get(src.dissolveGuid);
    if (dp) src.dissolveTextureName = path.basename(dp).replace(/\.[^.]+$/, '');
  }
  const mat = matByUuid.get(em.ps?.material);
  if (!mat) {
    console.warn('no json material for', em.name);
    continue;
  }
  mat.cfxr = {
    shader: src.shader,
    hdrMultiply: src.hdrMultiply,
    singleChannel: !!src.singleChannel,
    useDissolve: !!src.useDissolve,
    dissolveSmooth: src.dissolveSmooth,
    invertDissolve: !!src.invertDissolve,
    color: src.color,
    ringTopOffset: src.ringTopOffset,
    fading: !!src.fading,
    additive: !!src.additive,
    proceduralRing: !!src.proceduralRing,
    ...(src.dissolveTextureName ? { dissolveTextureName: src.dissolveTextureName } : {}),
  };
  mat.name = src.name;

  const curve = custom1x.get(em.name);
  if (curve && em.ps) {
    em.ps.cfxrCustomData = { custom1x: curve };
  }

  n++;
  console.log(em.name, '←', src.name, {
    hdr: src.hdrMultiply,
    sc: src.singleChannel,
    dissolve: src.useDissolve,
    custom1x: !!curve,
  });
}

fs.writeFileSync(jsonPath, JSON.stringify(json));
console.log(`Injected cfxr for ${n} emitters → ${jsonPath}`);
