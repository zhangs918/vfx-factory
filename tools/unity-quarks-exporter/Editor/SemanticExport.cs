using System;
using System.Collections.Generic;
using UnityEngine;

namespace BabylonQuarks.UnityExporter
{
    public enum ExportSeverity { Info, Warning, Error }

    /// <summary>
    /// Machine-readable diagnostics for the strict Unity -> Web semantic compiler.
    /// Unsupported authoring is never silently approximated: an Error prevents the
    /// effect JSON from being emitted; warnings describe exact, non-lossy caveats.
    /// </summary>
    public sealed class ExportDiagnostic
    {
        public readonly ExportSeverity Severity;
        public readonly string Code;
        public readonly string Path;
        public readonly string Message;

        public ExportDiagnostic(ExportSeverity severity, string code, string path, string message)
        {
            Severity = severity;
            Code = code;
            Path = path ?? "";
            Message = message ?? "";
        }

        private string Domain => Code.StartsWith("SHADERGRAPH_") || Code.StartsWith("MATERIAL_")
            ? "material"
            : Code == "PS_COLLISION_UNSUPPORTED" || Code == "PS_TRIGGER_UNSUPPORTED"
                || Code == "PS_EXTERNAL_FORCES_UNSUPPORTED"
                ? "scene-integration"
                : "particle-simulation";

        private string RequiredAction
        {
            get
            {
                if (Code == "SHADERGRAPH_PROGRAM_UNSUPPORTED")
                {
                    bool viewDependent = Message.Contains("SceneColorNode")
                        || Message.Contains("SceneDepthNode")
                        || Message.Contains("ScreenPositionNode")
                        || Message.Contains("IsFrontFaceNode")
                        || Message.Contains("ParallaxOcclusionMappingNode");
                    return viewDependent
                        ? "implement-live-view-or-scene-input; material-bake-forbidden"
                        : "lower-expression-or-bake-view-independent-material-function";
                }
                if (Code == "PS_COLLISION_UNSUPPORTED" || Code == "PS_TRIGGER_UNSUPPORTED"
                    || Code == "PS_EXTERNAL_FORCES_UNSUPPORTED")
                    return "define-portable-scene-query-contract";
                if (Code == "PS_NOISE_UNSUPPORTED") return "implement-unity-noise-solver";
                return "extend-versioned-live-ir";
            }
        }

        public JObject ToJson() => new JObject()
            .Set("severity", Severity.ToString().ToLowerInvariant())
            .Set("code", Code)
            .Set("domain", Domain)
            .Set("path", Path)
            .Set("message", Message)
            .Set("productionDisposition", Severity == ExportSeverity.Error
                ? "reject"
                : RequiresOracle ? "candidate" : "allow")
            .Set("requiresOracle", RequiresOracle)
            .Set("requiredAction", RequiredAction)
            .Set("oracleEligible", true);

        public bool RequiresOracle => Severity == ExportSeverity.Warning
            && (Code == "PS_NOISE_MANUAL_LOWERING"
                || Code == "PS_NOISE_TRAJECTORY_CACHE"
                || Code == "PS_VELOCITY_ORBITAL_TRAJECTORY_CACHE"
                || Code == "PS_COLLISION_SCENE_QUERY"
                || Code == "PS_STOCHASTIC_STATE_CACHE"
                || Code == "PS_TRAIL_ONLY_RENDERER"
                || Code == "PS_TRAIL_SECONDARY_RENDERER"
                || Code == "SHADERGRAPH_MANUAL_LOWERING"
                || Code == "CONTROLLER_SLASH_DECAL_ADAPTER"
                || Code == "CONTROLLER_PROJECTILE_HOST_EVENT");
    }

    public sealed class SemanticExportException : Exception
    {
        public readonly IReadOnlyList<ExportDiagnostic> Diagnostics;

        public SemanticExportException(string effectName, IReadOnlyList<ExportDiagnostic> diagnostics)
            : base($"Strict semantic export failed for '{effectName}'. See diagnostics for unsupported Unity semantics.")
        {
            Diagnostics = diagnostics;
        }
    }

    public static class SemanticValidator
    {
        public const string Schema = "unity-vfx-ir@1";
        public const string Runtime = "three-quarks-semantic@1";

        public static void ValidateHierarchy(GameObject root, ExportContext ctx)
        {
            ControllerSemanticCompiler.Validate(root, ctx);
            foreach (ParticleSystem ps in root.GetComponentsInChildren<ParticleSystem>(true))
                ValidateParticleSystem(ps, ctx);
        }

