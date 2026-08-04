using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace BabylonQuarks.UnityExporter
{
    /// <summary>
    /// Exact fallback for effects outside the live particle/material IR. It captures the
    /// authored Unity result at the exported reference camera and produces an explicit
    /// camera-baked@1 program. This is deliberately view-dependent, but never pretends an
    /// approximate Quarks translation is equivalent to the Unity source.
    /// </summary>
    public static class BakedEffectExporter
    {
        public const string Representation = "camera-baked@1";
        private const int Width = 1920;
        private const int Height = 1080;
        // The oracle uses the exact same 60 Hz clock as the live runtime. A visual
        // comparison between different simulation steps is not a valid regression.
        private const int Fps = 60;
        private const float MaxDuration = 2.0f;
        private const int BakeLayer = 30;

        public static void ExportToFile(GameObject root, string jsonPath,
            IReadOnlyList<ExportDiagnostic> sourceDiagnostics = null)
        {
            string stem = Path.GetFileNameWithoutExtension(jsonPath);
            string safeStem = Sanitize(stem);
            string frameDir = Path.Combine(Path.GetDirectoryName(jsonPath), "baked", safeStem);
            if (Directory.Exists(frameDir)) Directory.Delete(frameDir, true);
            Directory.CreateDirectory(frameDir);

            SetLayerRecursively(root, BakeLayer);
            ParticleSystem[] systems = root.GetComponentsInChildren<ParticleSystem>(true);
            uint seed = ConfigureSeeds(systems);
            float duration = DetermineDuration(systems);
            int frameCount = Mathf.Max(2, Mathf.CeilToInt(duration * Fps) + 1);

            GameObject cameraObject = new GameObject("Quarks Bake Camera");
            GameObject groundObject = null;
            Material groundMaterial = null;
            Camera camera = cameraObject.AddComponent<Camera>();
            RenderTexture target = null;
            Texture2D pixels = null;
            try
            {
                camera.transform.position = new Vector3(2.15f, 1.55f, 4.55f);
                camera.transform.LookAt(new Vector3(0, 0.95f, 0));
                camera.fieldOfView = 60f;
                camera.nearClipPlane = 0.1f;
                camera.farClipPlane = 100f;
                camera.clearFlags = CameraClearFlags.SolidColor;
                // A camera-baked program is a fixed-view final buffer. Render the same neutral
                // reference stage as Web so Scene Color / Scene Depth graphs receive meaningful
                // inputs instead of transparent black.
                camera.backgroundColor = new Color32(220, 230, 238, 255);
                camera.allowHDR = true;
                camera.allowMSAA = true;
                camera.cullingMask = 1 << BakeLayer;
                camera.depthTextureMode = DepthTextureMode.Depth;

                groundObject = GameObject.CreatePrimitive(PrimitiveType.Plane);
                groundObject.name = "Quarks Reference Ground";
                groundObject.layer = BakeLayer;
                groundObject.transform.position = Vector3.zero;
                groundObject.transform.localScale = new Vector3(3.6f, 1, 3.6f);
                Shader groundShader = Shader.Find("Universal Render Pipeline/Unlit")
                    ?? Shader.Find("Unlit/Color");
                if (groundShader == null) throw new InvalidOperationException("No unlit shader for bake reference ground.");
                groundMaterial = new Material(groundShader) { color = new Color32(122, 126, 130, 255) };
                if (groundMaterial.HasProperty("_BaseColor"))
                    groundMaterial.SetColor("_BaseColor", new Color32(122, 126, 130, 255));
                groundObject.GetComponent<MeshRenderer>().sharedMaterial = groundMaterial;

                target = new RenderTexture(Width, Height, 24, RenderTextureFormat.ARGB32,
                    RenderTextureReadWrite.sRGB)
                {
                    antiAliasing = 4,
                    name = "Quarks Camera Bake"
                };
                target.Create();
                camera.targetTexture = target;
                pixels = new Texture2D(Width, Height, TextureFormat.RGBA32, false, false);

                root.SetActive(false);
                camera.Render();
                ReadTarget(target, pixels, Path.Combine(frameDir, "background.png"));
                root.SetActive(true);

                for (int frame = 0; frame < frameCount; frame++)
                {
                    float time = frame / (float)Fps;
                    ResetAndSimulate(root.transform, systems, frame);
                    SetShaderTime(time);
                    camera.Render();
                    ReadTarget(target, pixels, Path.Combine(frameDir, $"frame-{frame:D4}.png"));
                }
            }
            finally
            {
                if (pixels != null) UnityEngine.Object.DestroyImmediate(pixels);
                if (target != null)
                {
                    target.Release();
                    UnityEngine.Object.DestroyImmediate(target);
                }
                UnityEngine.Object.DestroyImmediate(cameraObject);
                if (groundObject != null) UnityEngine.Object.DestroyImmediate(groundObject);
                if (groundMaterial != null) UnityEngine.Object.DestroyImmediate(groundMaterial);
            }

            var frames = new JArray();
            for (int i = 0; i < frameCount; i++)
                frames.Add($"baked/{safeStem}/frame-{i:D4}.png");

            // Per-emitter final-color buffers make attribution automatic without changing the
            // live program. They are oracle diagnostics only.
            var layers = new JArray();
            int[] layerFrames = { 5, 9, 15, 24, 30, 60, 120 };
            // Layer rendering is intentionally a second deterministic pass.
            groundObject = GameObject.CreatePrimitive(PrimitiveType.Plane);
            groundObject.layer = BakeLayer;
            groundObject.transform.localScale = new Vector3(3.6f, 1, 3.6f);
            Shader layerGroundShader = Shader.Find("Universal Render Pipeline/Unlit") ?? Shader.Find("Unlit/Color");
            groundMaterial = new Material(layerGroundShader) { color = new Color32(122, 126, 130, 255) };
            if (groundMaterial.HasProperty("_BaseColor"))
                groundMaterial.SetColor("_BaseColor", new Color32(122, 126, 130, 255));
            groundObject.GetComponent<MeshRenderer>().sharedMaterial = groundMaterial;
            cameraObject = new GameObject("Quarks Layer Camera");
            Camera layerCamera = cameraObject.AddComponent<Camera>();
            layerCamera.transform.position = new Vector3(2.15f, 1.55f, 4.55f);
            layerCamera.transform.LookAt(new Vector3(0, 0.95f, 0));
            layerCamera.fieldOfView = 60f;
            layerCamera.nearClipPlane = 0.1f;
            layerCamera.farClipPlane = 100f;
            layerCamera.clearFlags = CameraClearFlags.SolidColor;
            layerCamera.backgroundColor = new Color32(220, 230, 238, 255);
            layerCamera.cullingMask = 1 << BakeLayer;
            layerCamera.depthTextureMode = DepthTextureMode.Depth;
            target = new RenderTexture(Width, Height, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB)
            {
                antiAliasing = 4,
                name = "Quarks Layer Bake"
            };
            target.Create();
            layerCamera.targetTexture = target;
            pixels = new Texture2D(Width, Height, TextureFormat.RGBA32, false, false);
            try
            {
                var particleRenderers = new ParticleSystemRenderer[systems.Length];
                for (int i = 0; i < systems.Length; i++)
                    particleRenderers[i] = systems[i].GetComponent<ParticleSystemRenderer>();
                for (int systemIndex = 0; systemIndex < systems.Length; systemIndex++)
                {
                    var layerFiles = new JArray();
                    foreach (int frame in layerFrames)
                    {
                        // A diagnostic layer is a render-buffer isolation, not a different
                        // simulation. Always advance the complete hierarchy so sub-emitter
                        // events, parent transforms and RNG consumption remain identical to the
                        // final buffer, then expose only the selected renderer.
                        // Restore all renderers before simulation: the previous iteration left
                        // only its selected renderer enabled. Renderer-enabled state can affect
                        // Unity particle preparation/custom vertex streams and must never leak
                        // from one diagnostic layer into the next.
                        for (int i = 0; i < particleRenderers.Length; i++)
                            if (particleRenderers[i] != null)
                                particleRenderers[i].enabled = true;
                        ResetAndSimulate(root.transform, systems, frame);
                        for (int i = 0; i < particleRenderers.Length; i++)
                            if (particleRenderers[i] != null)
                                particleRenderers[i].enabled = i == systemIndex;
                        SetShaderTime(frame / (float)Fps);
                        layerCamera.Render();
                        string file = $"layer-{systemIndex:D2}-frame-{frame:D4}.png";
                        ReadTarget(target, pixels, Path.Combine(frameDir, file));
                        layerFiles.Add($"baked/{safeStem}/{file}");
                    }
                    layers.Add(new JObject().Set("id", systemIndex)
                        .Set("name", systems[systemIndex].name)
                        .Set("frames", layerFiles));
                }
            }
            finally
            {
                foreach (ParticleSystem ps in systems)
                {
                    ParticleSystemRenderer renderer = ps.GetComponent<ParticleSystemRenderer>();
                    if (renderer != null) renderer.enabled = true;
                }
                UnityEngine.Object.DestroyImmediate(pixels);
                target.Release();
                UnityEngine.Object.DestroyImmediate(target);
                UnityEngine.Object.DestroyImmediate(cameraObject);
                UnityEngine.Object.DestroyImmediate(groundObject);
                UnityEngine.Object.DestroyImmediate(groundMaterial);
                pixels = null; target = null; cameraObject = null;
            }

            var sourceErrors = new JArray();
            if (sourceDiagnostics != null)
                foreach (ExportDiagnostic d in sourceDiagnostics) sourceErrors.Add(d.ToJson());

            var contract = new JObject()
                .Set("schema", SemanticValidator.Schema)
                .Set("runtime", SemanticValidator.Runtime)
                .Set("policy", "strict")
                .Set("representation", Representation)
                .Set("effectId", "baked-" + safeStem)
                .Set("seed", (double)seed)
                .Set("fixedDelta", 1.0 / Fps)
                .Set("referenceCamera", ReferenceCamera())
                .Set("captureTimes", CaptureTimes(duration))
                .Set("diagnostics", new JArray());

            var baked = new JObject()
                .Set("schema", Representation)
                .Set("width", Width)
                .Set("height", Height)
                .Set("fps", Fps)
                .Set("duration", duration)
                .Set("frameCount", frameCount)
                .Set("loop", false)
                .Set("premultipliedAlpha", false)
                .Set("composite", "opaque-reference-scene")
                .Set("buffers", new JObject()
                    .Set("background", $"baked/{safeStem}/background.png")
                    .Set("layers", layers)
                    .Set("comparison", "effect-minus-background"))
                .Set("frames", frames)
                .Set("sourceDiagnostics", sourceErrors)
                .Set("limitation", "Exact only for the exported reference camera, reference stage, and resolution/aspect ratio.");

            var envelope = new JObject()
                .Set("metadata", new JObject()
                    .Set("version", 1)
                    .Set("type", "CameraBakedVFX")
                    .Set("generator", QuarksExporter.ExporterId))
                .Set("vfxIR", contract)
                .Set("baked", baked);
            File.WriteAllText(jsonPath, envelope.ToString());
            Debug.Log($"[Quarks Baker] Baked '{root.name}' to {frameCount} frame(s) → {jsonPath}");
        }

        private static void ReadTarget(RenderTexture target, Texture2D pixels, string path)
        {
            RenderTexture previous = RenderTexture.active;
            RenderTexture.active = target;
            pixels.ReadPixels(new Rect(0, 0, Width, Height), 0, 0, false);
            pixels.Apply(false, false);
            RenderTexture.active = previous;
            File.WriteAllBytes(path, pixels.EncodeToPNG());
        }

        public static void BatchBakeImpactToWeb()
        {
            BatchBakePrefabToWeb(
                "Assets/Free Slash VFX/Prefabs/Impact.prefab",
                "Impact.json");
        }

        public static void BatchBakeMultipleImpactToWeb()
        {
            BatchBakePrefabToWeb(
                "Assets/Free Slash VFX/Prefabs/Multiple Impact.prefab",
                "Multiple Impact.json");
        }

        private static void BatchBakePrefabToWeb(string assetPath, string outputName)
        {
            AssetDatabase.ImportAsset(assetPath,
                ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);
            GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
            if (prefab == null) throw new InvalidOperationException($"Cannot load {assetPath}");
            GameObject instance = PrefabUtility.InstantiatePrefab(prefab) as GameObject;
            if (instance == null) throw new InvalidOperationException($"Cannot instantiate {assetPath}");
            string projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, "..", ".."));
            if (!Directory.Exists(Path.Combine(projectRoot, "public")))
                projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
            string outDir = Path.Combine(projectRoot, "public", "assets", "quarks", "oracles");
            Directory.CreateDirectory(outDir);
            try
            {
                var ctx = new ExportContext();
                SemanticValidator.ValidateHierarchy(instance, ctx);
                ExportToFile(instance, Path.Combine(outDir, outputName), ctx.Diagnostics);
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(instance);
            }
            if (Application.isBatchMode) EditorApplication.Exit(0);
        }

        private static void ResetAndSimulate(Transform root, ParticleSystem[] systems, int frames)
        {
            foreach (ParticleSystem ps in systems)
                ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
            foreach (ParticleSystem ps in systems)
            {
                if (HasParticleAncestor(ps.transform, root)) continue;
                ps.Simulate(0f, true, true, false);
            }
            ControllerSemanticCompiler.PrepareReferenceSimulation(root.gameObject);
            for (int frame = 0; frame < frames; frame++)
            {
                foreach (ParticleSystem ps in systems)
                {
                    if (HasParticleAncestor(ps.transform, root)) continue;
                    ps.Simulate(1f / Fps, true, false, false);
                }
                ControllerSemanticCompiler.AdvanceReferenceSimulation(root.gameObject, 1f / Fps);
            }
        }

        private static void SimulateFixedFrames(ParticleSystem ps, int frames, bool withChildren)
        {
            // `fixedTimeStep:true` uses the Unity project's Time.fixedDeltaTime (commonly
            // 0.02), which silently turns a nominal 60 Hz oracle into a 50 Hz simulation.
            // Advance explicitly at the IR contract's 1/Fps step instead.
            for (int frame = 0; frame < frames; frame++)
                ps.Simulate(1f / Fps, withChildren, false, false);
        }

        private static void SetShaderTime(float time)
        {
            // Shader Graph Time/ScrollUV must share the regression clock with particle
            // simulation. Editor wall time would make oracle frames non-reproducible.
            Shader.SetGlobalVector("_Time", new Vector4(time / 20f, time, time * 2f, time * 3f));
            Shader.SetGlobalVector("_SinTime", new Vector4(
                Mathf.Sin(time / 8f), Mathf.Sin(time / 4f), Mathf.Sin(time / 2f), Mathf.Sin(time)));
            Shader.SetGlobalVector("_CosTime", new Vector4(
                Mathf.Cos(time / 8f), Mathf.Cos(time / 4f), Mathf.Cos(time / 2f), Mathf.Cos(time)));
            float dt = 1f / Fps;
            Shader.SetGlobalVector("unity_DeltaTime", new Vector4(dt, 1f / dt, dt, 1f / dt));
        }

        private static bool HasParticleAncestor(Transform t, Transform root)
        {
            for (Transform p = t.parent; p != null && p != root.parent; p = p.parent)
                if (p.GetComponent<ParticleSystem>() != null) return true;
            return false;
        }

        private static uint ConfigureSeeds(ParticleSystem[] systems)
        {
            uint effectSeed = 1;
            foreach (ParticleSystem ps in systems)
            {
                uint seed = ps.randomSeed != 0 ? ps.randomSeed : StableSeed(SemanticValidator.HierarchyPath(ps.transform));
                ps.useAutoRandomSeed = false;
                ps.randomSeed = seed;
                if (effectSeed == 1) effectSeed = seed;
            }
            return effectSeed;
        }

        private static float DetermineDuration(ParticleSystem[] systems)
        {
            float duration = 0.5f;
            foreach (ParticleSystem ps in systems)
            {
                var main = ps.main;
                float end = main.startDelay.constantMax + main.duration + main.startLifetime.constantMax;
                duration = Mathf.Max(duration, end);
            }
            return Mathf.Min(MaxDuration, Mathf.Ceil(duration * Fps) / Fps);
        }

        private static JObject ReferenceCamera() => new JObject()
            .Set("projection", "perspective")
            .Set("fov", 60)
            .Set("near", 0.1)
            .Set("far", 100)
            .Set("position", new JArray().Add(2.15).Add(1.55).Add(4.55))
            .Set("target", new JArray().Add(0).Add(0.95).Add(0));

        private static JArray CaptureTimes(float duration)
        {
            var result = new JArray();
            int[] preferred = { 5, 9, 15, 24, 30, 60, 120 };
            foreach (int frame in preferred)
                if (frame / (float)Fps <= duration) result.Add(frame / (double)Fps);
            return result;
        }

        private static void SetLayerRecursively(GameObject value, int layer)
        {
            value.layer = layer;
            foreach (Transform child in value.transform) SetLayerRecursively(child.gameObject, layer);
        }

        private static uint StableSeed(string value)
        {
            unchecked
            {
                uint hash = 2166136261;
                foreach (char c in value) { hash ^= c; hash *= 16777619; }
                return hash == 0 ? 1u : hash;
            }
        }

        private static string Sanitize(string value)
        {
            var result = new System.Text.StringBuilder();
            foreach (char c in value.ToLowerInvariant())
                result.Append(char.IsLetterOrDigit(c) ? c : '_');
            return result.ToString().Trim('_');
        }
    }
}
