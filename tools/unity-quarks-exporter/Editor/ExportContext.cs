using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

namespace BabylonQuarks.UnityExporter
{
    /// <summary>
    /// Accumulates the shared meta arrays (geometries / materials / textures / images) of the
    /// Quarks envelope while the hierarchy is serialized, and holds the node-uuid maps used to
    /// wire sub-emitters. Textures are embedded as data URIs so the exported JSON is self-contained.
    /// </summary>
    public class ExportContext
    {
        public readonly JArray Geometries = new JArray();
        public readonly JArray Materials = new JArray();
        public readonly JArray Textures = new JArray();
        public readonly JArray Images = new JArray();
        public readonly List<ExportDiagnostic> Diagnostics = new List<ExportDiagnostic>();

        /// <summary>Blend mode of the most recently built material — read straight after AddMaterialForRenderer.</summary>
        public int LastBlendMode = 2;

        public bool EmbedTextures = true;

        /// <summary>Mesh nodes emitted for mesh-shape emitters; appended to the root object's children.</summary>
        public readonly System.Collections.Generic.List<JObject> MeshSourceNodes = new System.Collections.Generic.List<JObject>();

        private int _idCounter;
        private readonly Dictionary<string, string> _imageByUrl = new Dictionary<string, string>();
        private readonly Dictionary<Transform, string> _transformUuid = new Dictionary<Transform, string>();
        private readonly Dictionary<ParticleSystem, string> _systemUuid = new Dictionary<ParticleSystem, string>();
        private readonly HashSet<ParticleSystem> _subTargets = new HashSet<ParticleSystem>();
        private readonly Dictionary<ParticleSystem, JArray> _hierarchyInitialStates =
            new Dictionary<ParticleSystem, JArray>();
        private readonly Dictionary<ParticleSystem, JArray> _hierarchyTrajectoryCaches =
            new Dictionary<ParticleSystem, JArray>();
        private readonly Dictionary<ParticleSystem, JArray> _hierarchyTrailGeometryCaches =
            new Dictionary<ParticleSystem, JArray>();
        private string _localBillboardQuadGeometryUuid;

        public string NewId(string prefix) => prefix + "-" + (_idCounter++);

        public bool HasErrors
        {
            get
            {
                foreach (var d in Diagnostics) if (d.Severity == ExportSeverity.Error) return true;
                return false;
            }
        }

        public void Error(string code, string path, string message) =>
            Diagnostics.Add(new ExportDiagnostic(ExportSeverity.Error, code, path, message));

        public void Warning(string code, string path, string message) =>
            Diagnostics.Add(new ExportDiagnostic(ExportSeverity.Warning, code, path, message));

        public JArray DiagnosticsJson()
        {
            var result = new JArray();
            foreach (var d in Diagnostics) result.Add(d.ToJson());
            return result;
        }

        // ---- node uuid registry (assigned in pass 1) -----------------------------------

        public string AssignNodeUuid(Transform t)
        {
            string uuid = NewId("node");
            _transformUuid[t] = uuid;
            var ps = t.GetComponent<ParticleSystem>();
            if (ps != null) _systemUuid[ps] = uuid;
            return uuid;
        }

        public string GetTransformUuid(Transform t) =>
            _transformUuid.TryGetValue(t, out var u) ? u : NewId("node");

        public string GetNodeUuid(ParticleSystem ps) =>
            ps != null && _systemUuid.TryGetValue(ps, out var u) ? u : null;

        public void MarkSubTarget(ParticleSystem ps) { if (ps != null) _subTargets.Add(ps); }
        public bool IsSubTarget(ParticleSystem ps) => ps != null && _subTargets.Contains(ps);
        public void SetHierarchyInitialState(ParticleSystem ps, JArray state)
        {
            if (ps != null && state != null) _hierarchyInitialStates[ps] = state;
        }
        public JArray GetHierarchyInitialState(ParticleSystem ps) =>
            ps != null && _hierarchyInitialStates.TryGetValue(ps, out JArray state) ? state : null;
        public void SetHierarchyTrajectoryCache(ParticleSystem ps, JArray cache)
        {
            if (ps != null && cache != null) _hierarchyTrajectoryCaches[ps] = cache;
        }
        public JArray GetHierarchyTrajectoryCache(ParticleSystem ps) =>
            ps != null && _hierarchyTrajectoryCaches.TryGetValue(ps, out JArray cache) ? cache : null;
        public void SetHierarchyTrailGeometryCache(ParticleSystem ps, JArray cache)
        {
            if (ps != null && cache != null) _hierarchyTrailGeometryCaches[ps] = cache;
        }
        public JArray GetHierarchyTrailGeometryCache(ParticleSystem ps) =>
            ps != null && _hierarchyTrailGeometryCaches.TryGetValue(ps, out JArray cache) ? cache : null;

        // ---- material / texture --------------------------------------------------------

        public string AddMaterialForRenderer(ParticleSystemRenderer renderer)
        {
            Material mat = renderer != null ? renderer.sharedMaterial : null;
            LastBlendMode = DetectBlend(mat);
            ValidateMaterialForRenderer(renderer);

            // A missing primary material has no executable Unity shading semantics. Keep the
            // ParticleSystem alive because it may drive sub-emitters/trails, but compile its main
            // renderer to an explicit transparent program. Rendering a guessed white/pink
            // fallback would turn an asset-authoring error into production pixels.
            if (mat == null)
            {
                string missingUuid = NewId("quarks_material");
                var profile = new JObject()
                    .Set("singleChannel", true)
                    .Set("coverageChannel", "red")
                    .Set("vertexColorRgb", false)
                    .Set("vertexColorAlpha", false)
                    .Set("additive", false)
                    .Set("opacity", 0f)
                    .Set("color", new JArray().Add(0).Add(0).Add(0).Add(0));
                var operations = new JArray()
                    .Add(new JObject().Set("op", "coverage").Set("source", "constant-one"))
                    .Add(new JObject().Set("op", "tint"))
                    .Add(new JObject().Set("op", "blend").Set("mode", "alpha"));
                Materials.Add(new JObject()
                    .Set("uuid", missingUuid)
                    .Set("type", "QuarksMaterial")
                    .Set("name", "Missing material (simulation-only)")
                    .Set("shader", "")
                    .Set("transparent", true)
                    .Set("alphaMode", 2)
                    .Set("blending", 2)
                    .Set("depthTest", true)
                    .Set("depthWrite", false)
                    .Set("alphaTest", 0)
                    .Set("alphaClip", false)
                    .Set("vfxProgram", new JObject()
                        .Set("schema", "particle-material-program@2")
                        .Set("compiler", "unity-shadergraph-semantic-compiler@2")
                        .Set("sourceGraphHash", "missing-material")
                        .Set("lowering", "simulation-only@1")
                        .Set("template", "coverage-tint")
                        .Set("coverageSource", "constant-one")
                        .Set("blend", "alpha")
                        .Set("operations", operations)
                        .Set("profile", profile)));
                return missingUuid;
            }

            // Resolve maps via SerializedObject when Shader Graph hides HasProperty("_Main").
            // Never guess "first assigned texture" — that picks dissolve/mask/noise as albedo.
            Texture mainTex = FindAlbedoTexture(mat);
            string textureUuid = mainTex != null ? AddTexture(mainTex) : null;

            var maps = new JObject();
            if (textureUuid != null) maps.Set("main", textureUuid);
            BindMap(mat, maps, "dissolve", "_DissolveTex", "_DissolveMap");
            BindMap(mat, maps, "distortion", "_DistortionTex", "_DistortionMap");
            BindMap(mat, maps, "mask", "_MaskTex", "_Mask");
            BindMap(mat, maps, "emission", "_EmissionTex", "_EmissionMap");
            BindMap(mat, maps, "height", "_HeightMap", "_ParallaxMap");
            BindMap(mat, maps, "alpha", "_AlphaTex");
            BindMap(mat, maps, "noise", "_NoiseTex");
            if (mat.shader != null && mat.shader.name == "SH_Vefects_VFX_URP_Heat_Haze_01")
                BindMap(mat, maps, "mask", "_DissolveMask");

            string reflectionAtlasUuid = null;
            float reflectionLevel = 1f;
            Cubemap cube = FindReflectionCubemap(mat);
            if (cube != null)
            {
                reflectionAtlasUuid = AddCubemapAtlas(cube);
                reflectionLevel = ReadReflectionLevel(mat);
            }

            // Shader Graph uses `_Clip` for Alpha Clip Threshold; Lit leftover `_Cutoff` is often stale.
            // When a dissolve map is bound, clip is animated in-shader — do NOT bake a static alphaTest.
            bool hasDissolveMap = maps.Has("dissolve");
            ShaderGraphInfo materialGraph = ShaderGraphAnalyzer.Analyze(mat != null ? mat.shader : null);
            bool alphaClip = materialGraph != null
                ? materialGraph.AlphaClipEnabled
                : TryGetMaterialFloat(mat, "_AlphaClip", out float clipVal) && clipVal > 0.5f;
            float alphaCutoff = 0f;
            if (!hasDissolveMap)
            {
                if (TryGetMaterialFloat(mat, "_Clip", out float cut))
                    alphaCutoff = cut;
                else if (TryGetMaterialFloat(mat, "_Cutoff", out cut))
                    alphaCutoff = cut;
            }

            string uuid = NewId("quarks_material");
            var m = new JObject()
                .Set("uuid", uuid)
                .Set("type", "QuarksMaterial")
                .Set("name", mat != null ? mat.name : "material")
                .Set("shader", mat != null && mat.shader != null ? mat.shader.name : "")
                .Set("transparent", true)
                .Set("alphaMode", LastBlendMode)
                .Set("blending", LastBlendMode)
                .Set("depthTest", true)
                .Set("depthWrite", false)
                .Set("alphaTest", alphaClip && !hasDissolveMap ? Mathf.Max(0.001f, alphaCutoff) : 0)
                .Set("alphaClip", alphaClip);
            if (textureUuid != null)
            {
                // Write both keys: `texture` for QuarksMaterial and `map` for three.js compatibility.
                m.Set("texture", textureUuid);
                m.Set("map", textureUuid);
            }
            if (maps.Count > 0) m.Set("maps", maps);
            if (reflectionAtlasUuid != null)
            {
                m.Set("reflectionAtlas", reflectionAtlasUuid);
                m.Set("reflectionLevel", reflectionLevel);
            }

            // Tint / HDR multiply used by both CFXR and Shader Graph particle mats.
            if (TryGetSemanticTint(mat, out Color tint))
            {
                m.Set("color", new JArray().Add(tint.r).Add(tint.g).Add(tint.b).Add(tint.a));
            }

            // Particle ubershader props (CFXR + Shader Graph dissolve/HDR) — Web fidelity layer.
            JObject cfxr = BuildParticleFxBlock(mat, maps);
            JObject semanticProgram = BuildSemanticMaterialProgram(mat, cfxr, textureUuid, renderer);
            // Built-in Sprites/Default with no resolved texture has no drawable alpha
            // semantics. Rendering its implicit white texture produces opaque billboard/mesh
            // rectangles. Omit this unsupported layer explicitly; never invent coverage.
            if (mat != null && mat.shader != null
                && mat.shader.name == "Sprites/Default" && textureUuid == null)
            {
                var semanticProfile = semanticProgram.Get("profile") as JObject;
                semanticProfile?.Set("opacity", 0f)
                    .Set("semanticOmission", "missing-sprite-texture@1");
                semanticProgram.Set("lowering", "unsupported-sprite-no-texture@1");
            }
            m.Set("vfxProgram", semanticProgram);

            Materials.Add(m);
            return uuid;
        }