        private static void ValidateParticleSystem(ParticleSystem ps, ExportContext ctx)
        {
            string path = HierarchyPath(ps.transform);
            var main = ps.main;
            if (main.simulationSpace == ParticleSystemSimulationSpace.Custom)
                ctx.Error("PS_CUSTOM_SIMULATION_SPACE", path, "Custom simulation space has no portable Quarks equivalent.");
            RejectTwoCurves(main.startDelay, path, "main.startDelay", ctx);
            RejectTwoCurves(main.startLifetime, path, "main.startLifetime", ctx);
            RejectTwoCurves(main.startSpeed, path, "main.startSpeed", ctx);
            RejectTwoCurves(main.gravityModifier, path, "main.gravityModifier", ctx);
            if (main.startSize3D)
            {
                RejectTwoCurves(main.startSizeX, path, "main.startSizeX", ctx);
                RejectTwoCurves(main.startSizeY, path, "main.startSizeY", ctx);
                RejectTwoCurves(main.startSizeZ, path, "main.startSizeZ", ctx);
            }
            // Scalar startSize TwoCurves is represented by UnityTwoCurves@1 and sampled once
            // per particle by the runtime generator. Separate-axis support remains strict below.
            else if (main.startSize.mode != ParticleSystemCurveMode.TwoCurves)
                RejectTwoCurves(main.startSize, path, "main.startSize", ctx);
            if (main.startRotation3D)
            {
                RejectTwoCurves(main.startRotationX, path, "main.startRotationX", ctx);
                RejectTwoCurves(main.startRotationY, path, "main.startRotationY", ctx);
                RejectTwoCurves(main.startRotationZ, path, "main.startRotationZ", ctx);
            }
            else RejectTwoCurves(main.startRotation, path, "main.startRotation", ctx);
            RejectUnsupportedStartGradient(main.startColor, path, "main.startColor", ctx);

            var subEmitters = ps.subEmitters;
            if (subEmitters.enabled)
            {
                for (int i = 0; i < subEmitters.subEmittersCount; i++)
                {
                    ParticleSystemSubEmitterProperties properties = subEmitters.GetSubEmitterProperties(i);
                    if ((properties & ParticleSystemSubEmitterProperties.InheritRotation) != 0)
                        ctx.Warning("PS_SUB_EMITTER_INHERIT_ROTATION", path,
                            $"subEmitters[{i}] inherits parent rotation; lowered through the shared parent transform contract.");
                    if ((properties & ParticleSystemSubEmitterProperties.InheritLifetime) != 0)
                        ctx.Warning("PS_SUB_EMITTER_INHERIT_LIFETIME", path,
                            $"subEmitters[{i}] inherits parent lifetime; child lifetime is scaled by the owning parent particle.");
                }
            }

            var emission = ps.emission;
            if (emission.enabled)
            {
                RejectTwoCurves(emission.rateOverTime, path, "emission.rateOverTime", ctx);
                RejectTwoCurves(emission.rateOverDistance, path, "emission.rateOverDistance", ctx);
                var bursts = new ParticleSystem.Burst[emission.burstCount];
                emission.GetBursts(bursts);
                for (int i = 0; i < bursts.Length; i++)
                    RejectTwoCurves(bursts[i].count, path, $"emission.bursts[{i}].count", ctx);
            }

            var shape = ps.shape;
            if (shape.enabled && !SupportedShape(shape.shapeType))
                ctx.Error("PS_SHAPE_UNSUPPORTED", path,
                    $"Shape '{shape.shapeType}' cannot be represented by the semantic IR. Bake the emitter or add an exact shape implementation.");
            if (shape.enabled && shape.randomDirectionAmount > 1e-6f)
                ctx.Warning("PS_RANDOM_DIRECTION_CACHE", path,
                    "randomDirectionAmount is compiled into particle-trajectory-cache@6; editing it requires regeneration and oracle qualification.");

            var sizeLife = ps.sizeOverLifetime;
            if (sizeLife.enabled && sizeLife.separateAxes)
            {
                RejectTwoCurves(sizeLife.x, path, "sizeOverLifetime.x", ctx);
                RejectTwoCurves(sizeLife.y, path, "sizeOverLifetime.y", ctx);
                RejectTwoCurves(sizeLife.z, path, "sizeOverLifetime.z", ctx);
            }
            // Scalar Size over Lifetime Two Curves is represented by UnityTwoCurves@1.
            else if (sizeLife.enabled && sizeLife.size.mode != ParticleSystemCurveMode.TwoCurves)
                RejectTwoCurves(sizeLife.size, path, "sizeOverLifetime.size", ctx);

            var sizeSpeed = ps.sizeBySpeed;
            if (sizeSpeed.enabled && sizeSpeed.separateAxes)
                ctx.Error("PS_SIZE_SPEED_3D", path, "Separate-axis Size by Speed was previously collapsed to X.");
            if (sizeSpeed.enabled && !sizeSpeed.separateAxes) RejectTwoCurves(sizeSpeed.size, path, "sizeBySpeed.size", ctx);

            var limit = ps.limitVelocityOverLifetime;
            if (limit.enabled && limit.separateAxes)
            {
                if (limit.space != ParticleSystemSimulationSpace.Local)
                    ctx.Error("PS_LIMIT_VELOCITY_3D_SPACE", path,
                        "Separate-axis Limit Velocity currently requires Local module space.");
                RejectTwoCurves(limit.limitX, path, "limitVelocity.limitX", ctx);
                RejectTwoCurves(limit.limitY, path, "limitVelocity.limitY", ctx);
                RejectTwoCurves(limit.limitZ, path, "limitVelocity.limitZ", ctx);
            }
            if (limit.enabled && !limit.separateAxes) RejectTwoCurves(limit.limit, path, "limitVelocity.limit", ctx);

            var rotationLife = ps.rotationOverLifetime;
            // Separate-axis mesh rotation is represented by unityRotationOverLifetime3D and
            // integrated as a quaternion by the semantic runtime.
            if (rotationLife.enabled && !rotationLife.separateAxes) RejectTwoCurves(rotationLife.z, path, "rotationOverLifetime.z", ctx);
            bool stochasticState = (sizeLife.enabled && !sizeLife.separateAxes
                    && sizeLife.size.mode == ParticleSystemCurveMode.TwoCurves)
                || (rotationLife.enabled && rotationLife.separateAxes
                    && (rotationLife.x.mode == ParticleSystemCurveMode.TwoCurves
                        || rotationLife.y.mode == ParticleSystemCurveMode.TwoCurves
                        || rotationLife.z.mode == ParticleSystemCurveMode.TwoCurves));
            var stochasticVelocityModule = ps.velocityOverLifetime;
            stochasticState = stochasticState || (stochasticVelocityModule.enabled
                && (IsStochasticVelocityLane(stochasticVelocityModule.x)
                    || IsStochasticVelocityLane(stochasticVelocityModule.y)
                    || IsStochasticVelocityLane(stochasticVelocityModule.z)));
            if (stochasticState && !ps.noise.enabled && !ps.collision.enabled)
                ctx.Warning("PS_STOCHASTIC_STATE_CACHE", path,
                    "Stochastic size/rotation/custom-stream state is exported as particle-trajectory-cache@6; editing those modules requires regeneration and oracle qualification.");

            var rotationSpeed = ps.rotationBySpeed;
            if (rotationSpeed.enabled && rotationSpeed.separateAxes)
                ctx.Error("PS_ROTATION_SPEED_3D", path, "Separate-axis Rotation by Speed is not supported by Quarks' scalar behavior.");
            if (rotationSpeed.enabled && !rotationSpeed.separateAxes) RejectTwoCurves(rotationSpeed.z, path, "rotationBySpeed.z", ctx);

            var velocity = ps.velocityOverLifetime;
            if (velocity.enabled)
            {
                // Linear XYZ, including TwoCurves, is represented by
                // unity-velocity-over-lifetime@1. Orbital/radial fields are distinct semantics.
                if (!IsConstantZero(velocity.orbitalX) || !IsConstantZero(velocity.orbitalY)
                    || !IsConstantZero(velocity.orbitalZ) || !IsConstantZero(velocity.radial)
                    || !IsConstantOne(velocity.speedModifier))
                    ctx.Warning("PS_VELOCITY_ORBITAL_TRAJECTORY_CACHE", path,
                        "Orbital/radial/speed-modifier Velocity over Lifetime is compiled into particle-trajectory-cache@6; editing those lanes requires regeneration and oracle qualification.");
            }
            var force = ps.forceOverLifetime;
            if (force.enabled)
            {
                ctx.Warning("PS_FORCE_TRAJECTORY_CACHE", path,
                    "Force over Lifetime space and stochastic lanes are compiled into particle-trajectory-cache@6; editing force requires regeneration and oracle qualification.");
            }
            var gravity = ps.main.gravityModifier;
            if (gravity.mode != ParticleSystemCurveMode.Constant
                || Mathf.Abs(gravity.constant) > 1e-6f)
                ctx.Warning("PS_GRAVITY_TRAJECTORY_CACHE", path,
                    "Gravity modifier is compiled into particle-trajectory-cache@6 to preserve Unity fixed-step world-space integration; editing gravity requires regeneration and oracle qualification.");
            var inherit = ps.inheritVelocity;
            if (inherit.enabled) RejectTwoCurves(inherit.curve, path, "inheritVelocity.curve", ctx);

            ValidateLifetimeGradient(ps.colorOverLifetime.enabled ? ps.colorOverLifetime.color : default,
                ps.colorOverLifetime.enabled, path, "colorOverLifetime.color", ctx);
            ValidateLifetimeGradient(ps.colorBySpeed.enabled ? ps.colorBySpeed.color : default,
                ps.colorBySpeed.enabled, path, "colorBySpeed.color", ctx);

            if (ps.noise.enabled)
            {
                var noise = ps.noise;
                ctx.Warning("PS_NOISE_TRAJECTORY_CACHE", path,
                    $"Unity Noise (separateAxes={noise.separateAxes}, octaveCount={noise.octaveCount}) is exported as particle-trajectory-cache@6; material/camera remain live, but simulation edits require regeneration and oracle qualification.");
            }
            if (ps.collision.enabled)
            {
                var collision = ps.collision;
                bool emptyPlaneSet = collision.type == ParticleSystemCollisionType.Planes
                    && !HasAssignedCollisionPlane(collision);
                bool supportedPlane = collision.type == ParticleSystemCollisionType.World
                    && collision.mode == ParticleSystemCollisionMode.Collision3D;
                if (emptyPlaneSet)
                    ctx.Warning("PS_COLLISION_EMPTY_PLANE_SET", path,
                        "Collision uses Planes mode but has no assigned plane transforms; it is lowered to an exact no-op.");
                else if (!supportedPlane)
                    ctx.Error("PS_COLLISION_UNSUPPORTED", path,
                        $"Collision type={collision.type}, mode={collision.mode} is outside particle-scene-query@1.");
                else
                    ctx.Warning("PS_COLLISION_SCENE_QUERY", path,
                        "Collision particle state is exported into particle-trajectory-cache@6 with explicit terminal edges for the reference scene; changing colliders requires regeneration and oracle qualification.");
            }

            ValidateCustomData(ps, path, ctx);

            var tsa = ps.textureSheetAnimation;
            if (tsa.enabled)
            {
                if (tsa.mode != ParticleSystemAnimationMode.Grid)
                    ctx.Error("PS_FLIPBOOK_SPRITES", path, "Sprite-list Texture Sheet Animation requires baking.");
                // SingleRow means “animate across X, with one row selected per particle”.
                // It is no longer collapsed to a whole-sheet cycle: the IR carries the row
                // policy explicitly (fixed row or a spawn-time random row).
                if (tsa.animation != ParticleSystemAnimationType.WholeSheet
                    && tsa.animation != ParticleSystemAnimationType.SingleRow)
                    ctx.Error("PS_FLIPBOOK_SINGLE_ROW", path, "Texture Sheet Animation mode is not represented by the current IR.");
                if (tsa.timeMode != ParticleSystemAnimationTimeMode.Lifetime
                    && tsa.timeMode != ParticleSystemAnimationTimeMode.Speed)
                    ctx.Error("PS_FLIPBOOK_TIME_MODE", path, $"Texture Sheet time mode '{tsa.timeMode}' requires an exact runtime implementation.");
            }

            if (ps.trails.enabled)
            {
                var trails = ps.trails;
                var trailRenderer = ps.GetComponent<ParticleSystemRenderer>();
                bool trailOnly = trailRenderer != null && trailRenderer.sharedMaterial == null
                    && trailRenderer.trailMaterial != null;
                if (trails.mode != ParticleSystemTrailMode.PerParticle)
                    ctx.Warning("PS_TRAIL_RIBBON_CACHE", path,
                        "Ribbon mode is preserved through the baked indexed trail geometry cache; live ribbon editing requires regeneration.");
                else if (trails.ratio < 0.999999f)
                    ctx.Warning("PS_TRAIL_RATIO_CACHE", path,
                        "Trail ratio below one is preserved by the baked geometry cache; changing ratio requires regeneration.");
                else if (trails.textureMode != ParticleSystemTrailTextureMode.Stretch)
                    ctx.Warning("PS_TRAIL_TEXTURE_MODE_FALLBACK", path,
                        $"Trail texture mode '{trails.textureMode}' uses the baked geometry/stretch UV fallback; material edits remain live.");
                else if (trails.worldSpace && ps.main.simulationSpace == ParticleSystemSimulationSpace.Local)
                    ctx.Warning("PS_TRAIL_WORLDSPACE_CACHE", path,
                        "World-space trail points are compiled into an explicit world-space geometry cache and transformed at runtime.");
                else if (trailOnly)
                    ctx.Warning("PS_TRAIL_ONLY_RENDERER", path,
                        "Material-less primary particles are compiled through unity-trail-semantics@2 with second-based lifetime and distance-based vertex sampling.");
                else
                    ctx.Warning("PS_TRAIL_SECONDARY_RENDERER", path,
                        "Primary particles and trails are compiled into synchronized live primary and synthetic trail renderers.");
            }
            if (ps.trigger.enabled)
                ctx.Error("PS_TRIGGER_UNSUPPORTED", path, "Trigger module depends on scene colliders and cannot be embedded in the effect IR.");
            if (ps.externalForces.enabled)
                ctx.Error("PS_EXTERNAL_FORCES_UNSUPPORTED", path, "External Forces depend on scene Force Fields and cannot be embedded in the effect IR.");

            var renderer = ps.GetComponent<ParticleSystemRenderer>();
            if (renderer == null)
                ctx.Error("PS_RENDERER_MISSING", path, "ParticleSystem has no ParticleSystemRenderer.");
            else if (renderer.renderMode == ParticleSystemRenderMode.Mesh && renderer.meshCount > 1)
                ctx.Error("PS_MULTIPLE_MESHES", path, "Random selection between multiple renderer meshes is not represented by the current IR.");
            if (renderer != null)
            {
                Vector3 flip = renderer.flip;
                if (!Binary(flip.x) || !Binary(flip.y))
                    ctx.Warning("PS_RANDOM_UV_FLIP_CAPTURED", path,
                        "Fractional renderer UV flip is captured per particle and transported by unity-renderer-uv-flip@1.");
                if (flip.z > 0.5f)
                    ctx.Error("PS_UV_FLIP_Z_UNSUPPORTED", path, "Renderer flip.z has no WebGL particle equivalent.");
                if (renderer.renderMode == ParticleSystemRenderMode.Stretch)
                    ctx.Warning("PS_STRETCH_EXACT_VERTEX_LOWERING", path,
                        "Stretched billboard uses the exact Unity length equation with current per-particle size and velocity.");
                if (renderer.renderMode == ParticleSystemRenderMode.Billboard
                    && renderer.alignment == ParticleSystemRenderSpace.Local)
                    ctx.Warning("PS_LOCAL_BILLBOARD_LOWERING", path,
                        "Local-aligned billboard is lowered to a live instanced XY quad so the emitter hierarchy owns its basis.");
                else if (renderer.renderMode == ParticleSystemRenderMode.Billboard
                    && renderer.alignment != ParticleSystemRenderSpace.View)
                    ctx.Warning("PS_RENDER_ALIGNMENT_FALLBACK", path,
                        $"Billboard alignment '{renderer.alignment}' uses the reviewed camera-facing billboard fallback; emitter-local basis is retained where supported.");
            }
            if (renderer != null)
            {
                bool trailOnlyMaterial = ps.trails.enabled && renderer.sharedMaterial == null
                    && renderer.trailMaterial != null;
                Material originalMaterial = renderer.sharedMaterial;
                if (trailOnlyMaterial) renderer.sharedMaterial = renderer.trailMaterial;
                try { ctx.ValidateMaterialForRenderer(renderer); }
                finally { if (trailOnlyMaterial) renderer.sharedMaterial = originalMaterial; }
            }
        }

