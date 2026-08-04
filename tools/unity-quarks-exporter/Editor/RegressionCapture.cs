using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace BabylonQuarks.UnityExporter
{
    /// <summary>
    /// Deterministic Unity-side particle-state reference capture. This deliberately records
    /// simulation state before rendering, allowing the regression suite to separate particle
    /// translation errors from shader/post-processing errors.
    /// </summary>
    public static class RegressionCapture
    {
        // Include late-life frames: long-lived mesh decals/cracks can look correct during the
        // burst and fail only after the short emitters have disappeared.
        private static readonly float[] Times = {
            5f / 60f, 9f / 60f, 15f / 60f, 24f / 60f, 30f / 60f, 60f / 60f, 120f / 60f
        };

        [MenuItem("Tools/Quarks/Capture Free Slash Regression States", false, 5)]
        public static void BatchCaptureFreeSlashRegressionStates()
        {
            CaptureFolder("Assets/Free Slash VFX/Prefabs");
        }

        /// <summary>Bounded state/renderer trace for the current CFX2 pickup qualification batch.</summary>
        public static void BatchCaptureCfx2PickupRegressionStates()
        {
            CaptureFolder("Assets/JMO Assets/Cartoon FX (legacy)/CFX2 Prefabs/Pickup Items");
        }

        public static void BatchCaptureCfx2RegressionBatch5States()
        {
            const string root = "Assets/JMO Assets/Cartoon FX (legacy)/CFX2 Prefabs/";
            CaptureAssets(new[] {
                root + "Blood/CFX2_Blood.prefab",
                root + "Misc/CFX2_BrokenHeart.prefab",
                root + "Skull & Ghosts Effects/CFX2_EnemyDeathSkull.prefab",
                root + "Debris Hits/CFX2_RockHit.prefab",
                root + "Electric/CFX2_SparksHit_B Sphere.prefab",
            });
        }

        public static void CaptureFolder(string assetFolder)
        {
            if (!AssetDatabase.IsValidFolder(assetFolder))
            {
                Debug.LogError($"[Quarks Regression] Missing folder: {assetFolder}");
                if (Application.isBatchMode) EditorApplication.Exit(1);
                return;
            }

            string projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, "..", ".."));
            if (!Directory.Exists(Path.Combine(projectRoot, "public")))
                projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
            string outDir = Path.Combine(projectRoot, "public", "assets", "quarks", "reference-states");
            Directory.CreateDirectory(outDir);

            string[] guids = AssetDatabase.FindAssets("t:Prefab", new[] { assetFolder });
            var paths = new List<string>();
            foreach (string guid in guids) paths.Add(AssetDatabase.GUIDToAssetPath(guid));
            CaptureAssets(paths);
        }

        private static void CaptureAssets(IEnumerable<string> assetPaths)
        {
            string projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, "..", ".."));
            if (!Directory.Exists(Path.Combine(projectRoot, "public")))
                projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
            string outDir = Path.Combine(projectRoot, "public", "assets", "quarks", "reference-states");
            Directory.CreateDirectory(outDir);
            int captured = 0;
            foreach (string assetPath in assetPaths)
            {
                GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
                if (prefab == null || prefab.GetComponentsInChildren<ParticleSystem>(true).Length == 0) continue;
                GameObject instance = PrefabUtility.InstantiatePrefab(prefab) as GameObject;
                if (instance == null) continue;
                try
                {
                    JObject report = Capture(instance);
                    string file = Path.Combine(outDir, Sanitize(Path.GetFileNameWithoutExtension(assetPath)) + ".json");
                    File.WriteAllText(file, report.ToString());
                    captured++;
                }
                finally
                {
                    Object.DestroyImmediate(instance);
                }
            }

            Debug.Log($"[Quarks Regression] Captured {captured} deterministic Unity state reference(s) → {outDir}");
            if (Application.isBatchMode) EditorApplication.Exit(captured > 0 ? 0 : 1);
        }

        private static JObject Capture(GameObject root)
        {
            ParticleSystem[] systems = root.GetComponentsInChildren<ParticleSystem>(true);
            GameObject cameraObject = new GameObject("Quarks Regression Geometry Camera");
            Camera referenceCamera = cameraObject.AddComponent<Camera>();
            referenceCamera.transform.position = new Vector3(2.15f, 1.55f, 4.55f);
            referenceCamera.transform.LookAt(new Vector3(0, 0.95f, 0));
            referenceCamera.fieldOfView = 60f;
            referenceCamera.aspect = 1920f / 1080f;
            referenceCamera.nearClipPlane = 0.1f;
            referenceCamera.farClipPlane = 100f;
            uint effectSeed = 1;
            foreach (ParticleSystem ps in systems)
            {
                uint seed = ps.randomSeed != 0 ? ps.randomSeed : StableSeed(SemanticValidator.HierarchyPath(ps.transform));
                ps.useAutoRandomSeed = false;
                ps.randomSeed = seed;
                if (effectSeed == 1 && seed != 0) effectSeed = seed;
            }

            var frames = new JArray();
            try
            {
                foreach (float time in Times)
                {
                    foreach (ParticleSystem ps in systems)
                        ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
                    foreach (ParticleSystem ps in systems)
                    {
                        // Simulate only hierarchy roots; withChildren handles descendants once.
                        if (HasParticleAncestor(ps.transform, root.transform)) continue;
                        int framesAtTime = Mathf.RoundToInt(time * 60f);
                        for (int frame = 0; frame < framesAtTime; frame++)
                            ps.Simulate(1f / 60f, true, frame == 0, false);
                    }

                    var emitters = new JArray();
                    foreach (ParticleSystem ps in systems)
                        emitters.Add(CaptureEmitter(ps, root.transform, referenceCamera));
                    frames.Add(new JObject().Set("time", time).Set("emitters", emitters));
                }
            }
            finally
            {
                Object.DestroyImmediate(cameraObject);
            }

            return new JObject()
                .Set("schema", "unity-particle-state@1")
                .Set("effect", root.name)
                .Set("seed", (double)effectSeed)
                .Set("fixedDelta", 1.0 / 60.0)
                .Set("referenceCamera", new JObject()
                    .Set("fov", 60)
                    .Set("position", new JArray().Add(2.15).Add(1.55).Add(4.55))
                    .Set("target", new JArray().Add(0).Add(0.95).Add(0)))
                .Set("frames", frames);
        }

        private static JObject CaptureEmitter(ParticleSystem ps, Transform root, Camera camera)
        {
            int max = Mathf.Max(1, ps.main.maxParticles);
            var particles = new ParticleSystem.Particle[max];
            int count = ps.GetParticles(particles);
            var custom1 = new List<Vector4>(count);
            ps.GetCustomParticleData(custom1, ParticleSystemCustomData.Custom1);
            var values = new JArray();
            for (int i = 0; i < count; i++)
            {
                ParticleSystem.Particle p = particles[i];
                Vector3 position = p.position;
                Vector3 velocity = p.velocity;
                Vector3 worldPosition;
                Vector3 worldVelocity;
                var main = ps.main;
                if (main.simulationSpace == ParticleSystemSimulationSpace.World)
                {
                    worldPosition = position;
                    worldVelocity = velocity;
                }
                else
                {
                    Transform simulationTransform = main.simulationSpace == ParticleSystemSimulationSpace.Custom
                        && main.customSimulationSpace != null ? main.customSimulationSpace : ps.transform;
                    worldPosition = simulationTransform.TransformPoint(position);
                    worldVelocity = simulationTransform.TransformVector(velocity);
                }
                Vector3 size = p.GetCurrentSize3D(ps);
                Color32 color = p.GetCurrentColor(ps);
                JObject value = new JObject()
                    .Set("position", Vec3(position))
                    .Set("velocity", Vec3(velocity))
                    .Set("worldPosition", Vec3(worldPosition))
                    .Set("worldVelocity", Vec3(worldVelocity))
                    .Set("size", Vec3(size))
                    .Set("color", new JArray().Add(color.r / 255f).Add(color.g / 255f).Add(color.b / 255f).Add(color.a / 255f))
                    .Set("age", p.startLifetime - p.remainingLifetime)
                    .Set("life", p.startLifetime)
                    .Set("seed", (double)p.randomSeed);
                Vector3 rotation3D = p.rotation3D;
                Quaternion rotationQ = Quaternion.Euler(rotation3D);
                value.Set("rotationEulerDegrees", Vec3(rotation3D))
                    .Set("rotationQuaternion", new JArray().Add(rotationQ.x).Add(rotationQ.y)
                        .Add(rotationQ.z).Add(rotationQ.w));
                if (i < custom1.Count)
                {
                    Vector4 c = custom1[i];
                    value.Set("custom1", new JArray().Add(c.x).Add(c.y).Add(c.z).Add(c.w));
                }
                values.Add(value);
            }
            JObject result = new JObject()
                .Set("path", RelativePath(ps.transform, root))
                .Set("name", ps.name)
                .Set("count", count)
                .Set("particles", values);
            ParticleSystemRenderer renderer = ps.GetComponent<ParticleSystemRenderer>();
            // Bake the final renderer geometry for every render mode, including Mesh. Particle
            // state equality alone cannot detect renderer-space/alignment or source-mesh basis
            // mistakes: those happen after simulation.  The baked vertices are camera-independent
            // for Mesh mode and give the Web regression suite an exact post-transform reference.
            if (renderer != null && count > 0)
            {
                result.Set("renderer", new JObject()
                    .Set("renderMode", renderer.renderMode.ToString())
                    .Set("alignment", renderer.alignment.ToString())
                    .Set("velocityScale", renderer.velocityScale)
                    .Set("lengthScale", renderer.lengthScale)
                    .Set("cameraVelocityScale", renderer.cameraVelocityScale)
                    .Set("pivot", Vec3(renderer.pivot))
                    .Set("freeformStretching", renderer.freeformStretching)
                    .Set("rotateWithStretchDirection", renderer.rotateWithStretchDirection));
                var baked = new Mesh();
                try
                {
                    renderer.BakeMesh(baked, camera, false);
                    Vector3[] vertices = baked.vertices;
                    Vector2[] uvs = baked.uv;
                    Vector2[] uv1s = baked.uv2;
                    Color[] colors = baked.colors;
                    int stride = vertices.Length / count;
                    var quads = new JArray();
                    for (int particleIndex = 0; particleIndex < count; particleIndex++)
                    {
                        var quad = new JObject();
                        var vertexValues = new JArray();
                        var uvValues = new JArray();
                        var uv1Values = new JArray();
                        var colorValues = new JArray();
                        int begin = particleIndex * stride;
                        int end = Mathf.Min(vertices.Length, begin + stride);
                        for (int vertexIndex = begin; vertexIndex < end; vertexIndex++)
                        {
                            vertexValues.Add(Vec3(vertices[vertexIndex]));
                            if (vertexIndex < uvs.Length)
                                uvValues.Add(new JArray().Add(uvs[vertexIndex].x).Add(uvs[vertexIndex].y));
                            if (vertexIndex < uv1s.Length)
                                uv1Values.Add(new JArray().Add(uv1s[vertexIndex].x).Add(uv1s[vertexIndex].y));
                            if (vertexIndex < colors.Length)
                            {
                                Color c = colors[vertexIndex];
                                colorValues.Add(new JArray().Add(c.r).Add(c.g).Add(c.b).Add(c.a));
                            }
                        }
                        if (end > begin)
                        {
                            Vector3 center = Vector3.zero;
                            for (int vertexIndex = begin; vertexIndex < end; vertexIndex++)
                                center += vertices[vertexIndex];
                            center /= end - begin;
                            quad.Set("center", Vec3(center));
                        }
                        quad.Set("vertices", vertexValues).Set("uv", uvValues)
                            .Set("uv1", uv1Values).Set("colors", colorValues);
                        quads.Add(quad);
                    }
                    result.Set("renderGeometry", new JObject()
                        .Set("space", "world")
                        .Set("verticesPerParticle", stride)
                        .Set("particles", quads));

                    // BakeMesh does not promise the same particle ordering as GetParticles.
                    // For stretched renderer qualification, isolate each particle so its final
                    // quad can be paired with the exact simulation state without heuristics.
                    if (renderer.renderMode == ParticleSystemRenderMode.Stretch && count <= 64)
                    {
                        var isolated = new JArray();
                        var one = new ParticleSystem.Particle[1];
                        for (int particleIndex = 0; particleIndex < count; particleIndex++)
                        {
                            one[0] = particles[particleIndex];
                            ps.SetParticles(one, 1);
                            var singleMesh = new Mesh();
                            try
                            {
                                renderer.BakeMesh(singleMesh, camera, false);
                                Vector3[] singleVertices = singleMesh.vertices;
                                Vector3 center = Vector3.zero;
                                foreach (Vector3 vertex in singleVertices) center += vertex;
                                if (singleVertices.Length > 0) center /= singleVertices.Length;
                                Vector3 min = singleVertices.Length > 0 ? singleVertices[0] : Vector3.zero;
                                Vector3 maxVertex = min;
                                foreach (Vector3 vertex in singleVertices)
                                {
                                    min = Vector3.Min(min, vertex);
                                    maxVertex = Vector3.Max(maxVertex, vertex);
                                }
                                isolated.Add(new JObject().Set("center", Vec3(center))
                                    .Set("span", Vec3(maxVertex - min)));
                            }
                            finally { Object.DestroyImmediate(singleMesh); }
                        }
                        ps.SetParticles(particles, count);
                        result.Set("isolatedRenderGeometry", isolated);
                    }
                }
                finally
                {
                    Object.DestroyImmediate(baked);
                }
            }
            return result;
        }

        private static bool HasParticleAncestor(Transform t, Transform root)
        {
            for (Transform p = t.parent; p != null && p != root.parent; p = p.parent)
                if (p.GetComponent<ParticleSystem>() != null) return true;
            return false;
        }

        private static string RelativePath(Transform t, Transform root)
        {
            var names = new List<string>();
            for (Transform p = t; p != null; p = p.parent)
            {
                names.Add(p.name);
                if (p == root) break;
            }
            names.Reverse();
            return string.Join("/", names);
        }

        private static JArray Vec3(Vector3 v) => new JArray().Add(v.x).Add(v.y).Add(v.z);

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
            var chars = new System.Text.StringBuilder();
            foreach (char c in value.ToLowerInvariant())
                chars.Append(char.IsLetterOrDigit(c) ? c : '_');
            return chars.ToString().Trim('_');
        }
    }
}