        public void ValidateMaterialForRenderer(ParticleSystemRenderer renderer)
        {
            Material mat = renderer != null ? renderer.sharedMaterial : null;
            if (mat == null)
            {
                Warning("MATERIAL_MISSING_SIMULATION_ONLY",
                    renderer != null ? SemanticValidator.HierarchyPath(renderer.transform) : "",
                    "Particle renderer has no primary material; its main renderer is compiled transparent while simulation/sub-emitter semantics remain live.");
                return;
            }
            ShaderGraphInfo strictGraph = ShaderGraphAnalyzer.Analyze(mat.shader);
            string shaderName = mat.shader != null ? mat.shader.name ?? "" : "";
            if (strictGraph == null && !IsReviewedLegacyParticleShader(shaderName)
                && !IsReviewedBuiltinParticleShader(shaderName)
                && shaderName != "Universal Render Pipeline/Lit"
                && shaderName != "Universal Render Pipeline/Unlit"
                && shaderName != "Unlit/Color" && shaderName != "Sprites/Default")
            {
                Error("BUILTIN_SHADER_PROGRAM_UNSUPPORTED",
                    SemanticValidator.HierarchyPath(renderer.transform),
                    $"Non-ShaderGraph material shader '{shaderName}' has no reviewed material-program lowering.");
                return;
            }
            if (shaderName == "Universal Render Pipeline/Lit"
                && TryGetMaterialFloat(mat, "_Cull", out float cullMode)
                && Mathf.RoundToInt(cullMode) == 1)
            {
                Error("URP_LIT_FRONT_CULL_UNSUPPORTED",
                    SemanticValidator.HierarchyPath(renderer.transform),
                    "URP Lit front-face culling is not part of unity-urp-lit-reference@1.");
                return;
            }
            string strictManualLowering = ManualGraphLowering(strictGraph?.SourceHash);
            bool orbWarpLowering = strictManualLowering == "orb-warp@1"
                || strictManualLowering == "orb-warp-lit@1";
            bool dynamicClipActive = strictGraph != null && strictGraph.AlphaClipDynamic;
            if (dynamicClipActive && TryGetMaterialFloat(mat, "_Clip", out float clipScale)
                && Mathf.Abs(clipScale) <= 1e-6f)
                dynamicClipActive = false; // material-folded expression is the constant zero
            if (dynamicClipActive && string.IsNullOrEmpty(strictGraph.AlphaClipSource) && !orbWarpLowering)
            {
                Error("SHADERGRAPH_ALPHA_CLIP_EXPRESSION_UNSUPPORTED",
                    SemanticValidator.HierarchyPath(renderer.transform),
                    $"Shader Graph {strictGraph.SourceHash} has a dynamic AlphaClipThreshold " +
                    "whose exact source/component cannot be lowered.");
                return;
            }
            if (dynamicClipActive && !string.IsNullOrEmpty(strictGraph.AlphaClipZeroToggleProperty)
                && TryGetMaterialColor(mat, strictGraph.AlphaClipZeroToggleProperty, out Color toggle)
                && toggle.r > 1e-6f)
            {
                Error("SHADERGRAPH_ALPHA_CLIP_MATERIAL_BRANCH_UNSUPPORTED",
                    SemanticValidator.HierarchyPath(renderer.transform),
                    $"Shader Graph {strictGraph.SourceHash} selects its constant-one alpha clip branch " +
                    $"because {strictGraph.AlphaClipZeroToggleProperty}={toggle.r}; only the reviewed UV1 branch is lowered.");
                return;
            }
            if (strictGraph != null && !CanLowerParticleGraph(mat, strictGraph, out string reason))
            {
                Error("SHADERGRAPH_PROGRAM_UNSUPPORTED", SemanticValidator.HierarchyPath(renderer.transform),
                    $"Shader Graph {strictGraph.SourceHash} cannot be lowered to particle-material-program@2: {reason}");
            }
        }

        private static bool CanLowerParticleGraph(Material mat, ShaderGraphInfo graph, out string reason)
        {
            if (ManualGraphLowering(graph.SourceHash) != null)
            {
                reason = "";
                return true;
            }
            if (!graph.IsStrictTemplateSupported(out string unsupportedNodes))
            {
                reason = $"active output chains contain unsupported node types: {unsupportedNodes}";
                return false;
            }
            Texture main = FindAlbedoTexture(mat, out string mainProp);
            if (main == null || string.IsNullOrEmpty(mainProp))
            {
                reason = "no explicit main texture binding";
                return false;
            }
            if (!graph.AlphaTextures.Contains(mainProp) && !graph.ColorTextures.Contains(mainProp))
            {
                reason = $"main texture '{mainProp}' is not connected to Alpha or BaseColor";
                return false;
            }

            // These authored switches define the active feature set of the supported particle
            // template. Branches disabled by material constants are eliminated here; the raw
            // graph may still contain their nodes, which is why node-name whitelisting was wrong.
            bool distortion = TryGetMaterialFloat(mat, "_Distortion", out float d) && d > 1e-5f;
            if (distortion && !graph.SceneColorInColor)
            {
                reason = "distortion is enabled but BaseColor has no Scene Color input";
                return false;
            }
            bool emission = TryGetMaterialFloat(mat, "_Emission", out float e) && e > 0.5f;
            if (emission)
            {
                reason = "the active secondary emission branch is not implemented";
                return false;
            }
            reason = "";
            return true;
        }

        /// <summary>
        /// Reviewed GLSL lowerings are locked to exact graph-content hashes. This is intentionally
        /// not keyed by effect/material names: any graph edit invalidates the lowering and returns
        /// the asset to strict rejection until the generated expression is reviewed again.
        /// </summary>
        private static string ManualGraphLowering(string sourceHash)
        {
            switch (sourceHash)
            {
                case "e393b829bceade6e945866814a05b88d": return "slash-world@3";
                case "5dec7e398437ea7cc9af539891fa91ea": return "trail-front-face@2";
                case "a756d5c487fb511ac5631b75e5c9fb63": return "parallax-occlusion@1";
                case "cf675eab2cba896fd7a253ca2ecbca3e": return "slash-screen@2";
                case "d5a9e535b32c64fc6402563dd1d6ca04": return "orb-warp@1";
                case "f686d83dfe1eb51b2412cc31e75994da": return "orb-warp-lit@1";
                default: return null;
            }
        }

        private static string ManualGraphMainTexture(string sourceHash)
        {
            switch (sourceHash)
            {
                // These bindings are part of the reviewed, source-hash-locked graph lowering.
                case "e393b829bceade6e945866814a05b88d": return "_MainTex";
                case "5dec7e398437ea7cc9af539891fa91ea": return "_MainTex";
                case "a756d5c487fb511ac5631b75e5c9fb63": return "_MainTex";
                // Strict generated subset: disabled dissolve/distortion branches remain in the
                // serialized graph, so reachability alone is ambiguous after material folding.
                case "61056cd721b6410d91e4029bd49f3b10": return "_Main";
                case "cf675eab2cba896fd7a253ca2ecbca3e": return "_Main";
                case "d5a9e535b32c64fc6402563dd1d6ca04": return "_AlphaTex";
                // Orb Warp Lit intentionally leaves _AlphaTex unassigned (Shader Graph's
                // texture fallback is constant one). _NoiseTex is the required live resource
                // used as the batching map; the reviewed lowering does not infer its role.
                case "f686d83dfe1eb51b2412cc31e75994da": return "_NoiseTex";
                default: return null;
            }
        }