        private static void RejectTwoCurves(ParticleSystem.MinMaxCurve curve, string path, string field, ExportContext ctx)
        {
            if (curve.mode == ParticleSystemCurveMode.TwoCurves
                && !ValueConverter.CurvesEquivalent(curve.curveMin, curve.curveMax))
                ctx.Warning("PS_TWO_CURVES_TRAJECTORY_CACHE", path,
                    $"{field} uses Two Curves ({DescribeCurve(curve)}); the authored min/max lane is preserved by particle-trajectory-cache@6.");
        }

        private static bool IsStochasticVelocityLane(ParticleSystem.MinMaxCurve curve) =>
            curve.mode == ParticleSystemCurveMode.TwoConstants
            || curve.mode == ParticleSystemCurveMode.TwoCurves;

        private static string DescribeCurve(ParticleSystem.MinMaxCurve curve)
        {
            int minKeys = curve.curveMin != null ? curve.curveMin.length : 0;
            int maxKeys = curve.curveMax != null ? curve.curveMax.length : 0;
            return $"mode={curve.mode}, multiplier={curve.curveMultiplier}, constants=[{curve.constantMin},{curve.constantMax}], keys=[{minKeys},{maxKeys}]";
        }

        private static void RejectUnsupportedStartGradient(ParticleSystem.MinMaxGradient gradient, string path, string field, ExportContext ctx)
        {
            if (gradient.mode == ParticleSystemGradientMode.RandomColor)
                ctx.Warning("PS_RANDOM_GRADIENT_CACHE", path,
                    $"{field} uses Random Color; fixed-seed spawn/trajectory state preserves the authored random lane.");
        }

