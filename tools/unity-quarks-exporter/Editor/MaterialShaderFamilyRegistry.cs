using System;

namespace BabylonQuarks.UnityExporter
{
    /// <summary>
    /// Stable source identity classification for material compilers.
    ///
    /// This registry owns recognition only. It does not decide coverage or
    /// generate IR; those operations remain in the reviewed compiler until
    /// each family is extracted behind IMaterialProgramCompiler.
    /// </summary>
    public sealed class MaterialShaderFamily
    {
        public bool LegacyParticle;
        public bool Alpha8Additive;
        public bool MultiplyColored;
        public bool LegacyMultiply;
        public bool LegacyPremultiply;
        public bool LegacyDoubleTint;
        public bool VefectsZap;
        public bool VefectsExtraParticles;
        public bool VefectsErosionParticles;
        public bool VefectsHeatHaze;
        public bool EricAdditiveFlow;
        public bool EricAlphaFlow;
        public bool EgaFireSphere;
    }

    public static class MaterialShaderFamilyRegistry
    {
        public static MaterialShaderFamily Resolve(string shaderName)
        {
            string s = shaderName ?? string.Empty;
            return new MaterialShaderFamily
            {
                LegacyParticle = IsLegacyParticle(s),
                Alpha8Additive = s == "Cartoon FX/Legacy/Particles Additive Alpha8",
                MultiplyColored = s == "Cartoon FX/Legacy/Particle Multiply Colored",
                LegacyMultiply = s == "Legacy Shaders/Particles/Multiply",
                LegacyPremultiply = s == "Legacy Shaders/Particles/Alpha Blended Premultiply",
                LegacyDoubleTint = s == "Legacy Shaders/Particles/Additive"
                    || s == "Legacy Shaders/Particles/Additive (Soft)"
                    || s == "Legacy Shaders/Particles/Alpha Blended",
                VefectsZap = s == "/_Vefects_/SH_Vefects_Zap_URP",
                VefectsExtraParticles = s == "/_Vefects_/SH_Vefects_Extra_Particles_URP",
                VefectsErosionParticles = s == "SH_Vefects_VFX_URP_Particles_Erosion_01",
                VefectsHeatHaze = s == "SH_Vefects_VFX_URP_Heat_Haze_01",
                EricAdditiveFlow = s == "Eric/URP_AdditiveFlow_HDR",
                EricAlphaFlow = s == "Eric/URP_AlphaBlendFlow_HDR",
                EgaFireSphere = s == "EGA/Particles/FireSphere",
            };
        }

        public static bool IsLegacyParticle(string shaderName)
        {
            switch (shaderName ?? string.Empty)
            {
                case "Legacy Shaders/Particles/Additive":
                case "Legacy Shaders/Particles/Additive (Soft)":
                case "Legacy Shaders/Particles/Alpha Blended":
                case "Particles/Additive":
                case "Particles/Alpha Blended":
                case "Mobile/Particles/Additive":
                case "Mobile/Particles/Alpha Blended":
                case "Cartoon FX/Legacy/Particles Additive Alpha8":
                case "Cartoon FX/Legacy/Particle Multiply Colored":
                case "Legacy Shaders/Particles/Multiply":
                case "Legacy Shaders/Particles/Alpha Blended Premultiply":
                    return true;
                default:
                    return false;
            }
        }

        public static bool IsReviewedBuiltin(string shaderName)
        {
            string s = shaderName ?? string.Empty;
            return s == "Particles/Standard Unlit"
                || s == "Particles/Standard Surface"
                || s == "Mobile/Particles/Alpha Blended"
                || s == "Mobile/Particles/Additive"
                || s == "Universal Render Pipeline/Particles/Unlit"
                || s == "Universal Render Pipeline/Particles/Lit"
                || s.StartsWith("ERB/Particles/", StringComparison.Ordinal)
                || s.StartsWith("EGA/Particles/", StringComparison.Ordinal)
                || s.StartsWith("Eric/URP_", StringComparison.Ordinal)
                || s.StartsWith("SH_Vefects_", StringComparison.Ordinal)
                || s.StartsWith("/_Vefects_/", StringComparison.Ordinal)
                || s.StartsWith("Effect/Effect ", StringComparison.Ordinal)
                || s == "Effect/distortion_mask"
                || s == "Standard"
                || s.StartsWith("VFX/Particles/", StringComparison.Ordinal)
                || s.StartsWith("Hovl/Particles/", StringComparison.Ordinal);
        }
    }
}