        /// <summary>
        /// Versioned, explicit material program consumed by the Web runtime. All decisions are
        /// made at export time; the runtime is forbidden from inspecting pixels/property names
        /// to guess coverage, color space, blending, or a material family.
        /// </summary>
        private JObject BuildSemanticMaterialProgram(Material mat, JObject profile, string mainTextureUuid,
            ParticleSystemRenderer renderer)
        {
            // The semantic compiler may be invoked for reviewed non-CFX shader families. Keep
            // their IR profile explicit instead of falling back to an untyped RGBA material.
            if (profile == null) profile = new JObject();
            if (profile != null && renderer != null)
            {
                profile.Set("flipX", renderer.flip.x > 0.5f);
                profile.Set("flipY", renderer.flip.y > 0.5f);
            }
            string template = "texture-tint";
            string coverage = "alpha";
            string shaderName = mat != null && mat.shader != null ? mat.shader.name ?? "" : "";
            MaterialShaderFamily family = MaterialShaderFamilyRegistry.Resolve(shaderName);
            bool legacyParticle = family.LegacyParticle;
            bool alpha8Additive = family.Alpha8Additive;
            bool multiplyColored = family.MultiplyColored;
            bool legacyMultiply = family.LegacyMultiply;
            bool legacyPremultiply = family.LegacyPremultiply;
            bool legacyDoubleTint = family.LegacyDoubleTint;
            bool vefectsZap = family.VefectsZap;
            bool vefectsExtraParticles = family.VefectsExtraParticles;
            bool vefectsErosionParticles = family.VefectsErosionParticles;
            bool vefectsHeatHaze = family.VefectsHeatHaze;
            bool ericAdditiveFlow = family.EricAdditiveFlow;
            bool ericAlphaFlow = family.EricAlphaFlow;
            bool egaFireSphere = family.EgaFireSphere;
            if (legacyDoubleTint) profile.Set("legacyDoubleTint", true)
                .Set("legacyAlphaTintFactor", 2f);
            // Renderer materials can be instantiated by legacy prefab/controller setup.  An
            // instance has no AssetDatabase path, but its prefab source still carries the stable
            // material identity required by strict/manual lowering registries.
            Material sourceMaterial = mat;
            if (sourceMaterial != null && string.IsNullOrEmpty(AssetDatabase.GetAssetPath(sourceMaterial)))
            {
                Material prefabSource = PrefabUtility.GetCorrespondingObjectFromSource(sourceMaterial);
                if (prefabSource != null) sourceMaterial = prefabSource;
                if (string.IsNullOrEmpty(AssetDatabase.GetAssetPath(sourceMaterial)) && renderer != null)
                {
                    ParticleSystemRenderer sourceRenderer =
                        PrefabUtility.GetCorrespondingObjectFromSource(renderer);
                    if (sourceRenderer != null)
                    {
                        string instanceName = mat.name.Replace(" (Instance)", "");
                        foreach (Material candidate in sourceRenderer.sharedMaterials)
                        {
                            if (candidate != null && candidate.name == instanceName)
                            {
                                sourceMaterial = candidate;
                                break;
                            }
                        }
                    }
                }
            }
            string materialGuid = sourceMaterial != null
                ? AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(sourceMaterial)) : "";
            if (mat != null && string.IsNullOrEmpty(materialGuid))
                Debug.LogWarning($"[Quarks Exporter] unresolved material identity: renderer='{renderer?.name}' material='{mat.name}' path='{AssetDatabase.GetAssetPath(mat)}' source='{sourceMaterial?.name}' sourcePath='{AssetDatabase.GetAssetPath(sourceMaterial)}'");
            float manualLegacyAlphaFactor = materialGuid == "c1b09b1ca8ba05d4682ccf6db6b1102d" ? 1f
                : materialGuid == "c6c72eb3fd1471c489daf719f70f62aa" ? 1f
                : materialGuid == "749ea6f567709834fbe474b44674e1ed" ? 1f
                : materialGuid == "a9b550a3d81ca7845b9fb15672984986" ? 1f
                : materialGuid == "b03f3e8f44fe09d48af2ab4d04ddbddb" ? 1f : -1f;
            if (materialGuid == "7cd73ef8e5a31a244a672ae32c0f6ddb")
                manualLegacyAlphaFactor = 1f;
            if (materialGuid == "f12d680b3c37c3c4fae5c220798d9977"
                || materialGuid == "35db7f8fdfbb7fe4eae9054b84300460"
                || materialGuid == "695873166113ab64997efed81c2426c7")
                manualLegacyAlphaFactor = 1f;
            string legacyMaterialLowering = manualLegacyAlphaFactor >= 0f
                ? "legacy-additive-explicit-alpha-factor@1" : null;
            if (legacyMaterialLowering != null)
                profile.Set("legacyAlphaTintFactor", manualLegacyAlphaFactor);
            bool legacyVertexColorRaw = materialGuid == "c1b09b1ca8ba05d4682ccf6db6b1102d"
                || materialGuid == "219882489a1df4042823f03b5b903103";
            if (legacyVertexColorRaw)
                profile.Set("legacyVertexColorRaw", true)
                    .Set("legacyVertexColorGain",
                        materialGuid == "219882489a1df4042823f03b5b903103" ? 0.65f : 1f);
            else if (materialGuid == "b479681f08574fd4188237f92866cbac")
                profile.Set("legacyVertexColorGain", 1.1f);
            // This shader's source is part of the imported package: `Blend SrcAlpha One` and
            // its Alpha8 texture is coverage only.  Declare that exact program explicitly.
            if (alpha8Additive)
            {
                template = "coverage-tint";
                coverage = "alpha";
                profile.Set("singleChannel", true)
                    .Set("coverageChannel", "alpha")
                    .Set("vertexColorRgb", true)
                    .Set("vertexColorAlpha", true);
            }
            if (multiplyColored)
            {
                // Package shader source: Blend DstColor Zero; output =
                // lerp(1, _TintColor * vertexColor, mainTex * vertexColor.a).
                template = "legacy-multiply-colored";
                coverage = "alpha";
                profile.Set("legacyMultiplyColored", true)
                    .Set("coverageChannel", "alpha")
                    .Set("alphaClipThreshold", 0.01f)
                    .Set("vertexColorRgb", true)
                    .Set("vertexColorAlpha", true);
            }
            if (legacyMultiply)
            {
                // Unity built-in source: prev=vertex*tex; out=lerp(1,prev,prev.a),
                // Blend Zero SrcColor, ColorMask RGB.
                template = "legacy-particle-multiply";
                coverage = "alpha";
                profile.Set("legacyMultiply", true)
                    .Set("vertexColorRgb", true).Set("vertexColorAlpha", true);
            }
            if (legacyPremultiply)
            {
                // Unity built-in source: out=vertex*tex*vertex.a,
                // Blend One OneMinusSrcAlpha, ColorMask RGB.
                template = "legacy-particle-premultiply";
                coverage = "alpha";
                profile.Set("legacyPremultiply", true)
                    .Set("vertexColorRgb", true).Set("vertexColorAlpha", true);
            }
            if (vefectsZap)
            {
                // Reviewed package source (SH_Vefects_Zap_URP.shader): coverage is
                // saturate(smoothstep(custom1.z, custom1.z + _ErosionSmoothness,
                // _ZapTexture.g) * vertexColor.a). The PNG alpha is opaque, so treating this
                // as ordinary RGBA produces the visible black quad. The current portable IR
                // lowers the stable channel role here; custom1.z erosion is represented by the
                // particle lifetime/dissolve path when available.
                template = "coverage-tint";
                coverage = "green";
                profile.Set("singleChannel", true)
                    .Set("coverageChannel", "green")
                    .Set("vertexColorRgb", true)
                    .Set("vertexColorAlpha", true);
                if (TryGetMaterialFloat(mat, "_EmissiveIntensity", out float zapEmission))
                    profile.Set("hdrMultiply", Mathf.Max(0f, zapEmission));
            }
            if (vefectsExtraParticles)
            {
                // Reviewed source: Alpha = smoothstep(custom1.z,
                // custom1.z + _ErosionSmoothness, _ParticleTexture.rgb).x * vertexAlpha.
                // In particular, Flare PNGs have opaque file alpha and must use R coverage.
                template = "coverage-tint";
                coverage = "red";
                profile.Set("singleChannel", true)
                    .Set("coverageChannel", "red")
                    .Set("vertexColorRgb", true)
                    .Set("vertexColorAlpha", true);
                if (TryGetMaterialFloat(mat, "_EmissiveIntensity", out float extraEmission))
                    profile.Set("hdrMultiply", Mathf.Max(0f, extraEmission));
            }
            if (vefectsErosionParticles)
            {
                // Erosion shader Alpha is driven by _MaskTexture/noise, while _Texture is an
                // optional color input. If the authored color texture is unavailable, the mask
                // remains the correct portable coverage source.
                template = "coverage-tint";
                coverage = "red";
                profile.Set("singleChannel", true)
                    .Set("coverageChannel", "red")
                    .Set("vertexColorRgb", true)
                    .Set("vertexColorAlpha", true);
            }
            if (vefectsHeatHaze)
            {
                // Reviewed source is scene-color refraction. Its `_Texture` is a distortion /
                // coverage signal, never visible RGB. Rendering it through texture-tint creates
                // the large dark quads seen around the fire.
                template = "coverage-tint";
                coverage = "green";
                profile.Set("singleChannel", true)
                    .Set("coverageChannel", "green")
                    .Set("vertexColorRgb", false)
                    .Set("vertexColorAlpha", true);
            }
            Texture semanticMainTexture = FindAlbedoTexture(mat, out string semanticMainProperty);
            bool ericAlphaMissing = ericAlphaFlow && semanticMainTexture != null
                && !SourceTextureHasAlpha(semanticMainTexture);
            if (ericAdditiveFlow)
            {
                // Source shader premultiplies RGB by texture/overlay/vertex alpha and uses
                // Blend One One. The Web additive path is algebraically equivalent when RGB
                // remains unpremultiplied and source-alpha blending is applied exactly once.
                template = "texture-tint";
                coverage = "alpha";
            }
            if (ericAlphaMissing)
            {
                // AlphaBlendFlow requires texColor.a, but this source image has no alpha plane.
                // Luminance substitution would be a visual guess, so omit the layer explicitly.
                profile.Set("opacity", 0f)
                    .Set("semanticOmission", "required-main-alpha-missing");
            }
            if (egaFireSphere)
            {
                // Reviewed package source (FireSphere.shader): the texture's R channel owns
                // opacity.  When _Useblack is disabled, RGB is independent emission/tint;
                // treating the (opaque) file alpha as coverage renders the whole billboard.
                bool useTextureRgb = TryGetMaterialFloat(mat, "_Useblack", out float useBlack)
                    && useBlack > 0.5f;
                template = useTextureRgb ? "texture-tint" : "coverage-tint";
                coverage = "red";
                profile.Set("singleChannel", !useTextureRgb)
                    .Set("coverageChannel", "red")
                    .Set("vertexColorRgb", true)
                    .Set("vertexColorAlpha", true);
                if (TryGetMaterialFloat(mat, "_Emission", out float fireEmission))
                    profile.Set("hdrMultiply", Mathf.Max(0f, fireEmission));
                if (TryGetMaterialFloat(mat, "_Opacity", out float fireOpacity))
                    profile.Set("opacity", Mathf.Max(0f, fireOpacity));
            }
            ShaderGraphInfo sourceGraph = ShaderGraphAnalyzer.Analyze(mat != null ? mat.shader : null);
            // Browsers decode the source PNG; Unity samples the imported texture. When the
            // importer synthesizes alpha from grayscale, a graph A-socket means grayscale,
            // not the source file's (often constant-one) alpha channel. Lower that importer
            // semantic explicitly into the coverage instruction.
            if (semanticMainTexture != null && sourceGraph != null
                && sourceGraph.AlphaTextures.Contains(semanticMainProperty)
                && TextureAlphaSourceOf(semanticMainTexture) == TextureImporterAlphaSource.FromGrayScale)
                coverage = "red";
            if (profile != null && profile.Has("frontColor") && profile.Has("backColor"))
                template = "front-back-lerp";
            else if (profile != null && profile.Has("singleChannel"))
            {
                // BuildParticleFxBlock emits singleChannel only when the Shader Graph wiring or
                // an authored CFXR keyword establishes the role. No runtime pixel inference.
                ShaderGraphInfo graph = ShaderGraphAnalyzer.Analyze(mat != null ? mat.shader : null);
                FindAlbedoTexture(mat, out string prop);
                bool graphCoverageOnly = graph != null && prop != null
                    && graph.AlphaTextures.Contains(prop) && !graph.ColorTextures.Contains(prop);
                bool authoredSingle = mat != null && mat.IsKeywordEnabled("_CFXR_SINGLE_CHANNEL");
                if (graphCoverageOnly || authoredSingle)
                {
                    template = "coverage-tint";
                    // The strictly supported Shader Graph particle template routes the
                    // Sample Texture 2D A socket into SurfaceDescription.Alpha. Texture
                    // importer fallback-to-one is therefore significant and must survive.
                    coverage = graphCoverageOnly ? "red" : "luminance";
                }
            }

            string manualLowering = ManualGraphLowering(sourceGraph?.SourceHash);
            bool urpLit = sourceGraph == null && mat != null && mat.shader != null
                && mat.shader.name == "Universal Render Pipeline/Lit";
            // Source-hash-locked Trail graph wires SampleTexture2D slot 4 (R) into Alpha.
            // Slot IDs are resolved from slot metadata; they are not RGBA ordinal indexes.
            if (manualLowering == "trail-front-face@2") coverage = "red";
            var operations = new JArray()
                .Add(new JObject().Set("op", "sample-main").Set("texture", mainTextureUuid)
                    .Set("uv", "particle-flipbook"))
                .Add(new JObject().Set("op", "coverage").Set("source", coverage))
                .Add(new JObject().Set("op", "vertex-color"))
                .Add(new JObject().Set("op", "tint"));
            if (manualLowering != null)
                operations.Add(new JObject().Set("op", "manual-graph-lowering")
                    .Set("id", manualLowering).Set("sourceGraphHash", sourceGraph.SourceHash)
                    .Set("fidelity", "reviewed-manual").Set("requiresOracle", true));
            if (urpLit)
                operations.Add(new JObject().Set("op", "ambient-probe-lighting")
                    .Set("model", "unity-urp-lit-reference@1"));
            if (profile != null && profile.Has("frontColor") && profile.Has("backColor"))
                operations.Add(new JObject().Set("op", "front-back-lerp"));
            if (profile != null && profile.Has("useMask"))
                operations.Add(new JObject().Set("op", "mask"));
            if (profile != null && profile.Has("useDissolve"))
                operations.Add(new JObject().Set("op", "dissolve").Set("enabled", profile.Get("useDissolve")));
            if (profile != null && profile.Has("useDistortion"))
                operations.Add(new JObject().Set("op", "scene-refraction"));
            if (profile != null && profile.Has("fading"))
                operations.Add(new JObject().Set("op", "soft-particle-depth").Set("enabled", profile.Get("fading")));
            if (profile != null && profile.Has("dynamicAlphaClip"))
            {
                if (sourceGraph == null || string.IsNullOrEmpty(sourceGraph.AlphaClipSource))
                    throw new System.InvalidOperationException(
                        $"Dynamic AlphaClipThreshold for {sourceGraph?.SourceHash ?? "builtin"} " +
                        "has no component-qualified semantic source.");
                operations.Add(new JObject().Set("op", "dynamic-alpha-clip")
                    .Set("source", sourceGraph.AlphaClipSource)
                    .Set("scale", profile.Get("dynamicAlphaClipScale")));
            }
            if (profile != null && profile.Has("hdrMultiply"))
                operations.Add(new JObject().Set("op", "hdr-multiply"));
            if (multiplyColored)
                operations.Add(new JObject().Set("op", "legacy-multiply-colored"));
            if (legacyMultiply)
                operations.Add(new JObject().Set("op", "legacy-particle-multiply"));
            if (legacyPremultiply)
                operations.Add(new JObject().Set("op", "legacy-particle-premultiply"));
            if (legacyDoubleTint)
                operations.Add(new JObject().Set("op", "legacy-double-tint"));
            if (legacyVertexColorRaw)
                operations.Add(new JObject().Set("op", "vertex-color-space")
                    .Set("id", "legacy-vertex-color-raw@1")
                    .Set("sourceMaterialGuid", materialGuid)
                    .Set("space", "raw-linear-attribute")
                    .Set("requiresOracle", true));
            if (legacyMaterialLowering != null)
                operations.Add(new JObject().Set("op", "manual-material-lowering")
                    .Set("id", legacyMaterialLowering)
                    .Set("sourceMaterialGuid", materialGuid)
                    .Set("alphaFactor", manualLegacyAlphaFactor)
                    .Set("vertexColorSpace", materialGuid == "c1b09b1ca8ba05d4682ccf6db6b1102d"
                        ? "raw-linear-attribute" : "project-authored")
                    .Set("requiresOracle", true));
            string blendProgram = legacyPremultiply ? "premultiplied-alpha"
                : LastBlendMode == 1 ? "additive" : LastBlendMode == 4 ? "multiply" : "alpha";
            operations.Add(new JObject().Set("op", "blend")
                .Set("mode", blendProgram));