        private static void ValidateLifetimeGradient(ParticleSystem.MinMaxGradient gradient, bool enabled, string path, string field, ExportContext ctx)
        {
            if (!enabled) return;
            if (gradient.mode == ParticleSystemGradientMode.TwoColors
                || gradient.mode == ParticleSystemGradientMode.TwoGradients
                || gradient.mode == ParticleSystemGradientMode.RandomColor)
                ctx.Warning("PS_LIFETIME_GRADIENT_CACHE", path,
                    $"{field} mode '{gradient.mode}' is compiled into particle-trajectory-cache@6; editing it requires regeneration and oracle qualification.");
        }

        private static void ValidateCustomData(ParticleSystem ps, string path, ExportContext ctx)
        {
            var custom = ps.customData;
            if (!custom.enabled) return;
            if (custom.GetMode(ParticleSystemCustomData.Custom2) != ParticleSystemCustomDataMode.Disabled)
                ctx.Warning("PS_CUSTOM2_TRAJECTORY_STREAM", path,
                    "Custom2 is exported as an explicit particle-trajectory-cache@6 vec4 attribute and bound by reviewed material lowerings.");
            if (custom.GetMode(ParticleSystemCustomData.Custom1) != ParticleSystemCustomDataMode.Vector) return;
            for (int component = 0; component < 4; component++)
            {
                ParticleSystem.MinMaxCurve curve = custom.GetVector(ParticleSystemCustomData.Custom1, component);
                if (curve.mode == ParticleSystemCurveMode.TwoCurves)
                    ctx.Warning("PS_CUSTOM1_TWO_CURVES_CACHE", path,
                        $"customData.custom1[{component}] TwoCurves is compiled into particle-trajectory-cache@6.");
            }
        }

