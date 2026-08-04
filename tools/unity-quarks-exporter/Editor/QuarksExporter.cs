using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace BabylonQuarks.UnityExporter
{
    /// <summary>
    /// Editor entry point: takes the selected GameObject hierarchy (a ParticleSystem or a parent of
    /// several) and writes a Quarks JSON effect that babylon.quarks' QuarksLoader can load. Groups
    /// map to Group nodes, ParticleSystems to ParticleEmitter nodes; sub-emitters are wired through
    /// EmitSubParticleSystem behaviors.
    /// </summary>
    public static class QuarksExporter
    {
        /// <summary>
        /// Bump when export envelope / CFXR fields change. Written into metadata.generator
        /// so Web / inject can tell old vs new scripts (old builds omit material.name + cfxr).
        /// </summary>
        public const string ExporterId = "unity-quarks-exporter@semantic-lifecycle-6";

        [MenuItem("Tools/Quarks/Export Selected Effect to JSON", false, 1)]
        public static void ExportSelected()
        {
            GameObject root = Selection.activeGameObject;
            if (root == null)
            {
                EditorUtility.DisplayDialog("Quarks Exporter",
                    "Select a GameObject with a ParticleSystem (or a parent of several) in the Hierarchy.", "OK");
                return;
            }
            if (root.GetComponentsInChildren<ParticleSystem>(true).Length == 0)
            {
                EditorUtility.DisplayDialog("Quarks Exporter",
                    "No ParticleSystem found under the selected GameObject.", "OK");
                return;
            }

            string path = EditorUtility.SaveFilePanel("Export Quarks effect", "", root.name + ".json", "json");
            if (string.IsNullOrEmpty(path)) return;

            try
            {
                ExportToFile(root, path);
            }
            catch (SemanticExportException e)
            {
                string report = path + ".diagnostics.json";
                WriteDiagnostics(report, root.name, e.Diagnostics);
                EditorUtility.DisplayDialog("Quarks Exporter",
                    $"Strict export rejected unsupported semantics.\n\nDiagnostics:\n{report}", "OK");
                Debug.LogError(e.Message);
                return;
            }
            Debug.Log($"[Quarks Exporter] {ExporterId} — if JSON materials lack \"name\"/\"cfxr\", Unity is not using this script.");
            EditorUtility.RevealInFinder(path);
        }

        [MenuItem("Tools/Quarks/Export Selected Effect to JSON", true)]
        private static bool ValidateExportSelected() => Selection.activeGameObject != null;

        [MenuItem("Tools/Quarks/Export Folder of Effects to JSON", false, 2)]
        public static void ExportSelectedFolder()
        {
            string assetFolder = GetSelectedAssetFolder();
            if (string.IsNullOrEmpty(assetFolder))
            {
                EditorUtility.DisplayDialog("Quarks Exporter",
                    "Select a folder under Assets in the Project window.", "OK");
                return;
            }

            string outputFolder = EditorUtility.OpenFolderPanel("Export Quarks effects to", "", "");
            if (string.IsNullOrEmpty(outputFolder)) return;

            ExportFolder(assetFolder, outputFolder);
        }

        [MenuItem("Tools/Quarks/Export Folder of Effects to JSON", true)]
        private static bool ValidateExportSelectedFolder() => !string.IsNullOrEmpty(GetSelectedAssetFolder());

        /// <summary>Writes one effect hierarchy to a JSON file on disk.</summary>
        public static void ExportToFile(GameObject root, string path)
        {
            string json = Export(root);
            File.WriteAllText(path, json);
            Debug.Log($"[Quarks Exporter] Exported '{root.name}' → {path}");
        }

        private static void WriteDiagnostics(string path, string effectName, IReadOnlyList<ExportDiagnostic> diagnostics)
        {
            var items = new JArray();
            foreach (var d in diagnostics) items.Add(d.ToJson());
            int errors = 0, warnings = 0;
            foreach (var d in diagnostics)
            {
                if (d.Severity == ExportSeverity.Error) errors++;
                else if (d.Severity == ExportSeverity.Warning) warnings++;
            }
            var report = new JObject()
                .Set("schema", "unity-vfx-export-diagnostics@2")
                .Set("effect", effectName)
                .Set("productionDisposition", errors > 0 ? "rejected" : "accepted")
                .Set("summary", new JObject().Set("errors", errors).Set("warnings", warnings))
                .Set("diagnostics", items);
            File.WriteAllText(path, report.ToString());
        }

        /// <summary>
        /// Exports every prefab with a ParticleSystem under <paramref name="assetFolder"/>.
        /// Output mirrors the subfolder layout relative to the selected Assets folder.
        /// </summary>
        public static void ExportFolder(string assetFolder, string outputFolder)
        {
            string[] guids = AssetDatabase.FindAssets("t:Prefab", new[] { assetFolder });
            var prefabPaths = new List<string>();
            foreach (string guid in guids)
            {
                string assetPath = AssetDatabase.GUIDToAssetPath(guid);
                GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
                if (prefab != null && prefab.GetComponentsInChildren<ParticleSystem>(true).Length > 0)
                {
                    prefabPaths.Add(assetPath);
                }
            }

            if (prefabPaths.Count == 0)
            {
                EditorUtility.DisplayDialog("Quarks Exporter",
                    $"No prefabs with ParticleSystem found under '{assetFolder}'.", "OK");
                return;
            }

            prefabPaths.Sort();
            string folderPrefix = assetFolder.EndsWith("/") ? assetFolder : assetFolder + "/";

            int exported = 0;
            int baked = 0;
            int skipped = 0;
            int rejected = 0;
            bool cancelled = false;

            try
            {
                for (int i = 0; i < prefabPaths.Count; i++)
                {
                    string assetPath = prefabPaths[i];
                    string prefabName = Path.GetFileNameWithoutExtension(assetPath);
                    AssetDatabase.ImportAsset(assetPath,
                        ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);
                    if (EditorUtility.DisplayCancelableProgressBar(
                            "Quarks Exporter",
                            $"Exporting {prefabName} ({i + 1}/{prefabPaths.Count})",
                            (float)i / prefabPaths.Count))
                    {
                        cancelled = true;
                        break;
                    }

                    GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
                    GameObject instance = PrefabUtility.InstantiatePrefab(prefab) as GameObject;
                    if (instance == null)
                    {
                        skipped++;
                        continue;
                    }

                    try
                    {
                        string relative = assetPath.StartsWith(folderPrefix)
                            ? assetPath.Substring(folderPrefix.Length)
                            : Path.GetFileName(assetPath);
                        string relativeDir = Path.GetDirectoryName(relative);
                        if (!string.IsNullOrEmpty(relativeDir))
                        {
                            relativeDir = relativeDir.Replace('/', Path.DirectorySeparatorChar);
                        }
                        string outDir = string.IsNullOrEmpty(relativeDir)
                            ? outputFolder
                            : Path.Combine(outputFolder, relativeDir);
                        Directory.CreateDirectory(outDir);
                        string outPath = Path.Combine(outDir, prefabName + ".json");
                        try
                        {
                            ExportToFile(instance, outPath);
                            if (File.Exists(outPath + ".diagnostics.json")) File.Delete(outPath + ".diagnostics.json");
                        }
                        catch (SemanticExportException e)
                        {
                            WriteDiagnostics(outPath + ".diagnostics.json", prefabName, e.Diagnostics);
                            try
                            {
                                BakedEffectExporter.ExportToFile(instance, outPath + ".oracle.json", e.Diagnostics);
                                if (File.Exists(outPath)) File.Delete(outPath);
                                rejected++;
                                baked++;
                                Debug.LogWarning($"[Quarks Exporter] Live compilation failed for '{prefabName}'; emitted comparison oracle only.");
                            }
                            catch (System.Exception bakeError)
                            {
                                rejected++;
                                if (File.Exists(outPath)) File.Delete(outPath);
                                Debug.LogError($"[Quarks Exporter] Rejected '{prefabName}': live compile and bake both failed. {bakeError}");
                            }
                            continue;
                        }
                        exported++;
                    }
                    finally
                    {
                        Object.DestroyImmediate(instance);
                    }
                }
            }
            finally
            {
                EditorUtility.ClearProgressBar();
            }

            string message = cancelled
                ? $"Cancelled after exporting {exported} of {prefabPaths.Count} effect(s)."
                : $"Exported {exported} effect(s) to:\n{outputFolder}";
            if (skipped > 0)
            {
                message += $"\n\nSkipped {skipped} prefab(s) that could not be instantiated.";
            }
            if (rejected > 0)
            {
                message += $"\n\nStrictly rejected {rejected} effect(s); see *.diagnostics.json.";
            }

            EditorUtility.DisplayDialog("Quarks Exporter", message, "OK");
            if (exported > 0)
            {
                EditorUtility.RevealInFinder(outputFolder);
            }
        }

        private static string GetSelectedAssetFolder()
        {
            if (Selection.activeObject == null) return null;
            string path = AssetDatabase.GetAssetPath(Selection.activeObject);
            return AssetDatabase.IsValidFolder(path) ? path : null;
        }

        /// <summary>Serializes a GameObject hierarchy into the Quarks JSON envelope string.</summary>
        public static string Export(GameObject root)
        {
            var ctx = new ExportContext();

            // Disable Unity's session-dependent auto seeds before validation/serialization.
            // The same stable per-emitter seeds are used by Unity oracle capture.
            foreach (ParticleSystem ps in root.GetComponentsInChildren<ParticleSystem>(true))
            {
                uint seed = ps.randomSeed != 0 ? ps.randomSeed : StableSeed(SemanticValidator.HierarchyPath(ps.transform));
                ps.useAutoRandomSeed = false;
                ps.randomSeed = seed;
            }

            // Pass 1: assign a stable node uuid to every transform (emitters too), then flag which
            // systems are sub-emitter targets — so their nodes serialize with onlyUsedByOther=true
            // and their parents' EmitSubParticleSystem behaviors can reference them by uuid.
            AssignUuids(root.transform, ctx);
            foreach (var ps in root.GetComponentsInChildren<ParticleSystem>(true))
            {
                var sub = ps.subEmitters;
                if (!sub.enabled) continue;
                for (int i = 0; i < sub.subEmittersCount; i++)
                {
                    ctx.MarkSubTarget(sub.GetSubEmitterSystem(i));
                }
            }
            // Sub-emitter targets cannot be calibrated by simulating them in isolation: their
            // birth RNG and transform come from parent events. Compile that spawn stream from one
            // deterministic full-hierarchy run before individual nodes are serialized.
            ParticleConverter.CaptureHierarchyInitialStates(root, ctx);

            // Strict semantic contract: validate before serializing. Lossy fallbacks such as
            // unsupported shape -> point or separate-axis curves -> X are no longer allowed.
            SemanticValidator.ValidateHierarchy(root, ctx);
            if (ctx.HasErrors)
                throw new SemanticExportException(root.name, ctx.Diagnostics);

            // Pass 2: serialize the hierarchy into the object tree.
            JObject obj = SerializeNode(root.transform, ctx);
            if (ctx.HasErrors)
                throw new SemanticExportException(root.name, ctx.Diagnostics);

            // Mesh-shape emitters emit a source Mesh node each; attach them under the root so
            // linkReferences can resolve every mesh_surface.mesh reference.
            if (ctx.MeshSourceNodes.Count > 0)
            {
                JArray children = obj.GetOrCreateArray("children");
                foreach (var meshNode in ctx.MeshSourceNodes)
                {
                    children.Add(meshNode);
                }
            }

            var envelope = new JObject()
                .Set("metadata", new JObject()
                    .Set("version", 4.5)
                    .Set("type", "Object3D")
                    .Set("generator", ExporterId))
                .Set("geometries", ctx.Geometries)
                .Set("materials", ctx.Materials)
                .Set("textures", ctx.Textures)
                .Set("images", ctx.Images)
                .Set("vfxIR", SemanticValidator.BuildContract(root, ctx))
                .Set("controllers", ControllerSemanticCompiler.BuildPrograms(root, ctx))
                .Set("object", obj);

            // ParticleSystem LightsModule → short-lived point light (CFXR_Effect / Free Slash).
            JObject cfxrEffect = BuildLightsModuleEffect(root);
            if (cfxrEffect != null) envelope.Set("cfxrEffect", cfxrEffect);

            return envelope.ToString();
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

        /// <summary>
        /// First enabled LightsModule on the hierarchy → root-level cfxrEffect metadata.
        /// Data-driven; no per-prefab names.
        /// </summary>
        private static JObject BuildLightsModuleEffect(GameObject root)
        {
            if (root == null) return null;
            foreach (var ps in root.GetComponentsInChildren<ParticleSystem>(true))
            {
                var lights = ps.lights;
                if (!lights.enabled || lights.light == null) continue;
                Light l = lights.light;
                Color c = l.color;
                float intensity = l.intensity * Mathf.Max(0.01f, lights.intensity.constant);
                float duration = Mathf.Clamp(ps.main.startLifetime.constant, 0.05f, 2f);
                if (ps.main.startLifetime.mode != ParticleSystemCurveMode.Constant)
                    duration = Mathf.Clamp(ps.main.startLifetime.constantMax, 0.05f, 2f);
                return new JObject()
                    .Set("intensityStart", intensity * 80f) // Web PointLight is darker than URP
                    .Set("duration", duration)
                    .Set("color", new JArray().Add(c.r).Add(c.g).Add(c.b))
                    .Set("range", l.range > 0 ? l.range : 10f);
            }
            return null;
        }

        [MenuItem("Tools/Quarks/Diagnose Exporter Version", false, 50)]
        public static void DiagnoseExporterVersion()
        {
            string scriptPath = new System.Diagnostics.StackTrace(true).GetFrame(0)?.GetFileName() ?? "(unknown)";
            EditorUtility.DisplayDialog(
                "Quarks Exporter",
                $"{ExporterId}\n\nScript file:\n{scriptPath}\n\n" +
                "After export, JSON metadata.generator must equal that id.\n" +
                "Old exporters write \"unity-quark-exporter\" and omit material.name + material.cfxr.",
                "OK");
            Debug.Log($"[Quarks Exporter] Diagnose: {ExporterId}\n{scriptPath}");
        }

        [MenuItem("Tools/Quarks/Batch Export CFXR Prefabs to Web", false, 3)]
        public static void BatchExportCfxrToWeb()
        {
            BatchExportPrefabsToWeb(
                labelPrefix: "CFXR",
                folderCandidates: new[]
                {
                    "Assets/JMO Assets/Cartoon FX Remaster/CFXR Prefabs",
                    "Assets/Cartoon FX Remaster/CFXR Prefabs",
                    "Assets/JMO Assets/Cartoon FX Remaster Free/CFXR Prefabs",
                    "Assets/Cartoon FX Remaster Free/CFXR Prefabs",
                },
                missingHint:
                    "CFXR Prefabs folder not found.\nRestore to downloads/JMO Assets/Cartoon FX Remaster");
        }

        /// <summary>
        /// Batch-export the legacy Cartoon FX Free collection.  These are regular Shuriken
        /// prefabs using Unity's built-in particle blend shaders, so they go through the same
        /// strict semantic compiler as every other pack; unsupported script/material semantics
        /// are diagnosed and retained only as comparison oracles.
        /// CLI: -executeMethod BabylonQuarks.UnityExporter.QuarksExporter.BatchExportCfxLegacyToWeb
        /// </summary>
        [MenuItem("Tools/Quarks/Batch Export Cartoon FX Legacy Prefabs to Web", false, 3)]
        public static void BatchExportCfxLegacyToWeb()
        {
            BatchExportPrefabsToWeb(
                labelPrefix: "Cartoon FX",
                folderCandidates: new[]
                {
                    "Assets/JMO Assets/Cartoon FX (legacy)",
                    "Assets/Cartoon FX (legacy)",
                },
                missingHint:
                    "Cartoon FX legacy prefabs not found.\nExpected Assets/JMO Assets/Cartoon FX (legacy)");
        }

        /// <summary>
        /// Batch-export Free Slash VFX Prefabs → public/assets/quarks/ + manifest.json.
        /// CLI: -executeMethod BabylonQuarks.UnityExporter.QuarksExporter.BatchExportFreeSlashToWeb
        /// </summary>
        [MenuItem("Tools/Quarks/Batch Export Free Slash Prefabs to Web", false, 4)]
        public static void BatchExportFreeSlashToWeb()
        {
            BatchExportPrefabsToWeb(
                labelPrefix: "Slash",
                folderCandidates: new[]
                {
                    "Assets/Free Slash VFX/Prefabs",
                    "Assets/Free Slash VFX",
                },
                missingHint:
                    "Free Slash Prefabs not found.\nExpected Assets/Free Slash VFX/Prefabs");
        }

        /// <summary>Focused development export for collision sub-emitter and Orb Warp qualification.</summary>
        public static void BatchExportSlashWaterLiveToWeb()
        {
            BatchExportFocusedLive(
                "Assets/Free Slash VFX/Prefabs/Slash Water VFX.prefab",
                "Slash Water VFX.json");
        }

        public static void BatchExportProjectileFireLiveToWeb()
        {
            BatchExportFocusedLive(
                "Assets/Free Slash VFX/Prefabs/Projectiles/Slash Projectile VFX Fire.prefab",
                "Slash Projectile VFX Fire.json");
        }

        public static void BatchExportProjectileEarthLiveToWeb()
        {
            BatchExportFocusedLive(
                "Assets/Free Slash VFX/Prefabs/Projectiles/Slash Projectile VFX Earth.prefab",
                "Slash Projectile VFX Earth.json");
        }

        /// <summary>
        /// First focused qualification target for Cartoon FX legacy.  Kept separate from the
        /// whole-pack scan so evolving one material/controller adapter never rewrites unrelated
        /// candidate output or turns an oracle into a production artifact by accident.
        /// </summary>
        public static void BatchExportCfx3FireExplosionLiveToWeb()
        {
            BatchExportFocusedLive(
                "Assets/JMO Assets/Cartoon FX (legacy)/CFX3 Prefabs/Fire/CFX3_Fire_Explosion.prefab",
                "CFX3_Fire_Explosion.json");
        }

        /// <summary>Focused qualification target for fixed-row legacy electric flipbooks.</summary>
        public static void BatchExportCfx3ElectricGroundLiveToWeb()
        {
            BatchExportFocusedLive(
                "Assets/JMO Assets/Cartoon FX (legacy)/CFX3 Prefabs/Electric/CFX3_Hit_Electric_A_Ground.prefab",
                "CFX3_Hit_Electric_A_Ground.json");
        }

        public static void BatchExportCfx2BatsCloudLiveToWeb()
        {
            BatchExportFocusedLive(
                "Assets/JMO Assets/Cartoon FX (legacy)/CFX2 Prefabs/Misc/CFX2_BatsCloud.prefab",
                "CFX2_BatsCloud.json");
        }

        /// <summary>Bounded five-effect qualification batch for shared pickup/heart curves.</summary>
        public static void BatchExportCfx2PickupCurveBatchLiveToWeb()
        {
            string[] names = {
                "CFX2_BrokenHeart", "CFX2_PickupDiamond2", "CFX2_PickupHeart",
                "CFX2_PickupSmiley2", "CFX2_PickupStar"
            };
            string projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, "..", ".."));
            if (!Directory.Exists(Path.Combine(projectRoot, "public", "assets", "quarks")))
                projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
            string outDir = Path.Combine(projectRoot, "public", "assets", "quarks");
            string oracleDir = Path.Combine(outDir, "oracles");
            Directory.CreateDirectory(oracleDir);
            foreach (string name in names)
            {
                string category = name == "CFX2_BrokenHeart" ? "Misc" : "Pickup Items";
                string assetPath = "Assets/JMO Assets/Cartoon FX (legacy)/CFX2 Prefabs/"
                    + category + "/" + name + ".prefab";
                GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
                if (prefab == null) { Debug.LogError($"[Quarks Exporter] Missing {assetPath}"); EditorApplication.Exit(1); return; }
                GameObject instance = PrefabUtility.InstantiatePrefab(prefab) as GameObject;
                try
                {
                    string fileName = name + ".json";
                    string outPath = Path.Combine(outDir, fileName);
                    ExportToFile(instance, outPath);
                    if (File.Exists(outPath + ".diagnostics.json")) File.Delete(outPath + ".diagnostics.json");
                    BakedEffectExporter.ExportToFile(instance, Path.Combine(oracleDir, fileName));
                }
                finally { if (instance != null) Object.DestroyImmediate(instance); }
            }
            EditorApplication.Exit(0);
        }

        /// <summary>Bounded qualification export: regression batch 5 (never scans the pack).</summary>
        public static void BatchExportCfx2RegressionBatch5LiveToWeb()
        {
            string root = "Assets/JMO Assets/Cartoon FX (legacy)/CFX2 Prefabs/";
            string[] paths =
            {
                root + "Blood/CFX2_Blood.prefab",
                root + "Misc/CFX2_BrokenHeart.prefab",
                root + "Skull & Ghosts Effects/CFX2_EnemyDeathSkull.prefab",
                root + "Debris Hits/CFX2_RockHit.prefab",
                root + "Electric/CFX2_SparksHit_B Sphere.prefab",
            };
            foreach (string path in paths)
            {
                if (AssetDatabase.LoadAssetAtPath<GameObject>(path) == null)
                    throw new FileNotFoundException("Focused regression prefab missing", path);
                ExportFocusedLive(path, Path.GetFileNameWithoutExtension(path) + ".json");
            }
            EditorApplication.Exit(0);
        }

        /// <summary>Bounded qualification export: mixed legacy additive/billboard batch.</summary>
        public static void BatchExportCfxLegacyRegressionBatch4LiveToWeb()
        {
            string root = "Assets/JMO Assets/Cartoon FX (legacy)/";
            string[] paths =
            {
                root + "CFX2 Prefabs/Water/CFX2_Big_Splash (No Collision).prefab",
                root + "CFX2 Prefabs/Misc/CFX2_Wandering_Spirits.prefab",
                root + "CFX3 Prefabs/Misc/CFX3_Hit_SmokePuff.prefab",
                root + "CFX4 Prefabs/Electric/CFX4 Sparks Explosion B.prefab",
            };
            foreach (string path in paths)
            {
                if (AssetDatabase.LoadAssetAtPath<GameObject>(path) == null)
                    throw new FileNotFoundException("Focused regression prefab missing", path);
                ExportFocusedLive(path, Path.GetFileNameWithoutExtension(path) + ".json");
            }
            EditorApplication.Exit(0);
        }

        public static void BatchExportCfx2BigSplashLiveToWeb()
        {
            BatchExportFocusedLive(
                "Assets/JMO Assets/Cartoon FX (legacy)/CFX2 Prefabs/Water/CFX2_Big_Splash (No Collision).prefab",
                "CFX2_Big_Splash (No Collision).json");
        }

        public static void BatchExportCfx2WwExplosionLiveToWeb()
        {
            BatchExportFocusedLive(
                "Assets/JMO Assets/Cartoon FX (legacy)/CFX2 Prefabs/Explosions/CFX2_WWExplosion_C.prefab",
                "CFX2_WWExplosion_C.json");
        }

        public static void BatchExportCfx2WanderingSpiritsLiveToWeb()
        {
            BatchExportFocusedLive(
                "Assets/JMO Assets/Cartoon FX (legacy)/CFX2 Prefabs/Misc/CFX2_Wandering_Spirits.prefab",
                "CFX2_Wandering_Spirits.json");
        }

        public static void BatchExportCfxMagicalSourceLiveToWeb()
        {
            BatchExportFocusedLive(
                "Assets/JMO Assets/Cartoon FX (legacy)/CFX Prefabs/Misc/CFX_Magical_Source.prefab",
                "CFX_Magical_Source.json");
        }

        public static void BatchExportCfxFireworkTrailsLiveToWeb()
        {
            BatchExportFocusedLive(
                "Assets/JMO Assets/Cartoon FX (legacy)/CFX Prefabs/Explosions/CFX_Firework_Trails_Gravity.prefab",
                "CFX_Firework_Trails_Gravity.json");
        }

        public static void BatchExportCfxTornadoLiveToWeb()
        {
            BatchExportFocusedLive(
                "Assets/JMO Assets/Cartoon FX (legacy)/CFX Prefabs/Misc/CFX_Tornado.prefab",
                "CFX_Tornado.json");
        }

        public static void BatchExportCfx3VortexGroundLiveToWeb()
        {
            BatchExportFocusedLive(
                "Assets/JMO Assets/Cartoon FX (legacy)/CFX3 Prefabs/Magic Misc/CFX3_Vortex_Ground.prefab",
                "CFX3_Vortex_Ground.json");
        }

        public static void BatchExportCfx4FireLiveToWeb()
        {
            BatchExportFocusedLive(
                "Assets/JMO Assets/Cartoon FX (legacy)/CFX4 Prefabs/Fire/CFX4 Fire.prefab",
                "CFX4 Fire.json");
        }

        public static void BatchExportCfx3FireShieldLiveToWeb()
        {
            BatchExportFocusedLive(
                "Assets/JMO Assets/Cartoon FX (legacy)/CFX3 Prefabs/Fire/CFX3_Fire_Shield.prefab",
                "CFX3_Fire_Shield.json");
        }

        private static void BatchExportFocusedLive(string assetPath, string fileName)
        {
            try { ExportFocusedLive(assetPath, fileName); EditorApplication.Exit(0); }
            catch (SemanticExportException e)
            {
                string outDir = ResolveWebQuarksOutputDirectory();
                WriteDiagnostics(Path.Combine(outDir, fileName + ".diagnostics.json"), fileName, e.Diagnostics);
                Debug.LogException(e);
                EditorApplication.Exit(1);
            }
            catch (System.Exception e) { Debug.LogException(e); EditorApplication.Exit(1); }
        }

        private static string ResolveWebQuarksOutputDirectory()
        {
            string projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, "..", ".."));
            if (!Directory.Exists(Path.Combine(projectRoot, "public", "assets", "quarks")))
                projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
            string outDir = Path.Combine(projectRoot, "public", "assets", "quarks");
            Directory.CreateDirectory(outDir);
            return outDir;
        }

        private static void ExportFocusedLive(string assetPath, string fileName)
        {
            GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
            if (prefab == null) throw new FileNotFoundException("Focused prefab missing", assetPath);
            string outDir = ResolveWebQuarksOutputDirectory();
            GameObject instance = PrefabUtility.InstantiatePrefab(prefab) as GameObject;
            try
            {
                string outPath = Path.Combine(outDir, fileName);
                ExportToFile(instance, outPath);
                if (File.Exists(outPath + ".diagnostics.json")) File.Delete(outPath + ".diagnostics.json");
                string oracleDir = Path.Combine(outDir, "oracles");
                Directory.CreateDirectory(oracleDir);
                BakedEffectExporter.ExportToFile(instance, Path.Combine(oracleDir, fileName));
            }
            finally { if (instance != null) UnityEngine.Object.DestroyImmediate(instance); }
        }

        /// <summary>Focused development export; does not rewrite the candidate manifest.</summary>
        public static void BatchExportSlashElectricLiveToWeb()
        {
            const string assetPath = "Assets/Free Slash VFX/Prefabs/Slash Eletric VFX.prefab";
            GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
            if (prefab == null) { Debug.LogError($"[Quarks Exporter] Missing {assetPath}"); EditorApplication.Exit(1); return; }
            string projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, "..", ".."));
            if (!Directory.Exists(Path.Combine(projectRoot, "public", "assets", "quarks")))
                projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
            string outDir = Path.Combine(projectRoot, "public", "assets", "quarks");
            Directory.CreateDirectory(outDir);
            GameObject instance = PrefabUtility.InstantiatePrefab(prefab) as GameObject;
            try
            {
                string outPath = Path.Combine(outDir, "Slash Eletric VFX.json");
                ExportToFile(instance, outPath);
                if (File.Exists(outPath + ".diagnostics.json")) File.Delete(outPath + ".diagnostics.json");
                string oracleDir = Path.Combine(outDir, "oracles");
                Directory.CreateDirectory(oracleDir);
                BakedEffectExporter.ExportToFile(instance, Path.Combine(oracleDir, "Slash Eletric VFX.json"));
                EditorApplication.Exit(0);
            }
            catch (System.Exception e) { Debug.LogException(e); EditorApplication.Exit(1); }
            finally { if (instance != null) UnityEngine.Object.DestroyImmediate(instance); }
        }

        /// <summary>Focused development export; does not rewrite the candidate manifest.</summary>
        public static void BatchExportSlashFireLiveToWeb()
        {
            const string assetPath = "Assets/Free Slash VFX/Prefabs/Slash Fire VFX.prefab";
            GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
            if (prefab == null) { Debug.LogError($"[Quarks Exporter] Missing {assetPath}"); EditorApplication.Exit(1); return; }
            string projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, "..", ".."));
            if (!Directory.Exists(Path.Combine(projectRoot, "public", "assets", "quarks")))
                projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
            string outDir = Path.Combine(projectRoot, "public", "assets", "quarks");
            Directory.CreateDirectory(outDir);
            GameObject instance = PrefabUtility.InstantiatePrefab(prefab) as GameObject;
            try
            {
                string outPath = Path.Combine(outDir, "Slash Fire VFX.json");
                ExportToFile(instance, outPath);
                if (File.Exists(outPath + ".diagnostics.json")) File.Delete(outPath + ".diagnostics.json");
                string oracleDir = Path.Combine(outDir, "oracles");
                Directory.CreateDirectory(oracleDir);
                BakedEffectExporter.ExportToFile(instance, Path.Combine(oracleDir, "Slash Fire VFX.json"));
                EditorApplication.Exit(0);
            }
            catch (System.Exception e) { Debug.LogException(e); EditorApplication.Exit(1); }
            finally { if (instance != null) UnityEngine.Object.DestroyImmediate(instance); }
        }

        /// <summary>Focused development export; does not rewrite the candidate manifest.</summary>
        public static void BatchExportMultipleSlashesLiveToWeb()
        {
            const string assetPath = "Assets/Free Slash VFX/Prefabs/Multiple Slashes.prefab";
            GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
            if (prefab == null) { Debug.LogError($"[Quarks Exporter] Missing {assetPath}"); EditorApplication.Exit(1); return; }
            string projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, "..", ".."));
            if (!Directory.Exists(Path.Combine(projectRoot, "public", "assets", "quarks")))
                projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
            string outDir = Path.Combine(projectRoot, "public", "assets", "quarks");
            Directory.CreateDirectory(outDir);
            GameObject instance = PrefabUtility.InstantiatePrefab(prefab) as GameObject;
            try
            {
                string outPath = Path.Combine(outDir, "Multiple Slashes.json");
                ExportToFile(instance, outPath);
                if (File.Exists(outPath + ".diagnostics.json")) File.Delete(outPath + ".diagnostics.json");
                string oracleDir = Path.Combine(outDir, "oracles");
                Directory.CreateDirectory(oracleDir);
                BakedEffectExporter.ExportToFile(instance, Path.Combine(oracleDir, "Multiple Slashes.json"));
                EditorApplication.Exit(0);
            }
            catch (System.Exception e) { Debug.LogException(e); EditorApplication.Exit(1); }
            finally { if (instance != null) UnityEngine.Object.DestroyImmediate(instance); }
        }

        /// <summary>Focused strict-live compiler target used while bringing up the Impact IR.</summary>
        public static void BatchExportImpactLiveToWeb()
        {
            const string assetPath = "Assets/Free Slash VFX/Prefabs/Impact.prefab";
            GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
            if (prefab == null)
            {
                Debug.LogError($"[Quarks Exporter] Missing {assetPath}");
                EditorApplication.Exit(1);
                return;
            }
            string projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, "..", ".."));
            if (!Directory.Exists(Path.Combine(projectRoot, "public", "assets", "quarks")))
                projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
            string outDir = Path.Combine(projectRoot, "public", "assets", "quarks");
            Directory.CreateDirectory(outDir);
            string outPath = Path.Combine(outDir, "Impact.json");
            GameObject instance = PrefabUtility.InstantiatePrefab(prefab) as GameObject;
            try
            {
                ExportToFile(instance, outPath);
                string oracleDir = Path.Combine(outDir, "oracles");
                Directory.CreateDirectory(oracleDir);
                BakedEffectExporter.ExportToFile(instance, Path.Combine(oracleDir, "Impact.json"));
                if (File.Exists(outPath + ".diagnostics.json")) File.Delete(outPath + ".diagnostics.json");
                WriteFocusedCandidateManifest(outDir,
                    ("impact", "Slash · Impact (live IR)", "Impact.json", "live-particles@1"));
                Debug.Log($"[Quarks Exporter] Strict live Impact → {outPath}");
                EditorApplication.Exit(0);
            }
            catch (SemanticExportException e)
            {
                WriteDiagnostics(outPath + ".diagnostics.json", "Impact", e.Diagnostics);
                if (File.Exists(outPath)) File.Delete(outPath);
                Debug.LogError($"[Quarks Exporter] Strict live Impact rejected ({e.Diagnostics.Count} diagnostics)");
                EditorApplication.Exit(1);
            }
            finally
            {
                if (instance != null) Object.DestroyImmediate(instance);
            }
        }

        /// <summary>Focused strict-live target used while extending the Multiple Impact IR.</summary>
        public static void BatchExportMultipleImpactLiveToWeb()
        {
            const string assetPath = "Assets/Free Slash VFX/Prefabs/Multiple Impact.prefab";
            GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
            if (prefab == null)
            {
                Debug.LogError($"[Quarks Exporter] Missing {assetPath}");
                EditorApplication.Exit(1);
                return;
            }
            string projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, "..", ".."));
            if (!Directory.Exists(Path.Combine(projectRoot, "public", "assets", "quarks")))
                projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
            string outDir = Path.Combine(projectRoot, "public", "assets", "quarks");
            Directory.CreateDirectory(outDir);
            string outPath = Path.Combine(outDir, "Multiple Impact.json");
            GameObject instance = PrefabUtility.InstantiatePrefab(prefab) as GameObject;
            try
            {
                ExportToFile(instance, outPath);
                string oracleDir = Path.Combine(outDir, "oracles");
                Directory.CreateDirectory(oracleDir);
                BakedEffectExporter.ExportToFile(instance, Path.Combine(oracleDir, "Multiple Impact.json"));
                if (File.Exists(outPath + ".diagnostics.json")) File.Delete(outPath + ".diagnostics.json");
                WriteFocusedCandidateManifest(outDir,
                    ("multiple_impact", "Slash · Multiple Impact (live IR)",
                        "Multiple Impact.json", "live-particles@1"));
                Debug.Log($"[Quarks Exporter] Strict live Multiple Impact → {outPath}");
                EditorApplication.Exit(0);
            }
            catch (SemanticExportException e)
            {
                WriteDiagnostics(outPath + ".diagnostics.json", "Multiple Impact", e.Diagnostics);
                if (File.Exists(outPath)) File.Delete(outPath);
                Debug.LogError($"[Quarks Exporter] Strict live Multiple Impact rejected ({e.Diagnostics.Count} diagnostics)");
                EditorApplication.Exit(1);
            }
            finally
            {
                if (instance != null) Object.DestroyImmediate(instance);
            }
        }

        /// <summary>
        /// Shared batch export: every ParticleSystem prefab under the first existing folder.
        /// Rewrites manifest.json (keeps other existing *.json entries already on disk if mergeExisting).
        /// </summary>
        public static void BatchExportPrefabsToWeb(string labelPrefix, string[] folderCandidates, string missingHint)
        {
            string projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, "..", ".."));
            if (!Directory.Exists(Path.Combine(projectRoot, "public", "assets", "quarks")))
                projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));

            string outDir = Path.Combine(projectRoot, "public", "assets", "quarks");
            string prefabRoot = null;
            foreach (string c in folderCandidates)
            {
                if (AssetDatabase.IsValidFolder(c))
                {
                    prefabRoot = c;
                    break;
                }
            }

            if (string.IsNullOrEmpty(prefabRoot))
            {
                Debug.LogError("[Quarks Exporter] " + missingHint);
                if (!Application.isBatchMode)
                    EditorUtility.DisplayDialog("Quarks Exporter", missingHint, "OK");
                if (Application.isBatchMode) EditorApplication.Exit(1);
                return;
            }

            if (!Directory.Exists(outDir))
                Directory.CreateDirectory(outDir);

            AssetDatabase.Refresh();
            List<string> prefabPaths = FindPrefabAssetPaths(prefabRoot);
            var effects = new List<(string id, string label, string file, string note)>();
            int exported = 0;
            int baked = 0;
            int skipped = 0;
            int rejected = 0;

            try
            {
                for (int i = 0; i < prefabPaths.Count; i++)
                {
                    string assetPath = prefabPaths[i];
                    string prefabName = Path.GetFileNameWithoutExtension(assetPath);
                    if (!Application.isBatchMode)
                    {
                        if (EditorUtility.DisplayCancelableProgressBar(
                                "Quarks Exporter",
                            $"Exporting {prefabName} ({i + 1}/{prefabPaths.Count})",
                            (float)i / Mathf.Max(1, prefabPaths.Count)))
                            break;
                    }

                    GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
                    if (prefab == null || prefab.GetComponentsInChildren<ParticleSystem>(true).Length == 0)
                    {
                        Object mainAsset = AssetDatabase.LoadMainAssetAtPath(assetPath);
                        Debug.LogWarning($"[Quarks Exporter] Skipped '{assetPath}': " +
                            (prefab == null
                                ? $"LoadAssetAtPath<GameObject> returned null (main type: {mainAsset?.GetType().FullName ?? "null"})"
                                : "no ParticleSystem in prefab hierarchy"));
                        skipped++;
                        continue;
                    }

                    GameObject instance = PrefabUtility.InstantiatePrefab(prefab) as GameObject;
                    if (instance == null)
                    {
                        skipped++;
                        continue;
                    }

                    try
                    {
                        string outPath = Path.Combine(outDir, prefabName + ".json");
                        try
                        {
                            ExportToFile(instance, outPath);
                            string candidateOracleDir = Path.Combine(outDir, "oracles");
                            Directory.CreateDirectory(candidateOracleDir);
                            BakedEffectExporter.ExportToFile(instance,
                                Path.Combine(candidateOracleDir, prefabName + ".json"));
                            if (File.Exists(outPath + ".diagnostics.json")) File.Delete(outPath + ".diagnostics.json");
                        }
                        catch (SemanticExportException e)
                        {
                            WriteDiagnostics(outPath + ".diagnostics.json", prefabName, e.Diagnostics);
                            try
                            {
                                string oracleDir = Path.Combine(outDir, "oracles");
                                Directory.CreateDirectory(oracleDir);
                                BakedEffectExporter.ExportToFile(instance,
                                    Path.Combine(oracleDir, prefabName + ".json"), e.Diagnostics);
                                baked++;
                                rejected++;
                                if (File.Exists(outPath)) File.Delete(outPath);
                                Debug.LogWarning($"[Quarks Exporter] Live compilation failed for '{prefabName}'; camera-baked@1 was emitted as a comparison oracle only.");
                            }
                            catch (System.Exception bakeError)
                            {
                                rejected++;
                                if (File.Exists(outPath)) File.Delete(outPath);
                                Debug.LogError($"[Quarks Exporter] Rejected '{prefabName}': live compile and bake both failed. {bakeError}");
                            }
                            continue;
                        }
                        string note = labelPrefix;
                        string rel = assetPath.StartsWith(prefabRoot + "/")
                            ? assetPath.Substring(prefabRoot.Length + 1)
                            : Path.GetFileName(assetPath);
                        int slash = rel.IndexOf('/');
                        if (slash > 0) note = labelPrefix + "/" + rel.Substring(0, slash);
                        effects.Add((SanitizeId(prefabName), $"{labelPrefix} · {prefabName}", prefabName + ".json", note));
                        exported++;
                    }
                    finally
                    {
                        Object.DestroyImmediate(instance);
                    }
                }
            }
            finally
            {
                if (!Application.isBatchMode)
                    EditorUtility.ClearProgressBar();
            }

            // Preserve only other strict semantic artifacts. Legacy JSON may still exist on
            // disk for migration/debugging, but must never enter a manifest consumed by the
            // strict runtime.
            foreach (string existing in Directory.GetFiles(outDir, "*.json"))
            {
                string fileName = Path.GetFileName(existing);
                if (fileName == "manifest.json" || fileName.EndsWith(".diagnostics.json")) continue;
                if (File.Exists(existing + ".fixture")) continue;
                if (effects.Exists(e => e.file == fileName)) continue;
                if (!IsStrictSemanticArtifact(existing))
                {
                    Debug.LogWarning($"[Quarks Exporter] Excluded legacy/non-semantic artifact from manifest: {fileName}");
                    continue;
                }
                string stem = Path.GetFileNameWithoutExtension(fileName);
                effects.Add((SanitizeId(stem), stem, fileName, "existing"));
            }

            effects.Sort((a, b) => string.CompareOrdinal(a.label, b.label));
            WriteQuarksManifest(Path.Combine(outDir, "manifest.candidates.json"), effects);

            string summary = $"Batch exported {exported} {labelPrefix} effect(s) from {prefabRoot} → {outDir}";
            if (baked > 0) summary += $" (comparison oracle {baked})";
            if (skipped > 0) summary += $" (skipped {skipped})";
            if (rejected > 0) summary += $" (strictly rejected {rejected}; see *.diagnostics.json)";
            Debug.Log($"[Quarks Exporter] {summary}");
            if (!Application.isBatchMode)
                EditorUtility.DisplayDialog("Quarks Exporter", summary, "OK");
            if (Application.isBatchMode) EditorApplication.Exit(rejected == 0 && exported > 0 ? 0 : 1);
        }

        private static bool IsStrictSemanticArtifact(string path)
        {
            try
            {
                string json = File.ReadAllText(path);
                return json.Contains("\"vfxIR\"")
                    && json.Contains("\"schema\": \"unity-vfx-ir@1\"")
                    && json.Contains("\"policy\": \"strict\"");
            }
            catch (System.Exception e)
            {
                Debug.LogWarning($"[Quarks Exporter] Cannot inspect artifact '{path}': {e.Message}");
                return false;
            }
        }

        private static void WriteFocusedCandidateManifest(string outDir,
            (string id, string label, string file, string note) focused)
        {
            var effects = new List<(string id, string label, string file, string note)> { focused };
            foreach (string existing in Directory.GetFiles(outDir, "*.json"))
            {
                string fileName = Path.GetFileName(existing);
                if (fileName == "manifest.json" || fileName == "manifest.candidates.json"
                    || fileName.EndsWith(".diagnostics.json") || fileName == focused.file)
                    continue;
                if (File.Exists(existing + ".fixture")) continue;
                if (!IsStrictSemanticArtifact(existing)) continue;
                string stem = Path.GetFileNameWithoutExtension(fileName);
                effects.Add((SanitizeId(stem), stem, fileName, "existing strict candidate"));
            }
            effects.Sort((a, b) => string.CompareOrdinal(a.label, b.label));
            WriteQuarksManifest(Path.Combine(outDir, "manifest.candidates.json"), effects);
        }

        /// <summary>
        /// Discover and export every particle prefab in the imported Unity project.
        /// This is the batch equivalent of selecting each package folder and choosing
        /// Export Folder. It writes only the candidate catalog and preserves production.
        /// </summary>
        [MenuItem("Tools/Quarks/Batch Export All Asset Prefabs to Web", false, 5)]
        public static void BatchExportAllAssetPrefabsToWeb()
        {
            ParticleConverter.DisableTrajectoryBake = true;
            string projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, "..", ".."));
            if (!Directory.Exists(Path.Combine(projectRoot, "public", "assets", "quarks")))
                projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
            string outDir = Path.Combine(projectRoot, "public", "assets", "quarks");
            Directory.CreateDirectory(outDir);

            string[] guids = AssetDatabase.FindAssets("t:Prefab", new[] { "Assets" });
            var prefabPaths = new List<string>();
            foreach (string guid in guids)
            {
                string path = AssetDatabase.GUIDToAssetPath(guid).Replace('\\', '/');
                if (IsBatchExcludedAssetPath(path)) continue;
                GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                if (prefab != null && prefab.GetComponentsInChildren<ParticleSystem>(true).Length > 0)
                    prefabPaths.Add(path);
            }
            prefabPaths.Sort();
            var effects = new List<(string id, string label, string file, string note)>();
            int exported = 0, skipped = 0, rejected = 0;
            try
            {
                for (int i = 0; i < prefabPaths.Count; i++)
                {
                    string assetPath = prefabPaths[i];
                    if (!Application.isBatchMode && EditorUtility.DisplayCancelableProgressBar(
                            "Quarks Exporter", $"Exporting {assetPath} ({i + 1}/{prefabPaths.Count})",
                            (float)i / Mathf.Max(1, prefabPaths.Count))) break;
                    GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
                    if (prefab != null && IsAutoExportTooLarge(prefab, out string sizeReason))
                    {
                        skipped++;
                        Debug.LogWarning($"[Quarks Exporter] Skipped oversized prefab '{assetPath}': {sizeReason}");
                        continue;
                    }
                    GameObject instance = prefab == null ? null : PrefabUtility.InstantiatePrefab(prefab) as GameObject;
                    if (instance == null) { skipped++; continue; }
                    try
                    {
                        string rel = assetPath.StartsWith("Assets/") ? assetPath.Substring(7) : assetPath;
                        string id = SanitizeId(Path.ChangeExtension(rel, null).Replace('\\', '/').Replace('/', '_'));
                        string file = id + ".json";
                        string outPath = Path.Combine(outDir, file);
                        try { ExportToFile(instance, outPath); }
                        catch (SemanticExportException e)
                        {
                            rejected++;
                            WriteDiagnostics(outPath + ".diagnostics.json", prefab.name, e.Diagnostics);
                            if (File.Exists(outPath)) File.Delete(outPath);
                            Debug.LogError($"[Quarks Exporter] Rejected '{assetPath}': {e.Message}");
                            continue;
                        }
                        string[] parts = rel.Split('/');
                        string package = parts.Length > 1 ? parts[0] : "Assets";
                        effects.Add((id, package + " · " + prefab.name, file, assetPath));
                        exported++;
                    }
                    finally { Object.DestroyImmediate(instance); }
                }
            }
            finally { if (!Application.isBatchMode) EditorUtility.ClearProgressBar(); }

            foreach (string existing in Directory.GetFiles(outDir, "*.json"))
            {
                string file = Path.GetFileName(existing);
                if (file == "manifest.json" || file == "manifest.candidates.json" || file.EndsWith(".diagnostics.json")) continue;
                if (new FileInfo(existing).Length > 50L * 1024L * 1024L) continue;
                if (effects.Exists(e => e.file == file)) continue;
                string stem = Path.GetFileNameWithoutExtension(file);
                effects.Add((SanitizeId(stem), stem, file, "existing"));
            }
            effects.Sort((a, b) => string.CompareOrdinal(a.label, b.label));
            WriteQuarksManifest(Path.Combine(outDir, "manifest.candidates.json"), effects);
            string summary = $"Discovered {prefabPaths.Count} particle prefab(s); exported {exported} to {outDir}";
            if (skipped > 0) summary += $" (skipped {skipped})";
            if (rejected > 0) summary += $" (strictly rejected {rejected}; see *.diagnostics.json)";
            Debug.Log("[Quarks Exporter] " + summary);
            if (!Application.isBatchMode) EditorUtility.DisplayDialog("Quarks Exporter", summary, "OK");
            ParticleConverter.DisableTrajectoryBake = false;
            if (Application.isBatchMode) EditorApplication.Exit(rejected == 0 ? 0 : 1);
        }

        private static bool IsBatchExcludedAssetPath(string path)
        {
            string p = path.ToLowerInvariant();
            if (p.StartsWith("assets/quarksexporter/")) return true;
            if (p.Contains("/editor/") || p.Contains("/demo/") || p.Contains("/demos/")) return true;
            if (p.Contains("/sample/") || p.Contains("/samples/") || p.Contains("/example/") || p.Contains("/examples/")) return true;
            if (p.Contains("/test/") || p.Contains("/tests/")) return true;
            return false;
        }

        private static bool IsAutoExportTooLarge(GameObject prefab, out string reason)
        {
            long particleBudget = 0;
            float horizon = 0f;
            foreach (ParticleSystem ps in prefab.GetComponentsInChildren<ParticleSystem>(true))
            {
                var main = ps.main;
                particleBudget += Mathf.Max(1, main.maxParticles);
                horizon = Mathf.Max(horizon, main.duration + main.startDelay.constantMax + main.startLifetime.constantMax);
            }
            // Keep broad discovery bounded. Focused Export Folder remains available for an
            // artist who explicitly wants an unusually dense effect.
            if (particleBudget > 12000 || particleBudget * Mathf.Max(1f, horizon) > 90000f)
            {
                reason = $"semantic sampling budget={particleBudget} horizon={horizon:0.##} (use focused Export Folder)";
                return true;
            }
            reason = null;
            return false;
        }

        private static string SanitizeId(string name)
        {
            var sb = new System.Text.StringBuilder(name.Length);
            foreach (char c in name.ToLowerInvariant())
            {
                if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) sb.Append(c);
                else if (c == ' ' || c == '-' || c == '_') sb.Append('_');
            }
            string s = sb.ToString().Trim('_');
            while (s.Contains("__")) s = s.Replace("__", "_");
            return string.IsNullOrEmpty(s) ? "effect" : s;
        }

        private static List<string> FindPrefabAssetPaths(string assetFolder)
        {
            var result = new List<string>();
            string relative = assetFolder.StartsWith("Assets/") ? assetFolder.Substring(7) : "";
            string physical = Path.Combine(Application.dataPath, relative);
            if (!Directory.Exists(physical)) return result;
            foreach (string file in Directory.GetFiles(physical, "*.prefab", SearchOption.AllDirectories))
            {
                string normalized = file.Replace('\\', '/');
                string assets = Application.dataPath.Replace('\\', '/');
                if (normalized.StartsWith(assets + "/"))
                    result.Add("Assets/" + normalized.Substring(assets.Length + 1));
            }
            result.Sort();
            return result;
        }

        private static void WriteQuarksManifest(string path, List<(string id, string label, string file, string note)> effects)
        {
            var sb = new System.Text.StringBuilder();
            sb.Append("{\n  \"effects\": [\n");
            for (int i = 0; i < effects.Count; i++)
            {
                var e = effects[i];
                sb.Append("    {\n");
                sb.Append("      \"id\": ").Append(JsonString(e.id)).Append(",\n");
                sb.Append("      \"label\": ").Append(JsonString(e.label)).Append(",\n");
                sb.Append("      \"file\": ").Append(JsonString(e.file)).Append(",\n");
                sb.Append("      \"note\": ").Append(JsonString(e.note)).Append("\n");
                sb.Append("    }");
                if (i < effects.Count - 1) sb.Append(',');
                sb.Append('\n');
            }
            sb.Append("  ]\n}\n");
            File.WriteAllText(path, sb.ToString());
        }

        private static string JsonString(string s)
        {
            if (s == null) return "\"\"";
            return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }

        private static void AssignUuids(Transform t, ExportContext ctx)
        {
            ctx.AssignNodeUuid(t);
            foreach (Transform child in t)
            {
                AssignUuids(child, ctx);
            }
        }

        private static JObject SerializeNode(Transform t, ExportContext ctx)
        {
            var node = new JObject()
                .Set("uuid", ctx.GetTransformUuid(t))
                .Set("name", t.name)
                .Set("layers", 1)
                .Set("matrix", LocalMatrix(t));

            var ps = t.GetComponent<ParticleSystem>();
            if (ps != null)
            {
                var renderer = t.GetComponent<ParticleSystemRenderer>();
                node.Set("type", "ParticleEmitter").Set("ps", ParticleConverter.BuildPs(ps, renderer, ctx));
            }
            else
            {
                node.Set("type", "Group");
            }

            var children = new JArray();
            foreach (Transform child in t)
            {
                children.Add(SerializeNode(child, ctx));
            }
            if (ps != null)
            {
                var renderer = t.GetComponent<ParticleSystemRenderer>();
                if (ps.trails.enabled && renderer != null && renderer.sharedMaterial != null
                    && renderer.trailMaterial != null)
                {
                    string trailUuid = ctx.GetTransformUuid(t) + "-trail";
                    JObject trailPs = ParticleConverter.BuildPs(ps, renderer, ctx, true);
                    trailPs.Set("semanticId", trailUuid).Set("onlyUsedByOther", false);
                    children.Add(new JObject()
                        .Set("uuid", trailUuid)
                        .Set("name", t.name + " (trail renderer)")
                        .Set("layers", 1)
                        .Set("matrix", IdentityMatrix())
                        .Set("type", "ParticleEmitter")
                        .Set("ps", trailPs));
                }
            }
            if (children.Items.Count > 0)
            {
                node.Set("children", children);
            }
            return node;
        }

        private static JArray IdentityMatrix() => new JArray()
            .Add(1).Add(0).Add(0).Add(0)
            .Add(0).Add(1).Add(0).Add(0)
            .Add(0).Add(0).Add(1).Add(0)
            .Add(0).Add(0).Add(0).Add(1);

        /// <summary>Local TRS as a three.js/Babylon column-major 16-float matrix.</summary>
        private static JArray LocalMatrix(Transform t)
        {
            Matrix4x4 m = Matrix4x4.TRS(t.localPosition, t.localRotation, t.localScale);
            var arr = new JArray();
            float[] sign = { 1, 1, -1, 1 };
            for (int col = 0; col < 4; col++)
            {
                for (int row = 0; row < 4; row++)
                {
                    arr.Add(m[row, col] * sign[row] * sign[col]);
                }
            }
            return arr;
        }
    }
}