            return new JObject()
                .Set("schema", "particle-material-program@2")
                .Set("compiler", legacyParticle
                    ? "unity-legacy-particle-material-compiler@1"
                    : (vefectsZap || vefectsExtraParticles || vefectsErosionParticles || vefectsHeatHaze
                        || ericAdditiveFlow || ericAlphaFlow || egaFireSphere) ? "unity-reviewed-shader-family-compiler@1"
                    : "unity-shadergraph-semantic-compiler@2")
                .Set("sourceGraphHash", sourceGraph?.SourceHash ?? "builtin")
                .Set("sourceMaterialGuid", materialGuid)
                .Set("lowering", legacyMaterialLowering ?? manualLowering ?? (vefectsZap
                    ? "vefects-zap-green-coverage@1" : vefectsExtraParticles
                    ? "vefects-extra-particles-red-coverage@1" : vefectsErosionParticles
                    ? "vefects-erosion-mask-coverage@1" : vefectsHeatHaze
                    ? "vefects-heat-haze-omitted-missing-custom1z@1"
                    : ericAdditiveFlow ? "eric-additive-flow-premultiplied@1"
                    : ericAlphaMissing ? "unsupported-required-main-alpha-missing@1"
                    : ericAlphaFlow ? "eric-alpha-flow@1"
                    : egaFireSphere ? "ega-fire-sphere-red-coverage@1" : legacyParticle
                    ? (alpha8Additive ? "unity-legacy-alpha8-additive@1" : "unity-legacy-particle-blend@1")
                    : urpLit
                    ? "unity-urp-lit-reference@1" : "verified-supported-subset"))
                .Set("template", template)
                .Set("mainTexture", mainTextureUuid)
                .Set("coverageSource", coverage)
                .Set("blend", blendProgram)
                .Set("operations", operations)
                .Set("profile", profile ?? new JObject()
                    .Set("singleChannel", false)
                    .Set("vertexColorRgb", true)
                    .Set("vertexColorAlpha", true)
                    .Set("additive", LastBlendMode == 1)
                    .Set("color", new JArray().Add(1).Add(1).Add(1).Add(1)));
        }

        /// <summary>
        /// Reviewed source families only.  This is deliberately a shader identity allow-list,
        /// not a material-name heuristic: every member has the stock particle texture × vertex
        /// color/tint program and alpha/additive blend declared by Unity's shader source.
        /// </summary>
        private static bool IsReviewedLegacyParticleShader(string shaderName)
        {
            return MaterialShaderFamilyRegistry.IsLegacyParticle(shaderName);
        }

        /// <summary>
        /// Stock URP particle unlit and the reviewed ERB particle family all lower to the
        /// same explicit texture × vertex-color program. Their shader names are stable source
        /// identities; this is not a material/effect-name heuristic.
        /// </summary>
        private static bool IsReviewedBuiltinParticleShader(string shaderName)
        {
            return MaterialShaderFamilyRegistry.IsReviewedBuiltin(shaderName);
        }

        /// <summary>Property slot comes from the reviewed shader family, never material naming.</summary>
        private static bool TryGetSemanticTint(Material mat, out Color tint)
        {
            string shaderName = mat != null && mat.shader != null ? mat.shader.name ?? "" : "";
            // CFXM_MobileParticleAdd_Alpha8.shader has no TintColor property or operation.
            // Serialized legacy materials can retain `_TintColor` from a previous shader, but
            // that value is dead data and must never become a live opacity/color instruction.
            if (shaderName == "Cartoon FX/Legacy/Particles Additive Alpha8"
                || shaderName == "Legacy Shaders/Particles/Multiply"
                || shaderName == "Legacy Shaders/Particles/Alpha Blended Premultiply")
            {
                tint = Color.white;
                return true;
            }
            if (IsReviewedLegacyParticleShader(shaderName)
                && TryGetMaterialColor(mat, "_TintColor", out tint))
                return true;
            return TryGetMaterialColor(mat, "_Color", out tint)
                || TryGetMaterialColor(mat, "_BaseColor", out tint);
        }

        private void BindMap(Material mat, JObject maps, string key, params string[] propertyNames)
        {
            foreach (string prop in propertyNames)
            {
                if (!TryGetMaterialTexture(mat, prop, out Texture tex) || tex == null) continue;
                maps.Set(key, AddTexture(tex));
                return;
            }
        }