        private static bool IsConstantZero(ParticleSystem.MinMaxCurve curve) =>
            curve.mode == ParticleSystemCurveMode.Constant && Mathf.Abs(curve.constant) < 1e-6f;

        private static bool IsConstantOne(ParticleSystem.MinMaxCurve curve) =>
            curve.mode == ParticleSystemCurveMode.Constant && Mathf.Abs(curve.constant - 1f) < 1e-6f;

        private static bool Binary(float value) => Mathf.Abs(value) < 1e-6f || Mathf.Abs(value - 1f) < 1e-6f;

        private static bool HasAssignedCollisionPlane(ParticleSystem.CollisionModule collision)
        {
            // Unity ParticleSystem supports at most six authored collision planes.
            for (int i = 0; i < 6; i++)
                if (collision.GetPlane(i) != null) return true;
            return false;
        }

        private static bool SupportedShape(ParticleSystemShapeType type)
        {
            switch (type)
            {
                case ParticleSystemShapeType.Cone:
                case ParticleSystemShapeType.ConeVolume:
                case ParticleSystemShapeType.Box:
                case ParticleSystemShapeType.Sphere:
                case ParticleSystemShapeType.Hemisphere:
                case ParticleSystemShapeType.Circle:
                case ParticleSystemShapeType.Donut:
                case ParticleSystemShapeType.Mesh:
                    return true;
                default:
                    return false;
            }
        }

        public static string HierarchyPath(Transform t)
        {
            var names = new List<string>();
            for (Transform p = t; p != null; p = p.parent) names.Add(p.name);
            names.Reverse();
            return string.Join("/", names);
        }

