using UnityEngine;

namespace BabylonQuarks.UnityExporter
{
    /// <summary>
    /// Resolves the effective material program after shader-family recognition. Raw Unity
    /// properties are inputs; this is the one place that decides whether they are meaningful.
    /// </summary>
    public static class MaterialProgramSemantics
    {
        public static string ResolveBlend(MaterialShaderFamily family, int detectedBlend, int unityMode)
        {
            if (family.LegacyPremultiply) return "premultiplied-alpha";
            if (detectedBlend == 1) return "additive";
            if (detectedBlend == 4) return "multiply";
            if (!family.LegacyParticle && unityMode == 0) return "opaque";
            if (!family.LegacyParticle && unityMode == 1) return "alpha-test";
            return "alpha";
        }

        public static bool ResolveDepthWrite(MaterialShaderFamily family, Material material,
            string blend, bool fallback)
        {
            if (family.LegacyParticle) return false;
            return MaterialPropertyReader.ReadBool(material, "_ZWrite",
                blend == "opaque" || blend == "alpha-test" || fallback);
        }
    }
}