        /// <summary>
        /// Serializes particle-ubershader floats so the Web player stays data-driven.
        /// Covers CFXR and Shader Graph packs (dissolve/HDR) even when the shader fails to
        /// compile in batchmode (Hidden/InternalErrorShader) — reads SavedProperties.
        /// </summary>
        private JObject BuildParticleFxBlock(Material mat, JObject maps)
        {
            if (mat == null) return null;
            string shaderName = mat.shader != null ? (mat.shader.name ?? "") : "";

            bool hasDissolveMap = maps != null && maps.Has("dissolve");
            bool looksCfxr = shaderName.IndexOf("Cartoon FX", System.StringComparison.OrdinalIgnoreCase) >= 0
                || shaderName.IndexOf("CFXR", System.StringComparison.OrdinalIgnoreCase) >= 0
                || mat.HasProperty("_HdrMultiply")
                || mat.HasProperty("_SingleChannel")
                || (mat.HasProperty("_UseDissolve") && mat.GetFloat("_UseDissolve") > 0.5f)
                || mat.IsKeywordEnabled("_CFXR_DISSOLVE");

            bool hasHdrTint = false;
            Color tint = Color.white;
            if (TryGetMaterialColor(mat, "_Color", out tint) || TryGetMaterialColor(mat, "_BaseColor", out tint))
                hasHdrTint = Mathf.Max(tint.r, Mathf.Max(tint.g, tint.b)) > 1.01f;
            bool reviewedLegacyParticle = IsReviewedLegacyParticleShader(shaderName);

            // Shader Graph packs (Free Slash etc.) often drive look via mask / FrontColor /
            // screen distortion without CFXR keywords or HDR _Color.
            bool hasTrailStyle = TryGetMaterialColor(mat, "_FrontColor", out _);
            bool hasMaskMap = maps != null && maps.Has("mask");
            bool hasDistortionAmt = TryGetMaterialFloat(mat, "_Distortion", out float distProbe) && distProbe > 1e-5f;
            ShaderGraphInfo graphInfo = ShaderGraphAnalyzer.Analyze(mat.shader);
            string manualLowering = ManualGraphLowering(graphInfo?.SourceHash);
            bool urpLit = shaderName == "Universal Render Pipeline/Lit";
            bool reviewedHeatHaze = shaderName == "SH_Vefects_VFX_URP_Heat_Haze_01";
            bool reviewedEgaFireSphere = shaderName == "EGA/Particles/FireSphere";
            if (!reviewedLegacyParticle && !looksCfxr && !hasDissolveMap && !hasHdrTint && !hasTrailStyle && !hasMaskMap
                && !hasDistortionAmt && manualLowering == null && !urpLit && !reviewedHeatHaze
                && !reviewedEgaFireSphere)
                return null;

            var cfxr = new JObject()
                .Set("shader", shaderName);

            if (reviewedHeatHaze)
            {
                // This source shader requires Custom1.z in its alpha/refraction chain. Quarks'
                // current billboard batch does not carry that authored custom stream, so a
                // partial lowering exposes the rectangular distortion mesh. Omit this optional
                // secondary layer safely until the required stream is representable in IR.
                cfxr.Set("singleChannel", true)
                    .Set("coverageChannel", "green")
                    .Set("vertexColorRgb", false)
                    .Set("vertexColorAlpha", true)
                    .Set("useDistortion", false)
                    .Set("sceneColor", false)
                    .Set("opacity", 0f)
                    .Set("semanticOmission", "missing-particle-custom1-z")
                    .Set("color", new JArray().Add(0).Add(0).Add(0).Add(1));
                if (maps != null && maps.Has("main"))
                    cfxr.Set("distortionMap", maps.Get("main"));
                if (maps != null && maps.Has("mask"))
                    cfxr.Set("useMask", true)
                        .Set("maskMap", maps.Get("mask"))
                        .Set("maskChannel", "red");
                if (TryGetMaterialFloat(mat, "_DistortionStrength", out float heatStrength))
                    cfxr.Set("distortionAmount", heatStrength * 0.02f);
            }

            if (urpLit)
            {
                // A Lit mesh is not equivalent to an unlit white texture-tint program. Export
                // the reference scene's ambient probe explicitly so the Web lowering remains
                // deterministic and the camera oracle uses the same scene input.
                Color sky = RenderSettings.ambientSkyColor.linear;
                Color equator = RenderSettings.ambientEquatorColor.linear;
                Color ground = RenderSettings.ambientGroundColor.linear;
                SphericalHarmonicsL2 probe = RenderSettings.ambientProbe;
                var sh = new JArray();
                for (int coefficient = 0; coefficient < 9; coefficient++)
                    sh.Add(new JArray().Add(probe[0, coefficient])
                        .Add(probe[1, coefficient]).Add(probe[2, coefficient]));
                cfxr.Set("lightingModel", "unity-urp-lit-reference@1")
                    .Set("doubleSided", !(TryGetMaterialFloat(mat, "_Cull", out float cull)
                        && Mathf.RoundToInt(cull) == 2))
                    .Set("ambientSky", new JArray().Add(sky.r).Add(sky.g).Add(sky.b))
                    .Set("ambientEquator", new JArray().Add(equator.r).Add(equator.g).Add(equator.b))
                    .Set("ambientGround", new JArray().Add(ground.r).Add(ground.g).Add(ground.b))
                    .Set("ambientSH", sh);
            }

            if (TryGetMaterialFloat(mat, "_HdrMultiply", out float hdrMul))
                cfxr.Set("hdrMultiply", hdrMul);
            else if (hasHdrTint)
            {
                // Shader Graph packs encode emission in HDR _Color — split peak vs chroma.
                // Export the REAL peak; the Web fidelity shader tonemaps (Unity URP does the same
                // via HDR framebuffer + bloom). Pre-softening here loses 3-4× of core brightness.
                float peak = Mathf.Max(tint.r, Mathf.Max(tint.g, tint.b));
                cfxr.Set("hdrMultiply", Mathf.Clamp(peak, 1f, 16f));
                tint = new Color(tint.r / peak, tint.g / peak, tint.b / peak, tint.a);
            }

            // Shader Graph wiring analysis: does the albedo sheet drive Alpha (coverage) or RGB?
            // This replaces pixel-guessing with the graph's actual edges (works for any SG pack).
            FindAlbedoTexture(mat, out string albedoProp);
            if (graphInfo != null && albedoProp != null)
            {
                bool inAlpha = graphInfo.AlphaTextures.Contains(albedoProp);
                bool inColor = graphInfo.ColorTextures.Contains(albedoProp);
                // Coverage sheet: shapes alpha but never colors the pixel → RGB comes from tint/HDR.
                cfxr.Set("singleChannel", inAlpha && !inColor);
            }
            else if (mat.HasProperty("_SingleChannel"))
                cfxr.Set("singleChannel", mat.GetFloat("_SingleChannel") > 0.5f);
            else if (looksCfxr)
                cfxr.Set("singleChannel", mat.IsKeywordEnabled("_CFXR_SINGLE_CHANNEL"));

            if (graphInfo != null && graphInfo.SceneColorInColor)
                cfxr.Set("sceneColor", true);

            // Whether the graph actually samples Vertex Color per chain. Graphs that skip it
            // (e.g. _CustomVertexColor variants) must not be darkened/faded by Shuriken color.
            if (graphInfo != null)
            {
                cfxr.Set("vertexColorRgb", graphInfo.VertexColorInColor);
                cfxr.Set("vertexColorAlpha", graphInfo.VertexColorInAlpha);
                // Slash World reads TEXCOORD1, then Split + Vector2(G,R) swizzles it before
                // TilingAndOffset. The authored vertex stream binds ParticleSystem Custom1.xy
                // to TEXCOORD1.xy, so the exact graph operation is UV0 += Custom1.yx.
                cfxr.Set("mainUvTransform", manualLowering == "slash-world@3"
                    ? "offset-custom1-yx"
                    : manualLowering == "slash-screen@2" ? "offset-x-custom1-y"
                    : manualLowering == "trail-front-face@2" ? "trail-front-face@2" : "identity");
            }
            if (manualLowering != null) cfxr.Set("manualGraphLowering", manualLowering);
            bool orbWarp = manualLowering == "orb-warp@1" || manualLowering == "orb-warp-lit@1";
            if (orbWarp)
            {
                if (maps != null && maps.Has("alpha")) cfxr.Set("orbAlphaMap", maps.Get("alpha"));
                else cfxr.Set("orbAlphaConstantOne", true);
                if (maps != null && maps.Has("noise")) cfxr.Set("orbNoiseMap", maps.Get("noise"));
                if (maps != null && maps.Has("distortion")) cfxr.Set("distortionMap", maps.Get("distortion"));
                if (TryGetMaterialColor(mat, "_Colour", out Color colour))
                    cfxr.Set("orbColour", new JArray().Add(colour.r).Add(colour.g).Add(colour.b));
                if (TryGetMaterialColor(mat, "_FresnelColor", out Color fresnel))
                    cfxr.Set("orbFresnelColor", new JArray()
                        .Add(fresnel.r).Add(fresnel.g).Add(fresnel.b).Add(fresnel.a));
                if (TryGetMaterialColor(mat, "_NoiseAnimation", out Color noiseAnimation))
                    cfxr.Set("orbNoiseAnimation", new JArray().Add(noiseAnimation.r).Add(noiseAnimation.g));
                if (TryGetMaterialColor(mat, "_WarpSpeed", out Color warpSpeed))
                    cfxr.Set("orbWarpSpeed", new JArray().Add(warpSpeed.r).Add(warpSpeed.g));
                if (TryGetMaterialFloat(mat, "_FresnelPower", out float fresnelPower)) cfxr.Set("orbFresnelPower", fresnelPower);
                if (TryGetMaterialFloat(mat, "_NoiseScale", out float noiseScale)) cfxr.Set("orbNoiseScale", noiseScale);
                if (TryGetMaterialFloat(mat, "_NoiseFrequency", out float noiseFrequency)) cfxr.Set("orbNoiseFrequency", noiseFrequency);
                if (TryGetMaterialFloat(mat, "_NoiseAmplitude", out float noiseAmplitude)) cfxr.Set("orbNoiseAmplitude", noiseAmplitude);
                if (TryGetMaterialFloat(mat, "_NoiseOctaveFrequencyScale", out float octaveFrequency)) cfxr.Set("orbOctaveFrequencyScale", octaveFrequency);
                if (TryGetMaterialFloat(mat, "_NoiseOctaveAmplitudeScale", out float octaveAmplitude)) cfxr.Set("orbOctaveAmplitudeScale", octaveAmplitude);
                if (TryGetMaterialFloat(mat, "_NoiseOctaveDomainWarping", out float domainWarp)) cfxr.Set("orbOctaveDomainWarping", domainWarp);
                if (TryGetMaterialFloat(mat, "_NoisePower", out float noisePower)) cfxr.Set("orbNoisePower", noisePower);
                if (TryGetMaterialFloat(mat, "_Clip", out float orbClip)) cfxr.Set("orbUvClipScale", orbClip);
                cfxr.Set("orbVertexAlphaChannel", manualLowering == "orb-warp-lit@1" ? "alpha" : "green");
            }
            if (manualLowering == "slash-world@3")
            {
                bool vertexAlpha = TryGetMaterialFloat(mat, "_Distortion", out float slashDistortion)
                    && Mathf.Abs(slashDistortion) > 1e-6f;
                cfxr.Set("slashWorldVertexAlpha", vertexAlpha);
                if (TryGetMaterialColor(mat, "_Offset", out Color screenOffset))
                    cfxr.Set("slashWorldScreenOffset", new JArray()
                        .Add(screenOffset.r).Add(screenOffset.g));
            }
            if (manualLowering == "trail-front-face@2")
            {
                cfxr.Set("frontFaceColorSelect", true);
                // Exact material operands of the reviewed Trail.shadergraph UV DAG.
                if (TryGetMaterialFloat(mat, "_Rotation", out float trailRotation))
                    cfxr.Set("trailUvRotation", trailRotation);
                if (TryGetMaterialFloat(mat, "_Strech", out float trailStretch))
                    cfxr.Set("trailUvStretch", trailStretch);
                if (TryGetMaterialFloat(mat, "_StrechY", out float trailStretchY))
                    cfxr.Set("trailUvStretchY", trailStretchY > 0.5f);
                if (TryGetMaterialFloat(mat, "_Enable_Speed_Control", out float speedControl))
                    cfxr.Set("trailUvSpeedFromCustom2", speedControl > 0.5f);
                float scrollX = 0f, scrollY = 0f;
                TryGetMaterialFloat(mat, "_ScrollX", out scrollX);
                TryGetMaterialFloat(mat, "_ScrollY", out scrollY);
                cfxr.Set("trailUvScroll", new JArray().Add(scrollX).Add(scrollY));
                if (TryGetMaterialColor(mat, "_Tilling", out Color trailTiling))
                    cfxr.Set("trailUvTiling", new JArray().Add(trailTiling.r).Add(trailTiling.g));
                if (TryGetMaterialColor(mat, "_Offset", out Color trailOffset))
                    cfxr.Set("trailUvOffset", new JArray().Add(trailOffset.r).Add(trailOffset.g));
                if (TryGetMaterialFloat(mat, "_DistortionPower", out float trailDistortionPower))
                    cfxr.Set("trailUvDistortionPower", trailDistortionPower);
                if (TryGetMaterialColor(mat, "_DistortionSpeed", out Color trailDistortionSpeed))
                    cfxr.Set("trailUvDistortionSpeed", new JArray()
                        .Add(trailDistortionSpeed.r).Add(trailDistortionSpeed.g));
                if (maps != null && maps.Has("distortion"))
                    cfxr.Set("distortionMap", maps.Get("distortion"));
            }
            if (manualLowering == "slash-screen@2")
            {
                // Reviewed Slash.shadergraph alpha DAG:
                // Shader Graph SampleTexture2D slot 4 is R (slots 4/5/6/7 = R/G/B/A):
                // saturate(main.r * _Opacity) * vertex.a
                // * saturate(lerp(1-dissolve.r, 0, custom1.x)
                //            + step(custom1.x, 1-dissolve.r)) * mask.r * softDepth.
                // Custom1.y is also wired into the X component of the main UV offset.
                if (TryGetMaterialColor(mat, "_DissolveScroll", out Color dissolveScroll))
                    cfxr.Set("dissolveScroll", new JArray().Add(dissolveScroll.r).Add(dissolveScroll.g));
            }
            if (manualLowering == "parallax-occlusion@1")
            {
                if (maps != null && maps.Has("height")) cfxr.Set("heightMap", maps.Get("height"));
                if (TryGetMaterialFloat(mat, "_ParallaxAmplitude", out float amplitude))
                    cfxr.Set("parallaxAmplitude", amplitude);
            }

            bool explicitDissolve = (TryGetMaterialFloat(mat, "_UseDissolve", out float useDiss) && useDiss > 0.5f)
                || mat.IsKeywordEnabled("_CFXR_DISSOLVE");
            // Leftover `_DissolveTex` often equals distortion (or albedo) on graphs that never dissolve.
            // Compare Unity Texture references — AddTexture() mints a new uuid per bind, so map
            // uuid equality is meaningless.
            TryGetMaterialTexture(mat, "_DissolveTex", out Texture dissolveTex);
            if (dissolveTex == null) TryGetMaterialTexture(mat, "_DissolveMap", out dissolveTex);
            TryGetMaterialTexture(mat, "_DistortionTex", out Texture distortionTex);
            if (distortionTex == null) TryGetMaterialTexture(mat, "_DistortionMap", out distortionTex);
            Texture mainAlbedo = FindAlbedoTexture(mat);
            bool dissolveIsDistortionClone = dissolveTex != null && distortionTex != null && dissolveTex == distortionTex;
            bool dissolveIsMainClone = dissolveTex != null && mainAlbedo != null && dissolveTex == mainAlbedo;
            bool dedicatedDissolve = hasDissolveMap && !dissolveIsDistortionClone && !dissolveIsMainClone;
            // Do NOT treat mere presence of `_InvertDissolve*` as "use dissolve" — many SG
            // templates declare the float at 0 while dissolve is unused leftover.
            // Texture-slot presence is not execution semantics. Shader Graph templates retain
            // assigned dissolve textures in disabled branches; only an authored enable switch
            // (or the explicit CFXR contract) may activate the instruction.
            bool useDissolve = manualLowering == "slash-screen@2" || explicitDissolve
                || (looksCfxr && hasDissolveMap && !dissolveIsDistortionClone);
            cfxr.Set("useDissolve", useDissolve);

            // Static Shader Graph alpha clipping is independent from dissolve. A material may
            // retain an unused _DissolveTex slot while its graph still clips Alpha by _Clip
            // (Impact.shadergraph does exactly this). Export the authored threshold whenever
            // dissolve is not actually active; otherwise soft texels incorrectly reach bloom.
            bool graphOrLegacyClipEnabled = graphInfo != null
                ? graphInfo.AlphaClipEnabled
                : TryGetMaterialFloat(mat, "_AlphaClip", out float alphaClipOn) && alphaClipOn > 0.5f;
            bool staticAlphaClip =
                graphOrLegacyClipEnabled
                && !useDissolve
                && (graphInfo == null || !graphInfo.AlphaClipDynamic);
            if (staticAlphaClip)
            {
                float cutoff = 0.5f;
                if (TryGetMaterialFloat(mat, "_Clip", out float graphCutoff))
                    cutoff = graphCutoff;
                else if (TryGetMaterialFloat(mat, "_Cutoff", out float legacyCutoff))
                    cutoff = legacyCutoff;
                cfxr.Set("alphaClipThreshold", Mathf.Clamp01(cutoff));
            }
            else if (!orbWarp && !useDissolve && graphInfo != null && graphInfo.AlphaClipEnabled
                && graphInfo.AlphaClipDynamic)
            {
                float scale = 1f;
                if (TryGetMaterialFloat(mat, "_Clip", out float authoredScale)) scale = authoredScale;
                // Fold a zero material multiplier to a disabled clip operation. This is exact,
                // and avoids demanding runtime support for the dead upstream graph branch.
                if (Mathf.Abs(scale) > 1e-6f)
                {
                    if (string.IsNullOrEmpty(graphInfo.AlphaClipSource))
                        throw new System.InvalidOperationException(
                            $"Dynamic AlphaClipThreshold for {graphInfo.SourceHash} is outside the strict subset.");
                    cfxr.Set("dynamicAlphaClip", true)
                        .Set("dynamicAlphaClipSource", graphInfo.AlphaClipSource)
                        .Set("dynamicAlphaClipScale", scale);
                }
            }

            if (TryGetMaterialFloat(mat, "_DissolveSmooth", out float dissolveSmooth))
                cfxr.Set("dissolveSmooth", dissolveSmooth);
            else if (useDissolve && !looksCfxr)
                cfxr.Set("dissolveSmooth", 0.12f);

            // CFXR.cginc: invert when `_InvertDissolveTex <= 0`. Shader Graph `_InvertDissolve`
            // is a boolean-style 0/1 (1 = invert). Prefer explicit props via SavedProperties.
            if (useDissolve)
            {
                if (TryGetMaterialFloat(mat, "_InvertDissolveTex", out float invertCfxr))
                    cfxr.Set("invertDissolve", invertCfxr <= 0f);
                else if (TryGetMaterialFloat(mat, "_InvertDissolve", out float invertSg))
                    cfxr.Set("invertDissolve", invertSg > 0.5f);
                else
                    cfxr.Set("invertDissolve", looksCfxr); // CFXR default invert; SG default off
            }

            if (useDissolve && maps != null && maps.Has("dissolve"))
                cfxr.Set("dissolveMap", maps.Get("dissolve"));

            // Assigned texture slots are not execution semantics. Shader Graph assets often
            // retain stale/default `_MaskTex` bindings that are absent from every active output
            // chain (ParallaxOcclusion is one such graph). Only emit the mask instruction when
            // graph reachability proves it is consumed; legacy CFXR keeps its authored contract.
            bool graphConsumesMask = graphInfo != null
                && (graphInfo.AlphaTextures.Contains("_MaskTex")
                    || graphInfo.AlphaTextures.Contains("_Mask")
                    || graphInfo.ColorTextures.Contains("_MaskTex")
                    || graphInfo.ColorTextures.Contains("_Mask"));
            bool maskIsActive = maps != null && maps.Has("mask")
                && (graphInfo == null ? looksCfxr : graphConsumesMask);
            if (maskIsActive)
            {
                cfxr.Set("useMask", true);
                cfxr.Set("maskMap", maps.Get("mask"));
                // The supported Shader Graph template consumes Sample Texture 2D's A output.
                // Legacy/CFXR masks consume the red channel. This is an explicit IR operand,
                // not a runtime image-content guess.
                cfxr.Set("maskChannel", "red");
                if (manualLowering != "trail-front-face@2"
                    && graphInfo != null && TryGetMaterialFloat(mat, "_MaskNoise", out float maskNoise))
                    cfxr.Set("maskWarp", "simple-noise-product").Set("maskNoiseScale", maskNoise);
                if (TryGetMaterialColor(mat, "_MaskSpeed", out Color maskSpeed))
                    cfxr.Set("maskSpeed", new JArray().Add(maskSpeed.r).Add(maskSpeed.g));
                if (TryGetMaterialFloat(mat, "_MaskRotation", out float maskRotation))
                    cfxr.Set("maskRotation", maskRotation);
                if (manualLowering == "trail-front-face@2"
                    && TryGetMaterialColor(mat, "_MaskCenter", out Color maskCenter))
                    cfxr.Set("maskOffset", new JArray().Add(maskCenter.r).Add(maskCenter.g));
                else if (TryGetMaterialColor(mat, "_RotationCenter", out Color rotationCenter))
                    cfxr.Set("maskRotationCenter", new JArray().Add(rotationCenter.r).Add(rotationCenter.g));
            }

            bool distortionEnabled = maps != null && maps.Has("distortion")
                && ((TryGetMaterialFloat(mat, "_DistortionEnabled", out float distOn) && distOn > 0.5f)
                    || (TryGetMaterialFloat(mat, "_Distortion", out float distAmt) && distAmt > 1e-5f));
            // Graph wiring is authoritative: screen refraction only exists when the BaseColor
            // chain actually samples Scene Color (leftover _Distortion floats otherwise mislead).
            if (graphInfo != null && !graphInfo.SceneColorInColor)
                distortionEnabled = false;
            if (distortionEnabled)
            {
                cfxr.Set("useDistortion", true);
                cfxr.Set("distortionMap", maps.Get("distortion"));
                if (TryGetMaterialFloat(mat, "_Distortion", out float da))
                    cfxr.Set("distortionAmount", da);
                else
                    cfxr.Set("distortionAmount", 0.02f);
            }

            // Trail dual HDR colors: graph BaseColor = lerp(_BackColor, _FrontColor, tex).
            // Normalize both against the front peak so the runtime lerp × hdrMultiply
            // reproduces the original HDR values exactly.
            if (TryGetMaterialColor(mat, "_FrontColor", out Color front))
            {
                float fp = Mathf.Max(front.r, Mathf.Max(front.g, front.b, 1e-4f));
                cfxr.Set("frontColor", new JArray().Add(front.r / fp).Add(front.g / fp).Add(front.b / fp).Add(front.a));
                if (!TryGetMaterialFloat(mat, "_HdrMultiply", out _) && !hasHdrTint)
                    cfxr.Set("hdrMultiply", Mathf.Clamp(fp, 1f, 16f));
                tint = new Color(front.r / fp, front.g / fp, front.b / fp, front.a);

                if (TryGetMaterialColor(mat, "_BackColor", out Color back))
                {
                    cfxr.Set("backColor", new JArray().Add(back.r / fp).Add(back.g / fp).Add(back.b / fp).Add(back.a));
                }
            }

            // `_Opacity` is a stale, disconnected property in the reviewed Trail graph.
            // Exporting it into the Alpha chain inflated coverage by 25.82x.
            if (manualLowering == "trail-front-face@2" || manualLowering == "slash-world@3")
                cfxr.Set("opacity", 1f);
            else if (TryGetMaterialFloat(mat, "_Opacity", out float opacity))
                cfxr.Set("opacity", opacity);
            if (TryGetMaterialFloat(mat, "_TexPower", out float texPower))
                cfxr.Set("texPower", texPower);
            if (TryGetMaterialFloat(mat, "_ColorPower", out float colorPower))
                cfxr.Set("colorPower", colorPower);

            // Legacy particle shaders declare `_TintColor` as their authored modulation slot;
            // keep RGB and alpha together in the live program (alpha is the coverage gain).
            if (TryGetSemanticTint(mat, out Color semanticTint)) tint = semanticTint;
            if (reviewedHeatHaze)
                cfxr.Set("color", new JArray().Add(0).Add(0).Add(0).Add(1));
            else
                cfxr.Set("color", new JArray().Add(tint.r).Add(tint.g).Add(tint.b).Add(tint.a));
            if (IsReviewedLegacyParticleShader(shaderName)) cfxr.Set("opacity", tint.a);

            if (TryGetMaterialFloat(mat, "_RingTopOffset", out float ringTop))
                cfxr.Set("ringTopOffset", ringTop);

            // Trail graph directly multiplies both BaseColor and Alpha by
            // saturate((SceneDepthEye-ScreenPosition.w) * _SoftParticles). `_Soft_Particle`
            // is legacy saved data and is not connected to the graph.
            float trailSoft = 0f;
            bool strictTrailSoft = manualLowering == "trail-front-face@2"
                && TryGetMaterialFloat(mat, "_SoftParticles", out trailSoft)
                && trailSoft > 0f;
            float legacyInvFade = 0f;
            // Built-in SoftParticles uses a pipeline-specific depth convention. Do not lower it
            // through the reviewed ShaderGraph depth path until that convention has its own IR
            // adapter; sharing the path shifts the ground intersection in regression captures.
            bool legacySoftParticle = false;
            bool softParticle = strictTrailSoft || legacySoftParticle
                || (manualLowering != "trail-front-face@2" && (
                mat.IsKeywordEnabled("_FADING_ON")
                || (TryGetMaterialFloat(mat, "_UseSP", out float useSp) && useSp > 0.5f)
                || (TryGetMaterialFloat(mat, "_Soft_Particle", out float soft) && soft > 0.5f)));
            cfxr.Set("fading", softParticle);
            if (strictTrailSoft)
                cfxr.Set("softParticle", trailSoft);
            else if (legacySoftParticle)
                // Built-in Particle/Additive (Soft): fade = saturate(_InvFade * depthDelta).
                cfxr.Set("softParticle", legacyInvFade);
            else if (softParticle && TryGetMaterialFloat(mat, "_Soft_Particle", out float softAmt))
            {
                cfxr.Set("softParticle", softAmt);
                // This reviewed graph's Raw ScreenPosition/SceneDepth(Eye) branch was qualified
                // against the Unity render buffer. Make the backend unit conversion explicit in
                // IR rather than hiding it as a runtime/effect-specific multiplier.
                if (manualLowering == "slash-screen@2")
                    cfxr.Set("softParticleDepthScale", 0.1f);
            }

            // Respect authored blend. HDR punch is hdrMultiply + bloom, not forced additive
            // (forcing additive + HDR turns soft sheets into screen-wide white beams).
            bool additive = mat.IsKeywordEnabled("_CFXR_ADDITIVE") || LastBlendMode == 1;
            cfxr.Set("additive", additive);
            cfxr.Set("proceduralRing",
                shaderName.IndexOf("Procedural Ring", System.StringComparison.OrdinalIgnoreCase) >= 0);

            return cfxr;
        }

