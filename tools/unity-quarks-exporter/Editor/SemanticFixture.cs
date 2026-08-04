using System.IO;
using UnityEditor;
using UnityEngine;

namespace BabylonQuarks.UnityExporter
{
    /// <summary>Minimal accepted fixture proving the strict IR/runtime/regression happy path.</summary>
    public static class SemanticFixture
    {
        public static void ExportSemanticFixtureToWeb()
        {
            string projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, "..", ".."));
            if (!Directory.Exists(Path.Combine(projectRoot, "public")))
                projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
            string outDir = Path.Combine(projectRoot, "public", "assets", "quarks");
            Directory.CreateDirectory(outDir);

            GameObject root = new GameObject("Semantic Fixture");
            try
            {
                ParticleSystem ps = root.AddComponent<ParticleSystem>();
                var main = ps.main;
                main.loop = false;
                main.duration = 0.5f;
                main.startLifetime = 0.35f;
                main.startSpeed = 1.5f;
                main.startSize = 0.18f;
                main.startColor = new Color(1f, 0.35f, 0.08f, 0.8f);
                ps.useAutoRandomSeed = false;
                ps.randomSeed = 424242;

                var emission = ps.emission;
                emission.rateOverTime = 0f;
                emission.SetBursts(new[] { new ParticleSystem.Burst(0f, 8) });
                var shape = ps.shape;
                shape.shapeType = ParticleSystemShapeType.Circle;
                shape.radius = 0.4f;
                shape.radiusThickness = 1f;

                ParticleSystemRenderer renderer = root.GetComponent<ParticleSystemRenderer>();
                Shader shader = Shader.Find("Universal Render Pipeline/Particles/Unlit")
                    ?? Shader.Find("Particles/Standard Unlit")
                    ?? Shader.Find("Unlit/Color");
                if (shader == null) throw new System.InvalidOperationException("No unlit particle shader is available.");
                renderer.sharedMaterial = new Material(shader) { name = "Semantic Fixture Material" };

                string fixturePath = Path.Combine(outDir, "Semantic Fixture.json");
                QuarksExporter.ExportToFile(root, fixturePath);
                File.WriteAllText(fixturePath + ".fixture", "semantic compiler conformance fixture\n");
            }
            finally
            {
                Object.DestroyImmediate(root);
            }
            if (Application.isBatchMode) EditorApplication.Exit(0);
        }
    }
}