        public static JObject BuildContract(GameObject root, ExportContext ctx)
        {
            uint seed = 1;
            foreach (ParticleSystem ps in root.GetComponentsInChildren<ParticleSystem>(true))
            {
                if (ps.randomSeed != 0) { seed = ps.randomSeed; break; }
            }
            bool requiresOracle = false;
            bool trajectoryAdapterAdded = false;
            bool trailAdapterAdded = false;
            bool controllerAdapterAdded = false;
            bool hasUnityVolumeShape = false;
            bool hasUnityTwoCurves = false;
            bool hasLimitVelocity3D = false;
            bool hasLimitVelocity = false;
            bool hasVelocityOverLifetime = false;
            bool hasRendererUvFlip = false;
            bool hasStrictSizeOverLifetime = false;
            var simulationAdapters = new JArray();
            // Previewing a prefab is a one-shot instance, even when an individual Unity
            // particle system has main.loop enabled. That local flag only describes emission
            // after its parent event activates it; it must not restart the whole prefab forever.
            simulationAdapters.Add(new JObject()
                .Set("id", "unity-effect-lifecycle")
                .Set("version", 1)
                .Set("kind", "simulation")
                .Set("fidelity", "one-shot-root-instance-with-conservative-natural-terminal-time")
                .Set("requiresOracle", true));
            simulationAdapters.Add(new JObject()
                .Set("id", "calibrated-spawn-schedule")
                .Set("version", 1)
                .Set("kind", "simulation")
                .Set("fidelity", "deterministic-camera-independent-spawn")
                .Set("requiresOracle", true));
            bool hasMeshRenderer = false;
            bool hasLocalBillboard = false;
            bool hasLoopingSubEmitter = false;
            bool hasSubEmitterInheritance = false;
            foreach (ParticleSystemRenderer renderer in
                root.GetComponentsInChildren<ParticleSystemRenderer>(true))
            {
                if (renderer.renderMode == ParticleSystemRenderMode.Mesh)
                {
                    hasMeshRenderer = true;
                    if (renderer.mesh == null)
                        ctx.Warning("PS_MESH_REFERENCE_FALLBACK", SemanticValidator.HierarchyPath(renderer.transform),
                            "Mesh render mode has no serialized mesh reference; exporter uses an explicit unit-quad geometry fallback.");
                }
                if (renderer.renderMode == ParticleSystemRenderMode.Billboard
                    && renderer.alignment == ParticleSystemRenderSpace.Local)
                    hasLocalBillboard = true;
                Vector3 rendererFlip = renderer.flip;
                if (!Binary(rendererFlip.x) || !Binary(rendererFlip.y))
                    hasRendererUvFlip = true;
            }
            foreach (ParticleSystem ps in root.GetComponentsInChildren<ParticleSystem>(true))
            {
                var sizeLife = ps.sizeOverLifetime;
                if (sizeLife.enabled && !sizeLife.separateAxes
                    && sizeLife.size.mode == ParticleSystemCurveMode.Curve)
                    hasStrictSizeOverLifetime = true;
                if (ctx.IsSubTarget(ps) && ps.main.loop)
                {
                    hasLoopingSubEmitter = true;
                }
            }
            foreach (ParticleSystem ps in root.GetComponentsInChildren<ParticleSystem>(true))
                if (ps.subEmitters.enabled && ps.subEmitters.subEmittersCount > 0)
                {
                    hasSubEmitterInheritance = true;
                    break;
                }
            foreach (ParticleSystem ps in root.GetComponentsInChildren<ParticleSystem>(true))
            {
                var shape = ps.shape;
                if (shape.enabled && (shape.shapeType == ParticleSystemShapeType.Box
                    || shape.shapeType == ParticleSystemShapeType.ConeVolume))
                {
                    hasUnityVolumeShape = true;
                    break;
                }
            }
            foreach (ParticleSystem ps in root.GetComponentsInChildren<ParticleSystem>(true))
                if (ps.limitVelocityOverLifetime.enabled)
                {
                    if (ps.limitVelocityOverLifetime.separateAxes) hasLimitVelocity3D = true;
                    else hasLimitVelocity = true;
                }
            foreach (ParticleSystem ps in root.GetComponentsInChildren<ParticleSystem>(true))
                if (ps.velocityOverLifetime.enabled)
                {
                    hasVelocityOverLifetime = true;
                    break;
                }
            foreach (ParticleSystem ps in root.GetComponentsInChildren<ParticleSystem>(true))
            {
                var main = ps.main;
                var sizeLife = ps.sizeOverLifetime;
                var rotationLife = ps.rotationOverLifetime;
                if ((!main.startSize3D && main.startSize.mode == ParticleSystemCurveMode.TwoCurves)
                    || (sizeLife.enabled && !sizeLife.separateAxes
                        && sizeLife.size.mode == ParticleSystemCurveMode.TwoCurves)
                    || (rotationLife.enabled && rotationLife.separateAxes
                        && (rotationLife.x.mode == ParticleSystemCurveMode.TwoCurves
                            || rotationLife.y.mode == ParticleSystemCurveMode.TwoCurves
                            || rotationLife.z.mode == ParticleSystemCurveMode.TwoCurves)))
                {
                    hasUnityTwoCurves = true;
                    break;
                }
            }
            if (hasUnityVolumeShape)
                simulationAdapters.Add(new JObject()
                    .Set("id", "unity-volume-emitter-shapes")
                    .Set("version", 1)
                    .Set("kind", "simulation")
                    .Set("fidelity", "live-box-volume-and-cone-volume-spawn-domain")
                    .Set("requiresOracle", true));
            if (hasUnityTwoCurves)
                simulationAdapters.Add(new JObject()
                    .Set("id", "unity-two-curves")
                    .Set("version", 1)
                    .Set("kind", "simulation")
                    .Set("fidelity", "sample-once-random-lane-between-live-hermite-curves")
                    .Set("requiresOracle", true));
            if (hasLimitVelocity3D)
                simulationAdapters.Add(new JObject()
                    .Set("id", "unity-limit-velocity-3d")
                    .Set("version", 1)
                    .Set("kind", "simulation")
                    .Set("fidelity", "live-separate-axis-clamp-with-authored-dampen")
                    .Set("requiresOracle", true));
            if (hasLimitVelocity)
                simulationAdapters.Add(new JObject()
                    .Set("id", "unity-limit-velocity")
                    .Set("version", 1)
                    .Set("kind", "simulation")
                    .Set("fidelity", "live-vector-magnitude-clamp-with-unity-30hz-normalized-dampen")
                    .Set("requiresOracle", true));
            if (hasVelocityOverLifetime)
                simulationAdapters.Add(new JObject()
                    .Set("id", "unity-velocity-over-lifetime")
                    .Set("version", 1)
                    .Set("kind", "simulation")
                    .Set("fidelity", "live-linear-xyz-velocity-offset-with-two-curves")
                    .Set("requiresOracle", true));
            if (hasMeshRenderer)
                simulationAdapters.Add(new JObject()
                    .Set("id", "unity-mesh-renderer-basis")
                    .Set("version", 1)
                    .Set("kind", "geometry")
                    .Set("fidelity", "source-mesh-reflect-z-once-renderer-pivot-before-live-current-size-trs")
                    .Set("requiresOracle", true));
            if (hasLocalBillboard)
                simulationAdapters.Add(new JObject()
                    .Set("id", "unity-renderer-alignment")
                    .Set("version", 1)
                    .Set("kind", "geometry")
                    .Set("fidelity", "local-billboard-live-instanced-quad-in-emitter-basis")
                    .Set("requiresOracle", true));
            if (hasRendererUvFlip)
                simulationAdapters.Add(new JObject()
                    .Set("id", "unity-renderer-uv-flip")
                    .Set("version", 1)
                    .Set("kind", "geometry")
                    .Set("fidelity", "renderer-baked-per-particle-atlas-cell-reflection")
                    .Set("requiresOracle", true));
            if (hasStrictSizeOverLifetime)
                simulationAdapters.Add(new JObject()
                    .Set("id", "unity-size-over-lifetime")
                    .Set("version", 1)
                    .Set("kind", "simulation")
                    .Set("fidelity", "exact-weighted-unity-animation-curve-scalar-size")
                    .Set("requiresOracle", true));
            if (hasLoopingSubEmitter)
                simulationAdapters.Add(new JObject()
                    .Set("id", "unity-sub-emitter-lifecycle")
                    .Set("version", 1)
                    .Set("kind", "simulation")
                    .Set("fidelity", "parent-event-owned-live-instance-bounded-by-child-duration")
                    .Set("requiresOracle", true));
            if (hasSubEmitterInheritance)
                simulationAdapters.Add(new JObject()
                    .Set("id", "unity-sub-emitter-inheritance")
                    .Set("version", 1)
                    .Set("kind", "simulation")
                    .Set("fidelity", "event-edge-parent-current-size-and-color")
                    .Set("requiresOracle", true));
            foreach (ExportDiagnostic diagnostic in ctx.Diagnostics)
            {
                bool controllerDiagnostic = diagnostic.Code == "CONTROLLER_SLASH_DECAL_ADAPTER"
                    || diagnostic.Code == "CONTROLLER_PROJECTILE_HOST_EVENT"
                    || diagnostic.Code == "CONTROLLER_LIGHT_FADE_ADAPTER"
                    || diagnostic.Code == "CONTROLLER_AUTO_ROTATE_ADAPTER"
                    || diagnostic.Code == "CONTROLLER_LIGHT_FLICKER_ADAPTER";
                if (!diagnostic.RequiresOracle && !controllerDiagnostic) continue;
                requiresOracle = true;
                if ((diagnostic.Code == "PS_NOISE_MANUAL_LOWERING"
                    || diagnostic.Code == "PS_NOISE_TRAJECTORY_CACHE"
                    || diagnostic.Code == "PS_FORCE_TRAJECTORY_CACHE"
                    || diagnostic.Code == "PS_GRAVITY_TRAJECTORY_CACHE"
                    || diagnostic.Code == "PS_COLLISION_SCENE_QUERY"
                    || diagnostic.Code == "PS_STOCHASTIC_STATE_CACHE") && !trajectoryAdapterAdded)
                {
                    simulationAdapters.Add(new JObject()
                        .Set("id", "particle-trajectory-cache")
                        .Set("version", 6)
                        .Set("kind", "simulation")
                        .Set("fidelity", "sampled-camera-independent-state-with-explicit-terminal-edge")
                        .Set("requiresOracle", true));
                    trajectoryAdapterAdded = true;
                }
                if ((diagnostic.Code == "PS_TRAIL_ONLY_RENDERER"
                    || diagnostic.Code == "PS_TRAIL_SECONDARY_RENDERER") && !trailAdapterAdded)
                {
                    simulationAdapters.Add(new JObject()
                        .Set("id", "unity-trail-semantics")
                        .Set("version", 2)
                        .Set("kind", "simulation")
                        .Set("fidelity", "live-second-lifetime-distance-sampling-width-color-and-death")
                        .Set("requiresOracle", true));
                    simulationAdapters.Add(new JObject()
                        .Set("id", "unity-trail-geometry")
                        .Set("version", 2)
                        .Set("kind", "simulation")
                        .Set("fidelity", "sampled-camera-independent-unity-trail-topology-compact-binary")
                        .Set("requiresOracle", true));
                    trailAdapterAdded = true;
                }
                if (controllerDiagnostic && !controllerAdapterAdded)
                {
                    simulationAdapters.Add(new JObject()
                        .Set("id", "unity-effect-controller")
                        .Set("version", 1)
                        .Set("kind", "simulation")
                        .Set("fidelity", "reviewed-controller-programs-including-deterministic-light-fade")
                        .Set("requiresOracle", true));
                    controllerAdapterAdded = true;
                }
            }
            return new JObject()
                .Set("schema", Schema)
                .Set("runtime", Runtime)
                .Set("policy", "strict")
                .Set("representation", "live-particles@1")
                .Set("effectId", ctx.GetTransformUuid(root.transform))
                .Set("seed", (double)seed)
                .Set("fixedDelta", 1.0 / 60.0)
                .Set("referenceCamera", new JObject()
                    .Set("projection", "perspective")
                    .Set("fov", 60)
                    .Set("near", 0.1)
                    .Set("far", 100)
                    .Set("position", new JArray().Add(2.15).Add(1.55).Add(-4.55))
                    .Set("target", new JArray().Add(0).Add(0.95).Add(0)))
                .Set("captureTimes", new JArray()
                    .Add(5.0 / 60.0).Add(9.0 / 60.0).Add(15.0 / 60.0).Add(24.0 / 60.0)
                    .Add(30.0 / 60.0).Add(60.0 / 60.0).Add(120.0 / 60.0))
                .Set("lifecycle", BuildOneShotLifecycle(root, ctx))
                .Set("qualification", new JObject()
                    .Set("status", "candidate")
                    .Set("oracleRequired", requiresOracle)
                    .Set("simulationAdapters", simulationAdapters))
                .Set("editability", new JObject()
                    .Set("simulation", requiresOracle ? "hybrid-live" : "live")
                    .Set("material", "live-ir")
                    .Set("spawnInitialization", "calibrated-spawn-state+schedule@1")
                    .Set("limitations", new JArray()
                        .Add("Editing shape/start-speed/start-size/start-color/start-life requires regenerating spawn calibration.")
                        .Add(requiresOracle
                            ? "Unity-native Noise/Collision trajectories are camera-independent sampled simulation data and require regeneration when motion modules change."
                            : "No trajectory cache is active."))
                    .Set("plannedReplacement", "deterministic-random-lanes@1"))
                .Set("diagnostics", ctx.DiagnosticsJson());
        }