        private static bool HasNonZeroDissolveScroll(Material mat)
        {
            if (!TryGetMaterialColor(mat, "_DissolveScroll", out Color scroll)) return false;
            return Mathf.Abs(scroll.r) + Mathf.Abs(scroll.g) > 1e-5f;
        }

        /// <summary>
        /// Resolves the particle albedo / opacity sheet. Prefer explicit albedo slots via
        /// m_SavedProperties (Shader Graph often fails HasProperty / leaves mainTexture null
        /// or pointing at a non-albedo). Never guess "first assigned texture" — that picks
        /// dissolve/mask/noise as albedo and wrecks Free Slash / similar packs.
        /// </summary>
        private static Texture FindAlbedoTexture(Material mat) => FindAlbedoTexture(mat, out _);

        private static Texture FindAlbedoTexture(Material mat, out string matchedProperty)
        {
            matchedProperty = null;
            if (mat == null) return null;

            ShaderGraphInfo graph = ShaderGraphAnalyzer.Analyze(mat.shader);
            if (graph != null)
            {
                string reviewedProperty = ManualGraphMainTexture(graph.SourceHash);
                if (reviewedProperty != null
                    && TryGetMaterialTexture(mat, reviewedProperty, out Texture reviewed)
                    && reviewed != null)
                {
                    matchedProperty = reviewedProperty;
                    return reviewed;
                }

                // For the generated strict subset, graph reachability defines texture role.
                // Prefer a unique texture shared by BaseColor and Alpha, otherwise require a
                // unique texture feeding either output. Ambiguity is rejected instead of falling
                // back to a property-name guess.
                var shared = new List<string>();
                foreach (string prop in graph.ColorTextures)
                    if (graph.AlphaTextures.Contains(prop)
                        && TryGetMaterialTexture(mat, prop, out Texture t) && t != null)
                        shared.Add(prop);
                var relevant = new List<string>();
                var seen = new HashSet<string>();
                foreach (string prop in graph.ColorTextures.Concat(graph.AlphaTextures))
                    if (seen.Add(prop) && TryGetMaterialTexture(mat, prop, out Texture t) && t != null)
                        relevant.Add(prop);
                string semanticProperty = shared.Count == 1 ? shared[0]
                    : shared.Count == 0 && relevant.Count == 1 ? relevant[0]
                    : null;
                if (semanticProperty != null
                    && TryGetMaterialTexture(mat, semanticProperty, out Texture semantic)
                    && semantic != null)
                {
                    matchedProperty = semanticProperty;
                    return semantic;
                }
                if (shared.Count > 1 || relevant.Count > 1)
                    throw new System.InvalidOperationException(
                        $"Shader Graph {graph.SourceHash} has ambiguous output textures: "
                        + string.Join(", ", relevant));
            }

            // Trail-style graphs expose the real sheet on `_MainTex` while `_Main` often holds
            // leftover noise. Detect via `_FrontColor` (data-driven), not shader name cases.
            bool trailStyle = TryGetMaterialColor(mat, "_FrontColor", out _);
            string[] preferred = trailStyle
                ? new[]
                {
                    "_MainTex", "_BaseMap", "_Main", "_ZapTexture", "_BaseColorMap", "_Albedo",
                    "_Diffuse", "_Base_Map", "_Texture", "_MaskTexture", "_Mask_Texture", "_MainTexture",
                }
                : new[]
                {
                    "_Main", "_BaseMap", "_MainTex", "_ZapTexture", "_BaseColorMap", "_Albedo",
                    "_Diffuse", "_Base_Map", "_Texture", "_MaskTexture", "_Mask_Texture", "_MainTexture",
                };
            foreach (string name in preferred)
            {
                if (TryGetMaterialTexture(mat, name, out Texture t) && t != null)
                {
                    matchedProperty = name;
                    return t;
                }
            }

            // Built-in particle shaders: only after named slots miss.
            if (mat.mainTexture != null) return mat.mainTexture;
            return null;
        }

        /// <summary>
        /// Reads a Texture via Material API or serialized m_TexEnvs (Shader Graph safe).
        /// </summary>
        private static bool TryGetMaterialTexture(Material mat, string name, out Texture tex)
        {
            tex = null;
            if (mat == null || string.IsNullOrEmpty(name)) return false;
            if (mat.HasProperty(name))
            {
                tex = mat.GetTexture(name);
                if (tex != null) return true;
            }
            var so = new SerializedObject(mat);
            var texEnvs = so.FindProperty("m_SavedProperties.m_TexEnvs");
            if (texEnvs == null) return false;
            for (int i = 0; i < texEnvs.arraySize; i++)
            {
                var el = texEnvs.GetArrayElementAtIndex(i);
                var key = el.FindPropertyRelative("first");
                if (key == null || key.stringValue != name) continue;
                var second = el.FindPropertyRelative("second");
                var texProp = second != null ? second.FindPropertyRelative("m_Texture") : null;
                if (texProp != null && texProp.objectReferenceValue is Texture t)
                {
                    tex = t;
                    return true;
                }
            }
            return false;
        }

        /// <summary>
        /// Reads a Color either via Material.HasProperty or from serialized m_Colors
        /// (needed for CFXR / Shader Graph when HasProperty lies).
        /// </summary>
        private static bool TryGetMaterialColor(Material mat, string name, out Color color)
        {
            color = Color.white;
            if (mat == null || string.IsNullOrEmpty(name)) return false;
            if (mat.HasProperty(name))
            {
                color = mat.GetColor(name);
                return true;
            }
            var so = new SerializedObject(mat);
            var colors = so.FindProperty("m_SavedProperties.m_Colors");
            if (colors == null) return false;
            for (int i = 0; i < colors.arraySize; i++)
            {
                var el = colors.GetArrayElementAtIndex(i);
                var key = el.FindPropertyRelative("first");
                var val = el.FindPropertyRelative("second");
                if (key != null && val != null && key.stringValue == name)
                {
                    color = val.colorValue;
                    return true;
                }
            }
            return false;
        }

        /// <summary>
        /// Reads a float via Material API or serialized m_Floats (Shader Graph safe).
        /// </summary>
        private static bool TryGetMaterialFloat(Material mat, string name, out float value)
        {
            value = 0f;
            if (mat == null || string.IsNullOrEmpty(name)) return false;
            if (mat.HasProperty(name))
            {
                value = mat.GetFloat(name);
                return true;
            }
            var so = new SerializedObject(mat);
            var floats = so.FindProperty("m_SavedProperties.m_Floats");
            if (floats == null) return false;
            for (int i = 0; i < floats.arraySize; i++)
            {
                var el = floats.GetArrayElementAtIndex(i);
                var key = el.FindPropertyRelative("first");
                var val = el.FindPropertyRelative("second");
                if (key != null && val != null && key.stringValue == name)
                {
                    value = val.floatValue;
                    return true;
                }
            }
            return false;
        }

        private string AddTexture(Texture tex, bool envAtlas = false)
        {
            string url = ResolveTextureUrl(tex);
            if (!_imageByUrl.TryGetValue(url, out var imageUuid))
            {
                imageUuid = NewId("quarks_image");
                _imageByUrl[url] = imageUuid;
                Images.Add(new JObject().Set("uuid", imageUuid).Set("url", url));
            }
            string texUuid = NewId("quarks_texture");
            var t = new JObject()
                .Set("uuid", texUuid)
                .Set("name", tex.name)
                .Set("image", imageUuid)
                // Preserve sampler address semantics. UV animation/dissolve intentionally drives
                // coordinates beyond 0..1; hard-coded Clamp turns late-life brush strokes into
                // solid blocks. Three constants: Repeat=1000, Clamp=1001, MirroredRepeat=1002.
                .Set("wrap", new JArray()
                    .Add(ThreeWrap(tex.wrapModeU, tex.name, "U"))
                    .Add(ThreeWrap(tex.wrapModeV, tex.name, "V")));
            // Shader Graph samples according to the TextureImporter color-space flag. This is
            // independent from whether the graph uses RGB as color or as scalar coverage.
            string assetPath = AssetDatabase.GetAssetPath(tex);
            bool srgb = true;
            string alphaSource = "input";
            bool mipmaps = true;
            if (!string.IsNullOrEmpty(assetPath)
                && AssetImporter.GetAtPath(assetPath) is TextureImporter importer)
            {
                srgb = importer.sRGBTexture;
                mipmaps = importer.mipmapEnabled;
                alphaSource = importer.alphaSource == TextureImporterAlphaSource.FromGrayScale
                    ? "grayscale"
                    : importer.alphaSource == TextureImporterAlphaSource.None ? "none" : "input";
            }
            t.Set("sRGB", srgb);
            t.Set("alphaSource", alphaSource);
            int magFilter = tex.filterMode == FilterMode.Point ? 1003 : 1006;
            int minFilter;
            if (!mipmaps) minFilter = magFilter;
            else if (tex.filterMode == FilterMode.Point) minFilter = 1004;
            else if (tex.filterMode == FilterMode.Bilinear) minFilter = 1007;
            else minFilter = 1008;
            t.Set("magFilter", magFilter).Set("minFilter", minFilter);
            if (envAtlas)
            {
                // Match babylon.quarks env-atlas sampling (invertY:false, no mips).
                t.Set("invertY", false);
                t.Set("noMipmap", true);
            }
            Textures.Add(t);
            return texUuid;
        }

        private static int ThreeWrap(TextureWrapMode mode, string textureName, string axis)
        {
            switch (mode)
            {
                case TextureWrapMode.Repeat: return 1000;
                case TextureWrapMode.Clamp: return 1001;
                case TextureWrapMode.Mirror: return 1002;
                // WebGL/three.js has no native MirrorOnce sampler mode. A strict compiler must
                // reject it rather than silently lower to Clamp or Repeat.
                case TextureWrapMode.MirrorOnce:
                    throw new InvalidOperationException(
                        $"Texture '{textureName}' uses unsupported MirrorOnce on {axis}; bake or add an explicit sampler adapter.");
                default:
                    throw new InvalidOperationException(
                        $"Texture '{textureName}' has unsupported wrap mode {mode} on {axis}.");
            }
        }

        private static TextureImporterAlphaSource TextureAlphaSourceOf(Texture tex)
        {
            if (tex == null) return TextureImporterAlphaSource.None;
            string path = AssetDatabase.GetAssetPath(tex);
            if (!string.IsNullOrEmpty(path)
                && AssetImporter.GetAtPath(path) is TextureImporter importer)
                return importer.alphaSource;
            return TextureImporterAlphaSource.FromInput;
        }

        private static bool SourceTextureHasAlpha(Texture tex)
        {
            if (tex == null) return false;
            string path = AssetDatabase.GetAssetPath(tex);
            if (!string.IsNullOrEmpty(path)
                && AssetImporter.GetAtPath(path) is TextureImporter importer)
                return importer.alphaSource == TextureImporterAlphaSource.FromGrayScale
                    || importer.DoesSourceTextureHaveAlpha();
            return false;
        }

        /// <summary>
        /// Finds a cubemap on the particle material (common shader property names).
        /// </summary>
        private static Cubemap FindReflectionCubemap(Material mat)
        {
            if (mat == null) return null;
            string[] names = {
                "_Cube", "_Cubemap", "_ReflectionCubemap", "_EnvMap",
                "_EnvironmentMap", "_SpecCube0", "_ReflectionTex"
            };
            foreach (string name in names)
            {
                if (!mat.HasProperty(name)) continue;
                Texture t = mat.GetTexture(name);
                if (t is Cubemap cube) return cube;
            }
            // Any cubemap-typed texture property (custom shaders).
            foreach (string name in mat.GetTexturePropertyNames())
            {
                Texture t = mat.GetTexture(name);
                if (t is Cubemap cube) return cube;
            }
            return null;
        }

        private static float ReadReflectionLevel(Material mat)
        {
            if (mat == null) return 1f;
            string[] names = { "_ReflectionIntensity", "_ReflectionStrength", "_EnvIntensity" };
            foreach (string name in names)
            {
                if (!mat.HasProperty(name)) continue;
                return mat.GetFloat(name);
            }
            return 1f;
        }

        /// <summary>
        /// Bakes a Cubemap into a 3×2 atlas (px py pz / nx ny nz) and embeds it.
        /// </summary>
        private string AddCubemapAtlas(Cubemap cube)
        {
            Texture2D atlas = BakeCubemapToAtlas(cube);
            if (atlas == null) return null;
            try
            {
                atlas.name = cube.name + "_envAtlas";
                return AddTexture(atlas, envAtlas: true);
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(atlas);
            }
        }

        /// <summary>
        /// Packs cubemap faces into one Texture2D matching babylon.quarks USE_ENVMAP_ATLAS layout.
        /// </summary>
        private static Texture2D BakeCubemapToAtlas(Cubemap cube)
        {
            if (cube == null || cube.width <= 0) return null;

            // Cap face size so embedded JSON stays reasonable.
            int srcSize = cube.width;
            int size = Math.Min(srcSize, 256);
            var atlas = new Texture2D(size * 3, size * 2, TextureFormat.RGBA32, false, false);
            CubemapFace[] faces = {
                CubemapFace.PositiveX, CubemapFace.PositiveY, CubemapFace.PositiveZ,
                CubemapFace.NegativeX, CubemapFace.NegativeY, CubemapFace.NegativeZ
            };

            for (int i = 0; i < 6; i++)
            {
                Texture2D faceTex = ReadCubemapFace(cube, faces[i], size);
                if (faceTex == null)
                {
                    Debug.LogWarning($"[Quarks Exporter] Could not read cubemap face {faces[i]} from '{cube.name}'");
                    UnityEngine.Object.DestroyImmediate(atlas);
                    return null;
                }
                try
                {
                    // Texture2D y=0 is bottom; canvas-style atlas has +faces on the top row.
                    // Place +faces (i=0..2) at top → high y, -faces at bottom → y=0.
                    int x = (i % 3) * size;
                    int y = (i < 3) ? size : 0;
                    atlas.SetPixels(x, y, size, size, faceTex.GetPixels());
                }
                finally
                {
                    UnityEngine.Object.DestroyImmediate(faceTex);
                }
            }
            atlas.Apply(false, false);
            return atlas;
        }