        /// <summary>
        /// Conservative natural end of the one-shot hierarchy. A child may be spawned at the
        /// end of any ancestor's emission window and then live for its own maximum lifetime;
        /// summing that ancestry is deliberately safe and avoids restarting local loop modules.
        /// </summary>
        public static float ComputeOneShotTerminal(GameObject root, ExportContext ctx)
        {
            const float step = 1f / 60f;
            // The strict reference oracle is intentionally bounded to two seconds. Beyond this
            // window there is no approved Unity evidence, so standalone Web preview must finish
            // rather than silently inventing repeat generations from local main.loop flags.
            const float referenceWindow = 2f;
            foreach (ParticleSystem ps in root.GetComponentsInChildren<ParticleSystem>(true))
                if (!ctx.IsSubTarget(ps) && ps.main.loop)
                    return referenceWindow;
            float terminal = step;
            foreach (ParticleSystem ps in root.GetComponentsInChildren<ParticleSystem>(true))
            {
                float branch = 0f;
                for (Transform t = ps.transform; t != null && t != root.transform.parent; t = t.parent)
                {
                    ParticleSystem ancestor = t.GetComponent<ParticleSystem>();
                    if (ancestor == null) continue;
                    var main = ancestor.main;
                    branch += Mathf.Max(0f, main.startDelay.constantMax)
                        + Mathf.Max(0f, main.duration)
                        + Mathf.Max(0f, main.startLifetime.constantMax);
                }
                terminal = Mathf.Max(terminal, branch);
            }
            // Align termination to the same fixed simulation lattice used by the oracle.
            terminal = Mathf.Min(referenceWindow, Mathf.Ceil(terminal / step) * step);
            return terminal;
        }

        private static JObject BuildOneShotLifecycle(GameObject root, ExportContext ctx)
        {
            float terminal = ComputeOneShotTerminal(root, ctx);
            return new JObject()
                .Set("schema", "effect-lifecycle@1")
                .Set("rootLoopPolicy", "one-shot")
                .Set("terminalTime", terminal)
                .Set("terminalAction", "stop-and-clear")
                .Set("timeDomain", "unity-root-fixed-step@60hz");
        }
    }
}