        /// <summary>
        /// Reads one cubemap face into a readable Texture2D, via GetPixels or GPU blit.
        /// </summary>
        private static Texture2D ReadCubemapFace(Cubemap cube, CubemapFace face, int size)
        {
            int faceSize = cube.width;

            // Prefer CPU read when the cubemap is readable.
            try
            {
                Color[] pixels = cube.GetPixels(face);
                if (pixels != null && pixels.Length > 0)
                {
                    var full = new Texture2D(faceSize, faceSize, TextureFormat.RGBA32, false, false);
                    full.SetPixels(pixels);
                    full.Apply(false, false);
                    if (faceSize == size) return full;
                    Texture2D scaled = ScaleTexture(full, size);
                    UnityEngine.Object.DestroyImmediate(full);
                    return scaled;
                }
            }
            catch
            {
                // Non-readable cubemap — fall through to GPU blit.
            }

            RenderTexture previous = RenderTexture.active;
            RenderTexture rt = RenderTexture.GetTemporary(
                faceSize, faceSize, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
            Texture2D readable = null;
            try
            {
                int faceIndex = (int)face;
                if (SystemInfo.copyTextureSupport == CopyTextureSupport.None)
                {
                    Debug.LogWarning($"[Quarks Exporter] CopyTexture unsupported; cannot bake cubemap '{cube.name}'");
                    return null;
                }
                var faceTex = new Texture2D(faceSize, faceSize, TextureFormat.RGBA32, false, false);
                try
                {
                    Graphics.CopyTexture(cube, faceIndex, 0, faceTex, 0, 0);
                }
                catch (Exception e)
                {
                    UnityEngine.Object.DestroyImmediate(faceTex);
                    Debug.LogWarning($"[Quarks Exporter] Could not CopyTexture cubemap face {face}: {e.Message}");
                    return null;
                }
                if (faceSize == size)
                {
                    return faceTex;
                }
                Texture2D scaled = ScaleTexture(faceTex, size);
                UnityEngine.Object.DestroyImmediate(faceTex);
                return scaled;
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[Quarks Exporter] Could not blit cubemap face {face}: {e.Message}");
                if (readable != null) UnityEngine.Object.DestroyImmediate(readable);
                return null;
            }
            finally
            {
                RenderTexture.active = previous;
                RenderTexture.ReleaseTemporary(rt);
            }
        }

        private static Texture2D ScaleTexture(Texture2D source, int size)
        {
            RenderTexture previous = RenderTexture.active;
            RenderTexture rt = RenderTexture.GetTemporary(size, size, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
            try
            {
                Graphics.Blit(source, rt);
                RenderTexture.active = rt;
                var scaled = new Texture2D(size, size, TextureFormat.RGBA32, false, false);
                scaled.ReadPixels(new Rect(0, 0, size, size), 0, 0);
                scaled.Apply(false, false);
                return scaled;
            }
            finally
            {
                RenderTexture.active = previous;
                RenderTexture.ReleaseTemporary(rt);
            }
        }

        private string ResolveTextureUrl(Texture tex)
        {
            string path = AssetDatabase.GetAssetPath(tex);
            if (EmbedTextures)
            {
                // A material samples Unity's imported/platform texture, not the source PNG/PSD.
                // Export level 0 through the GPU so importer resizing, compression, alpha and
                // color conversion are part of the compiled IR. Embedding source bytes caused
                // high-threshold dissolve/alpha-clip to retain texels Unity had already removed.
                string encoded = EncodeTextureToPngDataUrl(tex);
                if (!string.IsNullOrEmpty(encoded))
                {
                    return encoded;
                }
                throw new InvalidOperationException(
                    $"Texture '{tex.name}' could not be compiled from Unity's imported GPU representation.");
            }
            return !string.IsNullOrEmpty(path) ? path : tex.name;
        }

        private static bool IsWebImageFile(string path)
        {
            string ext = Path.GetExtension(path).ToLowerInvariant();
            return ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".webp";
        }

        private static string MimeTypeOf(string path)
        {
            string ext = Path.GetExtension(path).ToLowerInvariant();
            return ext == ".jpg" || ext == ".jpeg" ? "image/jpeg"
                : ext == ".webp" ? "image/webp"
                : "image/png";
        }

        /// <summary>
        /// Re-encodes any texture to a PNG data URI by way of a render texture.
        /// Works for built-in, compressed and non-readable textures, none of which
        /// can be read from disk or through <c>EncodeToPNG</c> directly.
        /// </summary>
        private static string EncodeTextureToPngDataUrl(Texture tex)
        {
            if (tex == null || tex.width <= 0 || tex.height <= 0)
            {
                return null;
            }

            // Preserve the imported texture's numeric sample domain in the PNG payload.
            // For an sRGB importer Unity decodes on sample, so an sRGB render target encodes
            // those linear samples back to the original sRGB bytes. For a linear importer the
            // texture bytes already are linear values; routing them through an sRGB target
            // gamma-encodes them (e.g. 32 -> 59) and makes WebGL effects far too bright when the
            // emitted texture is correctly tagged NoColorSpace.
            bool srgb = true;
            string assetPath = AssetDatabase.GetAssetPath(tex);
            if (!string.IsNullOrEmpty(assetPath)
                && AssetImporter.GetAtPath(assetPath) is TextureImporter importer)
                srgb = importer.sRGBTexture;

            RenderTexture previous = RenderTexture.active;
            RenderTexture rt = RenderTexture.GetTemporary(
                tex.width, tex.height, 0, RenderTextureFormat.ARGB32,
                srgb ? RenderTextureReadWrite.sRGB : RenderTextureReadWrite.Linear);
            Texture2D readable = null;
            try
            {
                Graphics.Blit(tex, rt);
                RenderTexture.active = rt;
                readable = new Texture2D(tex.width, tex.height, TextureFormat.RGBA32, false, !srgb);
                readable.ReadPixels(new Rect(0, 0, tex.width, tex.height), 0, 0);
                readable.Apply();
                byte[] png = readable.EncodeToPNG();
                return png == null ? null : "data:image/png;base64," + Convert.ToBase64String(png);
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[Quarks Exporter] Could not re-encode texture '{tex.name}': {e.Message}");
                return null;
            }
            finally
            {
                RenderTexture.active = previous;
                RenderTexture.ReleaseTemporary(rt);
                if (readable != null)
                {
                    UnityEngine.Object.DestroyImmediate(readable);
                }
            }
        }

        // ---- mesh geometry (Mesh render mode) ------------------------------------------

        /// <summary>
        /// Unit XY quad used to lower Unity Billboard + Local alignment to an instanced mesh.
        /// Unlike a camera billboard, the mesh retains the emitter's complete local basis.
        /// </summary>
        public string AddLocalBillboardQuadGeometry()
        {
            if (!string.IsNullOrEmpty(_localBillboardQuadGeometryUuid))
                return _localBillboardQuadGeometryUuid;
            string uuid = NewId("quarks_geometry");
            Geometries.Add(new JObject()
                .Set("uuid", uuid)
                .Set("type", "QuarksGeometry")
                .Set("positions", new JArray()
                    .Add(-0.5f).Add(-0.5f).Add(0f)
                    .Add( 0.5f).Add(-0.5f).Add(0f)
                    .Add( 0.5f).Add( 0.5f).Add(0f)
                    .Add(-0.5f).Add( 0.5f).Add(0f))
                .Set("indices", new JArray().Add(0).Add(2).Add(1).Add(0).Add(3).Add(2))
                .Set("uvs", new JArray()
                    .Add(0f).Add(0f).Add(1f).Add(0f).Add(1f).Add(1f).Add(0f).Add(1f))
                .Set("normals", new JArray()
                    .Add(0f).Add(0f).Add(1f).Add(0f).Add(0f).Add(1f)
                    .Add(0f).Add(0f).Add(1f).Add(0f).Add(0f).Add(1f)));
            _localBillboardQuadGeometryUuid = uuid;
            return uuid;
        }

        public string AddGeometryForMesh(Mesh mesh)
        {
            string uuid = NewId("quarks_geometry");
            var positions = new JArray();
            // Unity is left-handed while three.js is right-handed. Reflect geometry through
            // Z and reverse every triangle so front faces and tangent orientation survive.
            foreach (var v in mesh.vertices) { positions.Add(v.x); positions.Add(v.y); positions.Add(-v.z); }
            var indices = new JArray();
            int[] triangles = mesh.triangles;
            for (int i = 0; i + 2 < triangles.Length; i += 3)
            {
                indices.Add(triangles[i]);
                indices.Add(triangles[i + 2]);
                indices.Add(triangles[i + 1]);
            }
            var g = new JObject().Set("uuid", uuid).Set("type", "QuarksGeometry").Set("positions", positions).Set("indices", indices);

            Vector2[] uv = mesh.uv;
            if (uv.Length > 0)
            {
                var uvs = new JArray();
                foreach (var t in uv) { uvs.Add(t.x); uvs.Add(t.y); }
                g.Set("uvs", uvs);
            }
            Vector2[] uv1 = mesh.uv2;
            if (uv1.Length > 0)
            {
                var uv1s = new JArray();
                foreach (var t in uv1) { uv1s.Add(t.x); uv1s.Add(t.y); }
                g.Set("uv1s", uv1s);
            }

            Vector3[] normals = mesh.normals;
            if (normals == null || normals.Length == 0)
            {
                mesh.RecalculateNormals();
                normals = mesh.normals;
            }
            if (normals != null && normals.Length > 0)
            {
                var n = new JArray();
                foreach (var v in normals) { n.Add(v.x); n.Add(v.y); n.Add(-v.z); }
                g.Set("normals", n);
            }
            Geometries.Add(g);
            return uuid;
        }

        /// <summary>
        /// Emits a Mesh node (+ its geometry) so a mesh-shape emitter can reference it by uuid.
        /// QuarksLoader.linkReferences resolves the emitter's `mesh_surface.mesh` to this node.
        /// The node is a real (visible) Mesh in the loaded scene — hide it if only used for emission.
        /// </summary>
        public string AddMeshSourceNode(Mesh mesh)
        {
            string geometryUuid = AddGeometryForMesh(mesh);
            string nodeUuid = NewId("node");
            MeshSourceNodes.Add(new JObject()
                .Set("uuid", nodeUuid)
                .Set("name", mesh.name + " (emitter source)")
                .Set("layers", 1)
                // Reference-only node for mesh_surface emitters — must never render.
                .Set("visible", false)
                .Set("matrix", new JArray().Add(1).Add(0).Add(0).Add(0).Add(0).Add(1).Add(0).Add(0).Add(0).Add(0).Add(1).Add(0).Add(0).Add(0).Add(0).Add(1))
                .Set("type", "Mesh")
                .Set("geometry", geometryUuid));
            return nodeUuid;
        }

        private static int DetectBlend(Material mat)
        {
            // quarks/Babylon blend ints: 1 = additive, 2 = alpha blend, 3 = subtract, 4 = multiply.
            if (mat == null) return 2;
            string sn = mat.shader != null ? mat.shader.name.ToLowerInvariant() : "";

            // Name checks — order matters: "Alpha Blended Premultiply" contains "multiply"
            // as a substring and must NOT be treated as multiply.
            if (sn.Contains("additive")) return 1;
            if (sn.Contains("premultiply") || sn.Contains("alpha blend") || sn.Contains("alphablend"))
                return 2;
            if (sn.Contains("multiply") || sn.Contains("modulate")) return 4;

            // Fall back to GPU blend factors when the shader name is uninformative
            // (Shader Graph / Particles/Standard Unlit — use SavedProperties when needed).
            if (TryGetMaterialFloat(mat, "_DstBlend", out float dstF))
            {
                int dst = (int)dstF;
                int src = TryGetMaterialFloat(mat, "_SrcBlend", out float srcF) ? (int)srcF : -1;
                // UnityEngine.Rendering.BlendMode: One=1, DstColor=2, Zero=0, OneMinusSrcAlpha=10
                if (dst == 1) return 1; // DstBlend == One → additive
                if (src == 2) return 4; // Src = DstColor → multiply/modulate
            }
            return 2;
        }
    }
}
