using System.Collections.Generic;
using System.IO;
using UnityEngine;

namespace BabylonQuarks.UnityExporter
{
    /// <summary>
    /// Maps a Unity ParticleSystem's Shuriken modules onto a quarks "ps" object — the per-system
    /// payload of a ParticleEmitter node in the Quarks JSON envelope. SemanticValidator runs first;
    /// this converter therefore receives only the explicitly supported, non-lossy v1 subset.
    /// </summary>
    public static class ParticleConverter
    {
        /// <summary>
        /// Marketplace packages occasionally contain native-invalid renderer/mesh combinations
        /// for which Unity's BakeMesh crashes the editor instead of throwing. The broad discovery
        /// export uses live texture-sheet semantics as a safe fallback; focused exports keep the
        /// exact trajectory bake enabled.
        /// </summary>
        public static bool DisableTrajectoryBake;
        private static readonly Dictionary<string, bool[]> CapturedRendererFlips =
            new Dictionary<string, bool[]>();

        private static string FlipKey(ParticleSystem ps, uint seed) =>
            $"{ps.GetEntityId()}:{seed}";
        public static JObject BuildPs(ParticleSystem ps, ParticleSystemRenderer renderer, ExportContext ctx,
            bool forceTrailRenderer = false)
        {
            var main = ps.main;
            var behaviors = new JArray();

            bool trailOnly = forceTrailRenderer || (ps.trails.enabled && renderer.sharedMaterial == null
                && renderer.trailMaterial != null);
            Material originalPrimary = renderer.sharedMaterial;
            if (trailOnly) renderer.sharedMaterial = renderer.trailMaterial;
            string materialUuid;
            try { materialUuid = ctx.AddMaterialForRenderer(renderer); }
            finally { if (trailOnly) renderer.sharedMaterial = originalPrimary; }
            bool localAlignedBillboard = !trailOnly
                && renderer.renderMode == ParticleSystemRenderMode.Billboard
                && renderer.alignment == ParticleSystemRenderSpace.Local;
            int renderMode = trailOnly ? 3 : (localAlignedBillboard ? 2 : MapRenderMode(renderer.renderMode));
            string geometryUuid = localAlignedBillboard
                ? ctx.AddLocalBillboardQuadGeometry()
                : (renderMode == 2
                    ? (renderer.mesh != null
                        ? ctx.AddGeometryForMesh(renderer.mesh)
                        // Some marketplace prefabs serialize Mesh render mode while the mesh
                        // reference is supplied by an editor-only/runtime component. Keep the
                        // renderer contract explicit with a unit quad fallback; the effect stays
                        // editable and visible instead of failing the entire load.
                        : ctx.AddLocalBillboardQuadGeometry())
                    : null);
            JToken emissionOverTime = EmissionRate(ps, true);
            JToken startLife = ValueConverter.Curve(main.startLifetime);

            var obj = new JObject()
                .Set("version", "3.0")
                .Set("autoDestroy", false)
                .Set("looping", main.loop)
                .Set("prewarm", main.prewarm)
                .Set("duration", main.duration)
                .Set("semanticId", ctx.GetNodeUuid(ps))
                .Set("randomSeed", (double)(ps.randomSeed == 0 ? 1u : ps.randomSeed))
                .Set("startDelay", ValueConverter.Curve(main.startDelay))
                .Set("shape", BuildShape(ps.shape, ctx))
                .Set("startLife", startLife)
                .Set("startSpeed", ValueConverter.Curve(main.startSpeed))
                .Set("startRotation", BuildStartRotation(main, renderMode))
                .Set("startSize", BuildStartSize(main))
                .Set("startColor", ValueConverter.StartColor(main.startColor))
                .Set("emissionOverTime", emissionOverTime)
                .Set("emissionOverDistance", EmissionRate(ps, false))
                .Set("emissionBursts", BuildBursts(ps))
                .Set("onlyUsedByOther", ctx.IsSubTarget(ps))
                .Set("renderMode", renderMode)
                .Set("renderOrder", renderer.sortingOrder)
                .Set("rendererEmitterSettings", BuildRendererSettings(ps, renderer, renderMode))
                // UV flip is a renderer property, not a material property. Multiple particle
                // systems can share one Material while choosing different deterministic flips.
                .Set("unityRendererFlip", new JArray()
                    .Add(Mathf.Approximately(renderer.flip.x, 1f))
                    .Add(Mathf.Approximately(renderer.flip.y, 1f)))
                .Set("unityRendererAlignment", new JObject()
                    .Set("schema", "unity-renderer-alignment@1")
                    .Set("sourceRenderMode", renderer.renderMode.ToString())
                    .Set("alignment", renderer.alignment.ToString())
                    .Set("lowering", localAlignedBillboard
                        ? "local-billboard-instanced-quad"
                        : "native-quarks-render-mode"))
                .Set("material", materialUuid)
                .Set("layers", 1);
            if ((renderer.flip.x > 0f && renderer.flip.x < 1f)
                || (renderer.flip.y > 0f && renderer.flip.y < 1f))
                obj.Set("unityRendererUvFlip", new JObject()
                    .Set("schema", "unity-renderer-uv-flip@1")
                    .Set("source", "renderer-baked-per-particle")
                    .Set("probability", new JArray().Add(renderer.flip.x).Add(renderer.flip.y)));

            if (!main.startSize3D && main.startSize.mode == ParticleSystemCurveMode.TwoCurves)
            {
                // QuarksLoader receives a valid deterministic placeholder; the strict Web
                // semantic layer replaces it with the sample-once UnityTwoCurves generator.
                obj.Set("startSize", ValueConverter.Bezier(main.startSize.curveMax,
                        main.startSize.curveMultiplier))
                    .Set("unityStartSize", ValueConverter.TwoCurves(main.startSize,
                        "main.startSize"));
            }

            // Vertex streams are shader inputs, not renderer trivia. Persist the exact Unity
            // declaration so the material compiler can distinguish a real Custom/AnimBlend
            // value from an unbound TEXCOORD component (which Unity initializes to zero).
            var activeStreams = new List<ParticleSystemVertexStream>();
            renderer.GetActiveVertexStreams(activeStreams);
            var streamJson = new JArray();
            foreach (ParticleSystemVertexStream stream in activeStreams)
                streamJson.Add(stream.ToString());
            obj.Set("unityVertexStreams", streamJson);

            // Quarks shapes do not carry Unity's Shape-module-local TRS. Preserve it as
            // semantic metadata; the Web runtime applies it exactly once, immediately after
            // shape initialization and before the remaining particle behaviours.
            var shape = ps.shape;
            if (shape.enabled && (shape.position.sqrMagnitude > 1e-10f
                || shape.rotation.sqrMagnitude > 1e-10f
                || (shape.scale - Vector3.one).sqrMagnitude > 1e-10f))
            {
                Quaternion q = Quaternion.Euler(shape.rotation);
                obj.Set("unityShapeTransform", new JObject()
                    .Set("position", Vec3Rh(shape.position))
                    .Set("rotation", new JArray().Add(-q.x).Add(-q.y).Add(q.z).Add(q.w))
                    .Set("scale", Vec3(shape.scale)));
            }

            if (geometryUuid != null)
            {
                obj.Set("instancingGeometry", geometryUuid);
                // Explicit renderer-space basis. Unity defines pivot in fractions of particle
                // size (0.5 = one radius); it belongs before the live size/rotation instance TRS.
                // Keeping this in IR also prevents shape.scale or hierarchy scale from being
                // accidentally reused as a geometry correction.
                obj.Set("unityMeshRendererBasis", new JObject()
                    .Set("schema", "unity-mesh-renderer-basis@1")
                    .Set("pivot", Vec3Rh(renderer.pivot))
                    .Set("scaleSource", "particle-current-size")
                    .Set("handedness", "reflect-z-once"));
            }

            // A looping sub-emitter is an event-owned live program, not a finite root-clock
            // recording. Flattening its first captured cycle loses every later loop; replaying
            // the capture would also make the child camera/time baked. Keep this boundary
            // explicit and let the parent EmitSubParticleSystem edge own the live instance.
            // A synthetic trail renderer reuses the source ParticleSystem, but it is not an
            // event-owned child. Never stamp the live sub-emitter lifecycle contract onto it;
            // doing so makes the runtime reject valid trails as malformed sub-emitters.
            bool liveLoopingSubEmitter = !forceTrailRenderer && ctx.IsSubTarget(ps) && main.loop;
            if (liveLoopingSubEmitter)
                obj.Set("unitySubEmitterLifecycle", new JObject()
                    .Set("schema", "unity-sub-emitter-lifecycle@1")
                    .Set("ownership", "parent-event")
                    .Set("looping", true)
                    .Set("termination", "child-duration"));

            JArray initialState = ctx.GetHierarchyInitialState(ps)
                ?? CaptureDeterministicInitialState(ps, renderer);
            if (!liveLoopingSubEmitter && initialState.Items.Count > 0)
            {
                obj.Set("unityInitialState", initialState);
                // World-space sub emitters already have a root-clock spawn time and an exact
                // camera-independent trajectory in the semantic IR. Compile them to a flat
                // deterministic schedule instead of preserving Quarks' frame-ordered nested
                // event edge (which necessarily delays Birth emissions by one Web frame).
                // Local-space sub emitters still require their live parent transform and keep
                // the authored event relationship until that semantic is lowered explicitly.
            }
            // Presence of a hierarchy capture is semantic even when the array is empty. In
            // particular, a collision sub-emitter that produced zero particles in Unity must
            // compile to an empty root-clock schedule; retaining Quarks' live event edge would
            // fabricate impacts that never existed in the source simulation.
            if (!liveLoopingSubEmitter && initialState != null && (!ctx.IsSubTarget(ps)
                    || main.simulationSpace == ParticleSystemSimulationSpace.World))
                obj.Set("unitySpawnSchedule", BuildSpawnSchedule(initialState));
            JArray trajectoryCache = ctx.GetHierarchyTrajectoryCache(ps);
            if (!liveLoopingSubEmitter && trajectoryCache != null && trajectoryCache.Items.Count > 0)
                obj.Set("unityTrajectoryCache", new JObject()
                    .Set("schema", "particle-trajectory-cache@6")
                    .Set("sampleRate", 60)
                    .Set("space", main.simulationSpace == ParticleSystemSimulationSpace.World ? "world" : "local")
                    .Set("tracks", trajectoryCache));
            JArray trailGeometry = ctx.GetHierarchyTrailGeometryCache(ps);
            if (renderMode == 3 && trailGeometry != null && trailGeometry.Items.Count > 0)
                obj.Set("unityTrailGeometry", EncodeTrailGeometry(
                    trailGeometry,
                    ps.trails.worldSpace ? "world" :
                        (main.simulationSpace == ParticleSystemSimulationSpace.World ? "world" : "local")));

            BuildTextureSheet(ps, obj, behaviors);

            obj.Set("blending", ctx.LastBlendMode)
                .Set("transparent", true)
                .Set("worldSpace", main.simulationSpace != ParticleSystemSimulationSpace.Local);

            // ---- behaviors from the over-lifetime / by-speed modules ----
            if (!NeedsTrajectoryCache(ps)) AddGravity(main, behaviors);
            AddRandomizeDirection(ps, behaviors);
            AddColorOverLife(ps, behaviors);
            AddSizeOverLife(ps, obj, behaviors);
            AddRotationOverLife(ps, obj, behaviors, localAlignedBillboard, renderMode == 5);
            AddVelocityOverLife(ps, obj);
            AddInheritVelocity(ps, behaviors);
            AddLimitVelocity(ps, obj, behaviors);
            // Unity Force over Lifetime has source-space and per-particle stochastic lanes that
            // Quarks' generic behavior does not preserve. The strict compiler captures the
            // camera-independent particle state instead of retaining an approximate force.
            if (!NeedsTrajectoryCache(ps)) AddForceOverLife(ps, behaviors);
            AddColorBySpeed(ps, behaviors);
            AddSizeBySpeed(ps, behaviors);
            AddRotationBySpeed(ps, behaviors);
            AddNoise(ps, obj, behaviors);
            AddCollision(ps, obj, behaviors);
            // A synthetic trail renderer mirrors the source particle state. It must not emit a
            // second copy of Birth/Death/Collision sub-particles.
            if (!forceTrailRenderer) AddSubEmitters(ps, ctx, behaviors);

            if (renderMode == 3)
            {
                var trails = ps.trails;
                obj.Set("unityTrailSemantics", new JObject()
                    .Set("schema", "unity-trail-semantics@2")
                    .Set("mode", trails.mode.ToString())
                    .Set("ratio", trails.ratio)
                    .Set("lifetime", ValueConverter.Curve(trails.lifetime))
                    .Set("minVertexDistance", trails.minVertexDistance)
                    .Set("textureMode", trails.textureMode.ToString())
                    .Set("worldSpace", trails.worldSpace)
                    .Set("widthOverTrail", ValueConverter.Curve(trails.widthOverTrail))
                    .Set("colorOverLifetime", ValueConverter.StartColorGradient(trails.colorOverLifetime))
                    .Set("colorOverTrail", ValueConverter.StartColorGradient(trails.colorOverTrail))
                    .Set("sizeAffectsWidth", trails.sizeAffectsWidth)
                    .Set("sizeAffectsLifetime", trails.sizeAffectsLifetime)
                    .Set("inheritParticleColor", trails.inheritParticleColor)
                    .Set("dieWithParticles", trails.dieWithParticles)
                    .Set("ribbonCount", trails.ribbonCount)
                    .Set("splitSubEmitterRibbons", trails.splitSubEmitterRibbons)
                    .Set("attachRibbonsToTransform", trails.attachRibbonsToTransform));
            }

            obj.Set("behaviors", behaviors);

            // Custom1 channels are shader inputs (often dissolve on X/Y and dynamic clip on Z).
            JObject customData = BuildCustomData(ps);
            if (customData != null) obj.Set("cfxrCustomData", customData);

            return obj;
        }

        private static JObject BuildSpawnSchedule(JArray initialState)
        {
            // Keep Unity's captured float timestamps exactly. Quantizing to microseconds can
            // move a particle from 0.15000002 to 0.15 and make it visible one frame early.
            var counts = new SortedDictionary<double, int>();
            foreach (JToken token in initialState.Items)
            {
                if (!(token is JObject state)) continue;
                JNumber time = state.Get("scheduleTime") as JNumber
                    ?? state.Get("spawnTime") as JNumber;
                if (time == null) continue;
                double key = time.Value;
                counts[key] = counts.TryGetValue(key, out int count) ? count + 1 : 1;
            }
            var bursts = new JArray();
            foreach (var entry in counts)
                bursts.Add(new JObject()
                    .Set("time", entry.Key)
                    .Set("count", ValueConverter.Constant(entry.Value))
                    .Set("probability", 1)
                    .Set("interval", 0)
                    .Set("cycle", 1));
            return new JObject()
                .Set("schema", "calibrated-spawn-schedule@1")
                .Set("bursts", bursts);
        }

        /// <summary>
        /// Exports enabled Custom Data curves (dissolve timeline).
        /// CFXR usually wires dissolve → custom1.x; some Shader Graph packs use custom1.y
        /// while leaving x at constant 0 — export the first non-trivial channel.
        /// </summary>
        private static JObject BuildCustomData(ParticleSystem ps)
        {
            var mod = ps.customData;
            if (!mod.enabled) return null;
            if (mod.GetMode(ParticleSystemCustomData.Custom1) == ParticleSystemCustomDataMode.Disabled)
                return null;

            var block = new JObject();
            var c0 = mod.GetVector(ParticleSystemCustomData.Custom1, 0);
            var c1 = mod.GetVector(ParticleSystemCustomData.Custom1, 1);
            var c2 = mod.GetVector(ParticleSystemCustomData.Custom1, 2);
            var c3 = mod.GetVector(ParticleSystemCustomData.Custom1, 3);
            block.Set("custom1x", SemanticCustomCurve(c0))
                .Set("custom1y", SemanticCustomCurve(c1))
                .Set("custom1z", SemanticCustomCurve(c2))
                .Set("custom1w", SemanticCustomCurve(c3));
            return block;
        }

        private static JToken SemanticCustomCurve(ParticleSystem.MinMaxCurve curve)
        {
            if (curve.mode == ParticleSystemCurveMode.Curve)
                return ValueConverter.SemanticCurve(curve.curve, curve.curveMultiplier);
            return ValueConverter.Curve(curve);
        }

        private static bool IsConstantZero(ParticleSystem.MinMaxCurve curve)
        {
            if (curve.mode == ParticleSystemCurveMode.Constant)
                return Mathf.Approximately(curve.constant, 0f);
            if (curve.mode == ParticleSystemCurveMode.TwoConstants)
                return Mathf.Approximately(curve.constantMin, 0f) && Mathf.Approximately(curve.constantMax, 0f);
            return false;
        }

        // ---- Main ------------------------------------------------------------------------

        private static JToken BuildStartRotation(ParticleSystem.MainModule main, int renderMode)
        {
            bool mesh = renderMode == 2;
            if (main.startRotation3D)
            {
                // Mesh particles carry a full 3D orientation (quarks EulerGenerator → quaternion).
                // Billboards only rotate in screen space, so use just the Z angle.
                if (mesh)
                {
                    return Euler(
                        ValueConverter.Curve(main.startRotationX),
                        ValueConverter.Curve(main.startRotationY),
                        ValueConverter.Curve(main.startRotationZ));
                }
                // Z-reflection used for Unity LH -> Web RH mirrors screen-space billboard spin.
                return ScaleCurve(main.startRotationZ, -1f);
            }
            if (mesh)
            {
                // A scalar rotation on a mesh spins around Z in Unity; a plain quarks scalar would
                // spin around Y, so wrap it as a Z-only Euler to keep the axis correct.
                return Euler(ValueConverter.Constant(0), ValueConverter.Constant(0), ValueConverter.Curve(main.startRotation));
            }
            return ScaleCurve(main.startRotation, -1f);
        }

        private static JToken Euler(JToken x, JToken y, JToken z) =>
            // Unity's intrinsic ZXY order (rotate Z, then X, then Y) is the same rotation as quarks'
            // intrinsic YXZ order — not XYZ. Using XYZ here turns an in-plane Unity spin (e.g. a
            // random Y-axis roll on a flat mesh) into a wobble out of plane.
            new JObject().Set("type", "Euler").Set("angleX", x).Set("angleY", y).Set("angleZ", z).Set("eulerOrder", "YXZ");

        private static JToken BuildStartSize(ParticleSystem.MainModule main)
        {
            if (main.startSize3D)
            {
                return new JObject()
                    .Set("type", "Vector3Function")
                    .Set("x", ValueConverter.Curve(main.startSizeX))
                    .Set("y", ValueConverter.Curve(main.startSizeY))
                    .Set("z", ValueConverter.Curve(main.startSizeZ));
            }
            return ValueConverter.Curve(main.startSize);
        }

        private static void AddGravity(ParticleSystem.MainModule main, JArray behaviors)
        {
            float g = ConstantOf(main.gravityModifier);
            if (Mathf.Abs(g) < 1e-5f) return;
            // Gravity pulls along world -Y whatever the emitter's own rotation is,
            // so it has to be a world-space force. ApplyForce adds its direction
            // straight to the velocity, which for a local-space system means the
            // emitter's rotation turns it: a particle system carrying Unity's usual
            // -90 degrees about X had its gravity pushing along world Z instead of
            // down. ForceOverLife is the behavior that undoes the emitter transform.
            behaviors.Add(new JObject()
                .Set("type", "ForceOverLife")
                .Set("x", ValueConverter.Constant(0f))
                .Set("y", ValueConverter.Constant(-9.81f * g))
                .Set("z", ValueConverter.Constant(0f)));
        }

        // ---- Emission --------------------------------------------------------------------

        private static JToken EmissionRate(ParticleSystem ps, bool overTime)
        {
            var e = ps.emission;
            if (!e.enabled) return ValueConverter.Constant(0);
            return ValueConverter.Curve(overTime ? e.rateOverTime : e.rateOverDistance);
        }

        private static JToken BuildBursts(ParticleSystem ps)
        {
            var arr = new JArray();
            var e = ps.emission;
            if (!e.enabled || e.burstCount == 0) return arr;
            var bursts = new ParticleSystem.Burst[e.burstCount];
            e.GetBursts(bursts);
            foreach (var b in bursts)
            {
                arr.Add(new JObject()
                    .Set("time", b.time)
                    .Set("count", ValueConverter.Curve(b.count))
                    .Set("probability", b.probability)
                    .Set("interval", Mathf.Max(0.001f, b.repeatInterval))
                    .Set("cycle", Mathf.Max(1, b.cycleCount)));
            }
            return arr;
        }

        // ---- Shape -----------------------------------------------------------------------

        private static JToken BuildShape(ParticleSystem.ShapeModule shape, ExportContext ctx)
        {
            if (!shape.enabled) return new JObject().Set("type", "point");

            float arc = shape.arc * Mathf.Deg2Rad;
            float thickness = shape.radiusThickness;
            switch (shape.shapeType)
            {
                case ParticleSystemShapeType.Cone:
                    return ShapeBase("cone", shape.radius, arc, thickness).Set("angle", shape.angle * Mathf.Deg2Rad);
                case ParticleSystemShapeType.ConeVolume:
                    return new JObject()
                        .Set("type", "unity-cone-volume")
                        .Set("radius", shape.radius)
                        .Set("angle", shape.angle * Mathf.Deg2Rad)
                        .Set("length", shape.length);
                case ParticleSystemShapeType.Box:
                    // Canonical unit box. unityShapeTransform owns Shape.scale/rotation/position.
                    return new JObject().Set("type", "unity-box-volume");
                case ParticleSystemShapeType.Sphere:
                    return ShapeBase("sphere", shape.radius, arc, thickness);
                case ParticleSystemShapeType.Hemisphere:
                    return ShapeBase("hemisphere", shape.radius, arc, thickness);
                case ParticleSystemShapeType.Circle:
                    return ShapeBase("circle", shape.radius, arc, thickness);
                case ParticleSystemShapeType.Donut:
                    return ShapeBase("donut", shape.radius, arc, thickness).Set("donutRadius", shape.donutRadius);
                case ParticleSystemShapeType.Mesh:
                    if (shape.mesh != null)
                    {
                        string meshNodeUuid = ctx.AddMeshSourceNode(shape.mesh);
                        return new JObject().Set("type", "mesh_surface").Set("mesh", meshNodeUuid);
                    }
                    return new JObject().Set("type", "point");
                default:
                    // Other shapes have no reviewed strict runtime equivalent yet.
                    return new JObject().Set("type", "point");
            }
        }

        private static JObject ShapeBase(string type, float radius, float arc, float thickness)
        {
            return new JObject()
                .Set("type", type)
                .Set("radius", radius)
                // Unity radiusThickness maps 1:1 to quarks thickness (0 = surface shell, 1 = full volume).
                .Set("thickness", Mathf.Clamp01(thickness))
                .Set("arc", arc)
                .Set("mode", 0)
                .Set("spread", 0)
                .Set("speed", ValueConverter.Constant(0));
        }

        // ---- Renderer --------------------------------------------------------------------

        private static int MapRenderMode(ParticleSystemRenderMode mode)
        {
            switch (mode)
            {
                case ParticleSystemRenderMode.Billboard: return 0;
                case ParticleSystemRenderMode.Stretch: return 1;
                case ParticleSystemRenderMode.HorizontalBillboard: return 4;
                case ParticleSystemRenderMode.VerticalBillboard: return 5;
                case ParticleSystemRenderMode.Mesh: return 2;
                default: return 0;
            }
        }

        private static JToken BuildRendererSettings(ParticleSystem ps,
            ParticleSystemRenderer renderer, int renderMode)
        {
            var settings = new JObject()
                .Set("unityPivot", new JArray().Add(renderer.pivot.x).Add(renderer.pivot.y).Add(renderer.pivot.z))
                .Set("unityMinParticleSize", renderer.minParticleSize)
                .Set("unityMaxParticleSize", renderer.maxParticleSize);
            if (renderMode == 1) // stretched billboard
            {
                // Preserve Unity's authored coefficients verbatim. The Web vertex lowering uses
                //   speed * velocityScale + currentSize * lengthScale
                // directly, so variable start size / Size over Lifetime remain exact and no
                // representative-size estimate is permitted here.
                return settings
                    .Set("speedFactor", renderer.velocityScale)
                    .Set("lengthFactor", renderer.lengthScale);
            }
            if (renderMode == 3)
            {
                return settings
                    // The semantic behavior owns lifetime and vertex sampling in seconds.
                    // Keep Quarks' hard cap high enough that it never truncates valid points.
                    .Set("startLength", ValueConverter.Constant(4096))
                    .Set("followLocalOrigin", ps.main.simulationSpace
                        == ParticleSystemSimulationSpace.Local);
            }
            return settings;
        }

        // ---- Texture Sheet Animation -----------------------------------------------------

        private static void BuildTextureSheet(ParticleSystem ps, JObject obj, JArray behaviors)
        {
            var tsa = ps.textureSheetAnimation;
            if (tsa.enabled)
            {
                int u = Mathf.Max(1, tsa.numTilesX);
                int v = Mathf.Max(1, tsa.numTilesY);
                bool singleRow = tsa.animation == ParticleSystemAnimationType.SingleRow;
                // Unity normalizes start/frame curves over the animated sequence, not the
                // physical atlas. For SingleRow that sequence has exactly numTilesX cells.
                int tiles = Mathf.Max(1, singleRow ? u : u * v);
                // Unity stores startFrame and frameOverTime in normalized sheet space (0..1).
                // Quarks stores a concrete tile index. Use `tiles`, not `tiles - 1`: Unity's
                // common random range 0..0.9999 must cover every tile after floor().
                obj.Set("startTileIndex", ScaleCurve(tsa.startFrame, tiles))
                    .Set("uTileCount", u)
                    .Set("vTileCount", v)
                    .Set("unityFlipbookFrameCount", tiles)
                    .Set("blendTiles", false);
                if (singleRow)
                {
                    obj.Set("unityFlipbookSingleRow", true)
                        .Set("unityFlipbookRowIndex", Mathf.Clamp(tsa.rowIndex, 0, v - 1))
                        .Set("unityFlipbookRandomRow", tsa.useRandomRow);
                }
                // Runtime adds this offset to startTileIndex and wraps by tile count, matching
                // Unity's `(startFrame + frameOverTime * cycleCount) * tiles` semantics.
                behaviors.Add(new JObject()
                    .Set("type", "FrameOverLife")
                    .Set("frame", ScaleCurve(tsa.frameOverTime, tiles * tsa.cycleCount)));
                obj.Set("unityFlipbookTimeMode",
                        tsa.timeMode == ParticleSystemAnimationTimeMode.Speed ? "speed" : "lifetime")
                    .Set("unityFlipbookSpeedRange",
                        new JArray().Add(tsa.speedRange.x).Add(tsa.speedRange.y));
            }
            else
            {
                obj.Set("startTileIndex", ValueConverter.Constant(0))
                    .Set("uTileCount", 1)
                    .Set("vTileCount", 1)
                    .Set("blendTiles", false);
            }
        }

        // ---- over-lifetime behaviors -----------------------------------------------------

        private static void AddColorOverLife(ParticleSystem ps, JArray behaviors)
        {
            var m = ps.colorOverLifetime;
            if (!m.enabled) return;
            behaviors.Add(new JObject().Set("type", "ColorOverLife").Set("color", ValueConverter.StartColorGradient(m.color)));
        }

        private static void AddSizeOverLife(ParticleSystem ps, JObject particleIr, JArray behaviors)
        {
            var m = ps.sizeOverLifetime;
            if (!m.enabled) return;
            // Weighted Unity AnimationCurve handles cannot be represented by Quarks'
            // value-only PiecewiseBezier. Preserve the authored time/value/tangent/weight IR;
            // the strict runtime replaces the loader-compatible behavior before simulation.
            if (!m.separateAxes && m.size.mode == ParticleSystemCurveMode.Curve)
                particleIr.Set("unitySizeOverLifetime", new JObject()
                    .Set("schema", "unity-size-over-lifetime@1")
                    .Set("mode", "scalar")
                    .Set("curve", ValueConverter.SemanticCurve(
                        m.size.curve, m.size.curveMultiplier)));
            if (!m.separateAxes && m.size.mode == ParticleSystemCurveMode.TwoCurves)
            {
                // Keep the JSON loadable by Quarks while the semantic runtime replaces this
                // placeholder with the strict UnityTwoCurves@1 behavior before first update.
                particleIr.Set("unitySizeOverLifetime", ValueConverter.TwoCurves(
                    m.size, "sizeOverLifetime.scalar"));
            }
            JToken size = m.separateAxes
                ? new JObject()
                    .Set("type", "Vector3Function")
                    .Set("x", ValueConverter.Curve(m.x))
                    .Set("y", ValueConverter.Curve(m.y))
                    .Set("z", ValueConverter.Curve(m.z))
                : m.size.mode == ParticleSystemCurveMode.TwoCurves
                    ? ValueConverter.Bezier(m.size.curveMax, m.size.curveMultiplier)
                    : ValueConverter.Curve(m.size);
            behaviors.Add(new JObject().Set("type", "SizeOverLife").Set("size", size));
        }

        private static JArray Vec3(Vector3 v) => new JArray().Add(v.x).Add(v.y).Add(v.z);
        private static JArray Vec3Rh(Vector3 v) => new JArray().Add(v.x).Add(v.y).Add(-v.z);

        /// <summary>
        /// Unity's particle RNG is native and is not equivalent to JavaScript Math.random.
        /// Compile the fixed-seed initialization stream into live particle state (not pixels).
        /// Curves/forces still execute normally after initialization and remain editable.
        /// </summary>
        public static void CaptureHierarchyInitialStates(GameObject root, ExportContext ctx)
        {
            ParticleSystem[] systems = root.GetComponentsInChildren<ParticleSystem>(true);
            // Reference simulation may execute controller programs that mutate hierarchy
            // transforms (AutoRotate, decal placement, etc.). The capture is a compiler probe,
            // not authored state: restore every transform before the subsequent oracle pass.
            var authoredLocalPositions = new Dictionary<Transform, Vector3>();
            var authoredLocalRotations = new Dictionary<Transform, Quaternion>();
            foreach (Transform transform in root.GetComponentsInChildren<Transform>(true))
            {
                authoredLocalPositions[transform] = transform.localPosition;
                authoredLocalRotations[transform] = transform.localRotation;
            }
            var targets = new List<ParticleSystem>();
            // Capture one hierarchy-clock stream for every system. Restricting this to
            // sub-emission targets forced root/ordinary emitters back through a separate probe,
            // which changed fixed-step random lanes and made calibrated schedules disagree.
            foreach (ParticleSystem ps in systems) targets.Add(ps);
            if (targets.Count == 0) return;

            // Use the same collision fixture as BakedEffectExporter. Previously semantic
            // trajectories were captured in empty space while the Unity oracle contained a
            // ground Plane; the resulting no-collision cache then overrode Web scene queries.
            GameObject captureGround = GameObject.CreatePrimitive(PrimitiveType.Plane);
            captureGround.name = "Quarks Reference Ground (trajectory fixture)";
            captureGround.transform.SetPositionAndRotation(Vector3.zero, Quaternion.identity);
            captureGround.transform.localScale = new Vector3(3.6f, 1f, 3.6f);
            MeshRenderer captureGroundRenderer = captureGround.GetComponent<MeshRenderer>();
            if (captureGroundRenderer != null) captureGroundRenderer.enabled = false;
            Physics.SyncTransforms();

            var results = new Dictionary<ParticleSystem, JArray>();
            var activeIds = new Dictionary<ParticleSystem, Dictionary<uint, string>>();
            var particleGenerations = new Dictionary<ParticleSystem, Dictionary<uint, int>>();
            var buffers = new Dictionary<ParticleSystem, ParticleSystem.Particle[]>();
            var trajectories = new Dictionary<ParticleSystem, Dictionary<string, JArray>>();
            var trajectoryTerminations = new Dictionary<ParticleSystem, Dictionary<string, JObject>>();
            var lastObservedParticles = new Dictionary<ParticleSystem,
                Dictionary<string, ParticleSystem.Particle>>();
            var trailGeometry = new Dictionary<ParticleSystem, JArray>();
            foreach (ParticleSystem target in targets)
            {
                results[target] = new JArray();
                activeIds[target] = new Dictionary<uint, string>();
                particleGenerations[target] = new Dictionary<uint, int>();
                buffers[target] = new ParticleSystem.Particle[Mathf.Max(1, target.main.maxParticles)];
                if (NeedsTrajectoryCache(target))
                {
                    trajectories[target] = new Dictionary<string, JArray>();
                    trajectoryTerminations[target] = new Dictionary<string, JObject>();
                    lastObservedParticles[target] =
                        new Dictionary<string, ParticleSystem.Particle>();
                }
                if (target.trails.enabled)
                    trailGeometry[target] = new JArray();
            }

            var authoredLooping = new Dictionary<ParticleSystem, bool>();
            foreach (ParticleSystem ps in systems)
            {
                authoredLooping[ps] = ps.main.loop;
                ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
            }
            const float step = 1f / 60f;
            float referenceWindow = SemanticValidator.ComputeOneShotTerminal(root, ctx);
            float horizon = 2f;
            foreach (ParticleSystem ps in systems)
            {
                // A nested system can be born at its parent's death. Drain the complete ancestry
                // lifetime chain after the root's one-shot emission window; otherwise the last
                // child generation reaches the capture boundary without an explicit terminal.
                float pathHorizon = step;
                for (Transform p = ps.transform; p != null && p != root.transform.parent;
                    p = p.parent)
                {
                    ParticleSystem ancestor = p.GetComponent<ParticleSystem>();
                    if (ancestor == null) continue;
                    pathHorizon += ancestor.main.duration
                        + ancestor.main.startDelay.constantMax
                        + ancestor.main.startLifetime.constantMax;
                }
                // The latest ordinary particle may be born on the finite emission boundary.
                // Drain the full ancestry lifetime chain *after* that boundary; measuring only
                // from t=0 left long-lived/noisy particles without an authoritative terminal.
                horizon = Mathf.Max(horizon, referenceWindow + pathHorizon);
            }
            // Drain past the analytical boundary. Unity's emission/lifetime clocks are floats;
            // a particle whose mathematical death is exactly `horizon` can remain visible on
            // that observation frame. Two extra fixed ticks establish the authoritative first-
            // absent edge instead of emitting an unterminated trajectory-cache@6 track.
            int steps = Mathf.CeilToInt(horizon / step) + 2;
            foreach (ParticleSystem ps in systems)
            {
                if (HasParticleAncestor(ps.transform, root.transform)) continue;
                ps.Simulate(0f, true, true, false);
            }
            ControllerSemanticCompiler.PrepareReferenceSimulation(root);
            for (int stepIndex = 0; stepIndex < steps; stepIndex++)
            {
                foreach (ParticleSystem ps in systems)
                {
                    if (HasParticleAncestor(ps.transform, root.transform)) continue;
                    ps.Simulate(step, true, false, false);
                }
                ControllerSemanticCompiler.AdvanceReferenceSimulation(root, step);

                float elapsed = (stepIndex + 1) * step;
                foreach (ParticleSystem target in targets)
                {
                    ParticleSystem.Particle[] particles = buffers[target];
                    int count = target.GetParticles(particles);
                    int[] frames = CaptureCurrentFrames(target,
                        target.GetComponent<ParticleSystemRenderer>(), count);
                    if (trailGeometry.TryGetValue(target, out JArray trailFrames))
                        trailFrames.Add(CaptureTrailGeometryFrame(target, elapsed, particles, count));
                    var born = new List<KeyValuePair<ParticleSystem.Particle, int>>();
                    var currentSeeds = new HashSet<uint>();
                    for (int i = 0; i < count; i++)
                    {
                        uint seed = particles[i].randomSeed;
                        currentSeeds.Add(seed);
                        if (activeIds[target].ContainsKey(seed)) continue;
                        int generation = particleGenerations[target].TryGetValue(seed, out int prior)
                            ? prior + 1 : 0;
                        particleGenerations[target][seed] = generation;
                        activeIds[target][seed] = $"{seed}:{generation}";
                        int frame = frames != null && i < frames.Length ? frames[i] : -1;
                        born.Add(new KeyValuePair<ParticleSystem.Particle, int>(particles[i], frame));
                    }
                    born.Sort((a, b) =>
                        (b.Key.startLifetime - b.Key.remainingLifetime)
                            .CompareTo(a.Key.startLifetime - a.Key.remainingLifetime));
                    ParticleSystemRenderer renderer = target.GetComponent<ParticleSystemRenderer>();
                    foreach (var item in born)
                    {
                        float age = Mathf.Max(0, item.Key.startLifetime - item.Key.remainingLifetime);
                        results[target].Add(BuildInitialState(target, renderer, item.Key,
                            item.Value, elapsed - age, elapsed,
                            activeIds[target][item.Key.randomSeed]));
                    }
                    if (trajectories.TryGetValue(target, out Dictionary<string, JArray> targetTracks))
                    {
                        bool captureCustom1 = target.customData.enabled
                            && target.customData.GetMode(ParticleSystemCustomData.Custom1)
                                != ParticleSystemCustomDataMode.Disabled;
                        bool captureCustom2 = target.customData.enabled
                            && target.customData.GetMode(ParticleSystemCustomData.Custom2)
                                != ParticleSystemCustomDataMode.Disabled;
                        var custom1 = new List<Vector4>(captureCustom1 ? count : 0);
                        var custom2 = new List<Vector4>(captureCustom2 ? count : 0);
                        if (captureCustom1)
                            target.GetCustomParticleData(custom1, ParticleSystemCustomData.Custom1);
                        if (captureCustom2)
                            target.GetCustomParticleData(custom2, ParticleSystemCustomData.Custom2);
                        bool regularSample = true;
                        for (int i = 0; i < count; i++)
                        {
                            uint particleSeed = particles[i].randomSeed;
                            if (!activeIds[target].TryGetValue(particleSeed, out string particleId))
                                continue;
                            bool first = !targetTracks.TryGetValue(particleId, out JArray samples);
                            if (first)
                            {
                                samples = new JArray();
                                targetTracks[particleId] = samples;
                            }
                            if (first || regularSample)
                                samples.Add(BuildTrajectorySample(target, renderer, particles[i],
                                    frames != null && i < frames.Length ? frames[i] : -1,
                                    i < custom1.Count ? (Vector4?)custom1[i] : null,
                                    i < custom2.Count ? (Vector4?)custom2[i] : null));
                            lastObservedParticles[target][particleId] = particles[i];
                        }
                    }
                    var endedSeeds = new List<uint>();
                    foreach (uint seed in activeIds[target].Keys)
                        if (!currentSeeds.Contains(seed)) endedSeeds.Add(seed);
                    foreach (uint seed in endedSeeds)
                    {
                        string particleId = activeIds[target][seed];
                        if (trajectoryTerminations.TryGetValue(target,
                                out Dictionary<string, JObject> targetTerminations)
                            && lastObservedParticles[target].TryGetValue(particleId,
                                out ParticleSystem.Particle lastParticle))
                        {
                            float lastAge = Mathf.Max(0,
                                lastParticle.startLifetime - lastParticle.remainingLifetime);
                            // GetParticles' disappearance edge is authoritative. Collision-killed
                            // particles commonly vanish between two 60 Hz observations; keeping
                            // the last visible position and a separate first-absent age prevents
                            // Web interpolation from inventing a post-impact endpoint.
                            string reason = target.collision.enabled
                                && lastParticle.remainingLifetime > step * 1.5f
                                    ? "collision-or-native-kill"
                                    : "lifetime";
                            targetTerminations[particleId] = new JObject()
                                .Set("lastVisibleAge", lastAge)
                                .Set("firstAbsentAge", lastAge + step)
                                .Set("position", Vec3Rh(lastParticle.position))
                                .Set("velocity", Vec3Rh(lastParticle.velocity))
                                .Set("reason", reason);
                            lastObservedParticles[target].Remove(particleId);
                        }
                        activeIds[target].Remove(seed);
                    }
                }
                // Capture Unity's real native RNG stream for every authored loop inside the
                // finite one-shot oracle window. At the boundary, stop only ordinary/root
                // emitters and drain their live particles; event-owned sub targets must remain
                // available for Death/Birth events raised during the drain phase.
                if (stepIndex + 1 == Mathf.CeilToInt(referenceWindow / step))
                {
                    foreach (ParticleSystem ps in systems)
                        if (!ctx.IsSubTarget(ps))
                            ps.Stop(false, ParticleSystemStopBehavior.StopEmitting);
                }
            }
            foreach (ParticleSystem ps in systems)
            {
                ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
                var restoredMain = ps.main;
                restoredMain.loop = authoredLooping[ps];
            }
            foreach (var entry in authoredLocalPositions)
                if (entry.Key != null) entry.Key.localPosition = entry.Value;
            foreach (var entry in authoredLocalRotations)
                if (entry.Key != null) entry.Key.localRotation = entry.Value;
            foreach (ParticleSystem target in targets)
                ctx.SetHierarchyInitialState(target, results[target]);
            foreach (var entry in trajectories)
            {
                var cache = new JArray();
                var particleIds = new List<string>(entry.Value.Keys);
                particleIds.Sort(System.StringComparer.Ordinal);
                foreach (string particleId in particleIds)
                {
                    var track = new JObject().Set("particleId", particleId)
                        .Set("samples", entry.Value[particleId]);
                    if (trajectoryTerminations[entry.Key].TryGetValue(particleId,
                            out JObject termination))
                        track.Set("termination", termination);
                    cache.Add(track);
                }
                if (cache.Items.Count > 0) ctx.SetHierarchyTrajectoryCache(entry.Key, cache);
            }
            foreach (var entry in trailGeometry)
                if (entry.Value.Items.Count > 0)
                    ctx.SetHierarchyTrailGeometryCache(entry.Key, entry.Value);
            UnityEngine.Object.DestroyImmediate(captureGround);
        }

        private static Camera trailBakeCamera;

        private static Camera TrailBakeCamera()
        {
            if (trailBakeCamera != null) return trailBakeCamera;
            var go = new GameObject("Quarks Trail Geometry Compiler Camera");
            go.hideFlags = HideFlags.HideAndDontSave;
            trailBakeCamera = go.AddComponent<Camera>();
            trailBakeCamera.fieldOfView = 60f;
            trailBakeCamera.transform.position = new Vector3(2.15f, 1.55f, -4.55f);
            trailBakeCamera.transform.LookAt(new Vector3(0f, 0.95f, 0f));
            return trailBakeCamera;
        }

        private static float Q6(float value) => Mathf.Round(value * 1000000f) / 1000000f;

        /// <summary>
        /// Compact, lossless-with-respect-to-the-exported-float32 trail cache. Pretty JSON made
        /// one small trail emitter exceed 50 MB; the runtime needs numeric arrays, not textual
        /// decimal spellings. Layout (little endian): magic UTG2, frameCount, then per frame
        /// time/fixed trail count and per trail point count followed by x,y,z,width float32 and
        /// alpha UNorm8. RGB remains live particle/material semantics exactly as in @1.
        /// </summary>
        private static JObject EncodeTrailGeometry(JArray frames, string space)
        {
            using (var stream = new MemoryStream())
            using (var writer = new BinaryWriter(stream))
            {
                writer.Write(0x32475455u); // "UTG2" as little-endian bytes.
                writer.Write((uint)frames.Items.Count);
                foreach (JToken frameToken in frames.Items)
                {
                    var frame = frameToken as JObject
                        ?? throw new System.InvalidOperationException("Trail frame must be an object.");
                    var time = frame.Get("time") as JNumber
                        ?? throw new System.InvalidOperationException("Trail frame is missing time.");
                    var trails = frame.Get("trails") as JArray
                        ?? throw new System.InvalidOperationException("Trail frame is missing trails.");
                    var seeds = frame.Get("trailSeeds") as JArray;
                    if (trails.Items.Count > ushort.MaxValue)
                        throw new System.InvalidOperationException("Trail frame exceeds UInt16 trail capacity.");
                    writer.Write((float)time.Value);
                    writer.Write((ushort)trails.Items.Count);
                    for (int trailIndex = 0; trailIndex < trails.Items.Count; trailIndex++)
                    {
                        JToken trailToken = trails.Items[trailIndex];
                        var trail = trailToken as JArray
                            ?? throw new System.InvalidOperationException("Trail must be an array.");
                        if (trail.Items.Count > ushort.MaxValue)
                            throw new System.InvalidOperationException("Trail exceeds UInt16 point capacity.");
                        writer.Write((ushort)trail.Items.Count);
                        foreach (JToken pointToken in trail.Items)
                        {
                            var point = pointToken as JArray;
                            if (point == null || point.Items.Count < 5)
                                throw new System.InvalidOperationException("Trail point must be [x,y,z,width,alpha].");
                            for (int component = 0; component < 4; component++)
                            {
                                var number = point.Items[component] as JNumber
                                    ?? throw new System.InvalidOperationException("Trail point component must be numeric.");
                                writer.Write((float)number.Value);
                            }
                            var alpha = point.Items[4] as JNumber
                                ?? throw new System.InvalidOperationException("Trail alpha must be numeric.");
                            writer.Write((byte)Mathf.RoundToInt(Mathf.Clamp01((float)alpha.Value) * 255f));
                        }
                        uint seed = uint.MaxValue;
                        if (seeds != null && trailIndex < seeds.Items.Count
                            && seeds.Items[trailIndex] is JNumber seedNumber)
                            seed = (uint)Mathf.Max(0, (float)seedNumber.Value);
                        writer.Write(seed);
                    }
                }
                return new JObject()
                    .Set("schema", "unity-trail-geometry@2")
                    .Set("sampleRate", 60)
                    .Set("space", space)
                    .Set("encoding", "base64-le-f32-u16-alpha8-seed32@1")
                    .Set("frameCount", frames.Items.Count)
                    .Set("payload", System.Convert.ToBase64String(stream.ToArray()));
            }
        }

        private static JObject CaptureTrailGeometryFrame(
            ParticleSystem ps, float elapsed, ParticleSystem.Particle[] liveParticles, int liveCount)
        {
            // Bake Unity's trail topology, then discard the view-facing lateral direction:
            // every two ribbon vertices share one centerline point. Their midpoint and distance
            // are camera-independent position/width data, while colors/UV remain authored.
            var renderer = ps.GetComponent<ParticleSystemRenderer>();
            var mesh = new Mesh();
            renderer.BakeTrailsMesh(mesh, TrailBakeCamera(),
                ParticleSystemBakeMeshOptions.BakePosition |
                ParticleSystemBakeMeshOptions.BakeRotationAndScale);
            Vector3[] vertices = mesh.vertices;
            Color32[] colors = mesh.colors32;
            int[] indices = mesh.triangles;
            int pairCount = vertices.Length / 2;
            var links = new List<HashSet<int>>(pairCount);
            for (int i = 0; i < pairCount; i++) links.Add(new HashSet<int>());
            for (int i = 0; i + 2 < indices.Length; i += 3)
            {
                int a = indices[i] / 2, b = indices[i + 1] / 2, c = indices[i + 2] / 2;
                if (a != b) { links[a].Add(b); links[b].Add(a); }
                if (a != c) { links[a].Add(c); links[c].Add(a); }
                if (b != c) { links[b].Add(c); links[c].Add(b); }
            }
            var trailsJson = new JArray();
            var seedJson = new JArray();
            var assignedSeeds = new HashSet<uint>();
            var seen = new bool[pairCount];
            for (int seed = 0; seed < pairCount; seed++)
            {
                if (seen[seed] || links[seed].Count == 0) continue;
                int start = seed;
                for (int i = seed; i < pairCount; i++)
                    if (!seen[i] && links[i].Count == 1) { start = i; break; }
                var points = new JArray();
                int previous = -1, current = start;
                while (current >= 0 && !seen[current])
                {
                    seen[current] = true;
                    int vi = current * 2;
                    // ParticleSystemRenderer.BakeTrailsMesh returns vertices in world space,
                    // while the semantic trail cache is consumed as emitter-local positions.
                    // Store the explicit inverse transform here; otherwise every ribbon is
                    // matched against particles with a constant root-transform offset.
                    Vector3 centerWorld = (vertices[vi] + vertices[vi + 1]) * 0.5f;
                    Vector3 center = ps.trails.worldSpace
                        ? centerWorld
                        : ps.transform.InverseTransformPoint(centerWorld);
                    float width = Vector3.Distance(vertices[vi], vertices[vi + 1]);
                    Color32 color = colors != null && colors.Length > vi
                        ? colors[vi] : new Color32(255,255,255,255);
                    // Compact tuple: x,y,z,width,alpha. RGB remains live material/particle IR;
                    // width and alpha are topology-dependent TrailModule outputs.
                    points.Add(new JArray()
                        .Add(Q6(center.x)).Add(Q6(center.y)).Add(Q6(-center.z))
                        .Add(Q6(width)).Add(color.a / 255f));
                    int next = -1;
                    foreach (int candidate in links[current])
                        if (candidate != previous && !seen[candidate]) { next = candidate; break; }
                    previous = current;
                    current = next;
                }
                if (points.Items.Count > 1)
                {
                    int best = -1;
                    float bestDistance = float.PositiveInfinity;
                    bool bestFirst = false;
                    var firstPoint = points.Items[0] as JArray;
                    var lastPoint = points.Items[points.Items.Count - 1] as JArray;
                    for (int pi = 0; pi < liveCount; pi++)
                    {
                        var particle = liveParticles[pi];
                        if (assignedSeeds.Contains(particle.randomSeed)) continue;
                        Vector3 p = new Vector3(particle.position.x, particle.position.y, -particle.position.z);
                        if (ps.trails.worldSpace) p = ps.transform.TransformPoint(p);
                        Vector3 first = new Vector3(
                            (float)(firstPoint.Items[0] as JNumber).Value,
                            (float)(firstPoint.Items[1] as JNumber).Value,
                            (float)(firstPoint.Items[2] as JNumber).Value);
                        Vector3 last = new Vector3(
                            (float)(lastPoint.Items[0] as JNumber).Value,
                            (float)(lastPoint.Items[1] as JNumber).Value,
                            (float)(lastPoint.Items[2] as JNumber).Value);
                        float df = Vector3.SqrMagnitude(p - first);
                        float dl = Vector3.SqrMagnitude(p - last);
                        float d = Mathf.Min(df, dl);
                        if (d < bestDistance) { bestDistance = d; best = pi; bestFirst = df < dl; }
                    }
                    if (best >= 0)
                    {
                        uint seedValue = liveParticles[best].randomSeed;
                        assignedSeeds.Add(seedValue);
                        if (bestFirst)
                        {
                            var reversed = new JArray();
                            for (int pointIndex = points.Items.Count - 1; pointIndex >= 0; pointIndex--)
                                reversed.Add(points.Items[pointIndex]);
                            points = reversed;
                        }
                        seedJson.Add((double)seedValue);
                    }
                    else seedJson.Add((double)uint.MaxValue);
                    trailsJson.Add(points);
                }
            }
            Object.DestroyImmediate(mesh);
            return new JObject()
                .Set("time", elapsed)
                .Set("trails", trailsJson)
                .Set("trailSeeds", seedJson);
        }

        public static bool NeedsTrajectoryCache(ParticleSystem ps)
        {
            if (ps == null) return false;
            var main = ps.main;
            bool stochasticStart = main.startDelay.mode == ParticleSystemCurveMode.TwoCurves
                || main.startLifetime.mode == ParticleSystemCurveMode.TwoCurves
                || main.startSpeed.mode == ParticleSystemCurveMode.TwoCurves
                || main.gravityModifier.mode == ParticleSystemCurveMode.TwoCurves
                || main.startSize.mode == ParticleSystemCurveMode.TwoCurves
                || main.startRotation.mode == ParticleSystemCurveMode.TwoCurves
                || main.startRotationX.mode == ParticleSystemCurveMode.TwoCurves
                || main.startRotationY.mode == ParticleSystemCurveMode.TwoCurves
                || main.startRotationZ.mode == ParticleSystemCurveMode.TwoCurves;
            var size = ps.sizeOverLifetime;
            var rotation = ps.rotationOverLifetime;
            var colorLife = ps.colorOverLifetime;
            var colorSpeed = ps.colorBySpeed;
            bool stochasticSize = size.enabled && !size.separateAxes
                && size.size.mode == ParticleSystemCurveMode.TwoCurves;
            bool stochasticRotation3D = rotation.enabled && rotation.separateAxes
                && (rotation.x.mode == ParticleSystemCurveMode.TwoCurves
                    || rotation.y.mode == ParticleSystemCurveMode.TwoCurves
                    || rotation.z.mode == ParticleSystemCurveMode.TwoCurves);
            var velocity = ps.velocityOverLifetime;
            bool stochasticVelocity = velocity.enabled
                && (IsStochasticVelocityLane(velocity.x)
                    || IsStochasticVelocityLane(velocity.y)
                    || IsStochasticVelocityLane(velocity.z));
            bool orbitalVelocity = velocity.enabled && HasOrbitalVelocity(velocity);
            bool stochasticColor = (colorLife.enabled && IsStochasticGradient(colorLife.color))
                || (colorSpeed.enabled && IsStochasticGradient(colorSpeed.color));
            bool randomDirection = ps.shape.enabled && ps.shape.randomDirectionAmount > 1e-6f;
            var custom = ps.customData;
            bool stochasticCustom = custom.enabled
                && (HasTwoCurves(custom, ParticleSystemCustomData.Custom1)
                    || HasTwoCurves(custom, ParticleSystemCustomData.Custom2));
            bool collisionState = ps.collision.enabled && !IsEmptyCollisionPlaneSet(ps.collision);
            bool gravityState = ps.main.gravityModifier.mode != ParticleSystemCurveMode.Constant
                || Mathf.Abs(ps.main.gravityModifier.constant) > 1e-6f;
            return stochasticStart || ps.noise.enabled || ps.forceOverLifetime.enabled || gravityState
                || collisionState || stochasticSize || stochasticVelocity || orbitalVelocity
                || stochasticRotation3D || stochasticColor || randomDirection || stochasticCustom;
        }

        private static bool HasOrbitalVelocity(ParticleSystem.VelocityOverLifetimeModule velocity) =>
            !IsConstantZero(velocity.orbitalX)
            || !IsConstantZero(velocity.orbitalY)
            || !IsConstantZero(velocity.orbitalZ)
            || !IsConstantZero(velocity.radial)
            || !IsConstantOne(velocity.speedModifier);

        private static bool IsConstantOne(ParticleSystem.MinMaxCurve curve)
        {
            if (curve.mode == ParticleSystemCurveMode.Constant)
                return Mathf.Approximately(curve.constant, 1f);
            if (curve.mode == ParticleSystemCurveMode.TwoConstants)
                return Mathf.Approximately(curve.constantMin, 1f)
                    && Mathf.Approximately(curve.constantMax, 1f);
            return false;
        }

        private static bool IsStochasticVelocityLane(ParticleSystem.MinMaxCurve curve) =>
            curve.mode == ParticleSystemCurveMode.TwoConstants
            || curve.mode == ParticleSystemCurveMode.TwoCurves;

        private static bool IsEmptyCollisionPlaneSet(ParticleSystem.CollisionModule collision)
        {
            if (collision.type != ParticleSystemCollisionType.Planes) return false;
            for (int i = 0; i < 6; i++) if (collision.GetPlane(i) != null) return false;
            return true;
        }

        private static bool IsStochasticGradient(ParticleSystem.MinMaxGradient gradient) =>
            gradient.mode == ParticleSystemGradientMode.TwoColors
            || gradient.mode == ParticleSystemGradientMode.TwoGradients
            || gradient.mode == ParticleSystemGradientMode.RandomColor;

        private static bool HasTwoCurves(ParticleSystem.CustomDataModule custom,
            ParticleSystemCustomData stream)
        {
            if (custom.GetMode(stream) != ParticleSystemCustomDataMode.Vector) return false;
            for (int component = 0; component < 4; component++)
                if (custom.GetVector(stream, component).mode == ParticleSystemCurveMode.TwoCurves)
                    return true;
            return false;
        }

        private static JObject BuildTrajectorySample(ParticleSystem ps,
            ParticleSystemRenderer renderer, ParticleSystem.Particle particle,
            int frame, Vector4? custom1, Vector4? custom2)
        {
            float age = Mathf.Max(0, particle.startLifetime - particle.remainingLifetime);
            var sample = new JObject()
                .Set("age", age)
                .Set("position", Vec3Rh(particle.position))
                .Set("velocity", Vec3Rh(particle.velocity))
                .Set("size", Vec3(particle.GetCurrentSize3D(ps)));
            if (frame >= 0) sample.Set("frame", frame);
            Color32 currentColor = particle.GetCurrentColor(ps);
            sample.Set("color", new JArray().Add(currentColor.r / 255f)
                .Add(currentColor.g / 255f).Add(currentColor.b / 255f).Add(currentColor.a / 255f));
            if (custom1.HasValue)
            {
                Vector4 c = custom1.Value;
                sample.Set("custom1", new JArray().Add(c.x).Add(c.y).Add(c.z).Add(c.w));
            }
            if (custom2.HasValue)
            {
                Vector4 c = custom2.Value;
                sample.Set("custom2", new JArray().Add(c.x).Add(c.y).Add(c.z).Add(c.w));
            }
            if (IsLocalAlignedBillboard(renderer))
            {
                Quaternion q = Quaternion.AngleAxis(-particle.rotation, Vector3.forward);
                if (ps.main.simulationSpace == ParticleSystemSimulationSpace.World)
                    q = renderer.transform.rotation * q;
                sample.Set("rotation", new JArray().Add(-q.x).Add(-q.y).Add(q.z).Add(q.w));
            }
            else if (UsesQuaternionParticleRotation(renderer))
            {
                Quaternion q = Quaternion.Euler(particle.rotation3D);
                if (ps.main.simulationSpace == ParticleSystemSimulationSpace.World)
                    q = ps.transform.rotation * q;
                sample.Set("rotation", new JArray().Add(-q.x).Add(-q.y).Add(q.z).Add(q.w));
            }
            else
            {
                sample.Set("rotation", -particle.rotation * Mathf.Deg2Rad);
            }
            return sample;
        }

        private static bool HasParticleAncestor(Transform transform, Transform root)
        {
            for (Transform p = transform.parent; p != null && p != root.parent; p = p.parent)
                if (p.GetComponent<ParticleSystem>() != null) return true;
            return false;
        }

        private static JArray CaptureDeterministicInitialState(ParticleSystem ps, ParticleSystemRenderer renderer)
        {
            const float epsilon = 0.0001f;
            ps.Stop(false, ParticleSystemStopBehavior.StopEmittingAndClear);
            ps.Simulate(epsilon, false, true, false);
            var particles = new ParticleSystem.Particle[Mathf.Max(1, ps.main.maxParticles)];
            int count = ps.GetParticles(particles);
            int[] frames = CaptureCurrentFrames(ps, renderer, count);
            var result = new JArray();
            var seenSeeds = new HashSet<uint>();
            for (int i = 0; i < count; i++)
            {
                seenSeeds.Add(particles[i].randomSeed);
                result.Add(BuildInitialState(ps, renderer, particles[i],
                    frames != null && i < frames.Length ? frames[i] : -1, 0f, epsilon));
            }

            // Delayed/burst emitters have no particles at epsilon. Sample their birth stream at
            // a high-frequency semantic probe and retain each randomSeed once, in emission order.
            // This captures spawn initialization only; lifetime simulation remains live on Web.
            if (count == 0)
            {
                // Match the runtime/oracle fixed-step contract. Unity consumes module RNG lanes
                // during simulation ticks, so probing at a finer delta changes later spawn seeds.
                const float probeStep = 1f / 60f;
                float horizon = Mathf.Max(ps.main.duration + ps.main.startDelay.constantMax, 0.5f);
                int steps = Mathf.CeilToInt(horizon / probeStep);
                float elapsed = epsilon;
                var rotationOrigins = new Dictionary<uint, Vector3>();
                var rotationOriginAges = new Dictionary<uint, float>();
                var rotationStates = new Dictionary<uint, JObject>();
                var calibratedRotation = new HashSet<uint>();
                for (int stepIndex = 0; stepIndex < steps && seenSeeds.Count < ps.main.maxParticles; stepIndex++)
                {
                    ps.Simulate(probeStep, false, false, false);
                    elapsed += probeStep;
                    count = ps.GetParticles(particles);
                    int[] probeFrames = CaptureCurrentFrames(ps, renderer, count);
                    for (int i = 0; i < count; i++)
                    {
                        uint seed = particles[i].randomSeed;
                        if (calibratedRotation.Contains(seed)
                            || !rotationOrigins.TryGetValue(seed, out Vector3 origin)
                            || !rotationOriginAges.TryGetValue(seed, out float originAge)
                            || !rotationStates.TryGetValue(seed, out JObject rotationState)) continue;
                        float currentAge = particles[i].startLifetime - particles[i].remainingLifetime;
                        if (currentAge - originAge < 0.08f) continue;
                        CalibrateRotationCurveLerps(ps, particles[i], origin, originAge, rotationState);
                        calibratedRotation.Add(seed);
                    }
                    var bornThisStep = new List<KeyValuePair<ParticleSystem.Particle, int>>();
                    for (int i = 0; i < count; i++)
                    {
                        if (!seenSeeds.Add(particles[i].randomSeed)) continue;
                        int frame = probeFrames != null && i < probeFrames.Length
                            ? probeFrames[i]
                            : -1;
                        bornThisStep.Add(new KeyValuePair<ParticleSystem.Particle, int>(particles[i], frame));
                    }
                    // Unity's GetParticles storage can swap entries as particles die. Within a
                    // probe tick, older age means earlier continuous-emission order.
                    bornThisStep.Sort((a, b) =>
                        (b.Key.startLifetime - b.Key.remainingLifetime)
                            .CompareTo(a.Key.startLifetime - a.Key.remainingLifetime));
                    foreach (var bornWithFrame in bornThisStep)
                    {
                        ParticleSystem.Particle born = bornWithFrame.Key;
                        float age = Mathf.Max(0, born.startLifetime - born.remainingLifetime);
                        JObject state = BuildInitialState(ps, renderer, born, bornWithFrame.Value,
                            elapsed - age, elapsed);
                        result.Add(state);
                        if (ps.rotationOverLifetime.enabled && ps.rotationOverLifetime.separateAxes)
                        {
                            rotationOrigins[born.randomSeed] = born.rotation3D;
                            rotationOriginAges[born.randomSeed] = age;
                            rotationStates[born.randomSeed] = state;
                        }
                    }
                }
            }
            ps.Stop(false, ParticleSystemStopBehavior.StopEmittingAndClear);
            return result;
        }

        private static JObject BuildInitialState(ParticleSystem ps, ParticleSystemRenderer renderer,
            ParticleSystem.Particle p, int frame, float spawnTime, float firstObservedTime,
            string particleId = null)
        {
            float age = Mathf.Max(0, p.startLifetime - p.remainingLifetime);
            // The deterministic schedule emits on Unity's first-observed fixed tick, not at the
            // inferred continuous birth time. Seed position from that same observed tick; back-
            // extrapolating by velocity while delaying visibility makes trajectory-less systems
            // one whole fixed step ahead (most visible on long mesh shafts).
            Vector3 initialPosition = p.position;
            Vector3 size = p.GetCurrentSize3D(ps);
            Vector3 authoredStartSize = p.startSize3D;
            // Lifetime color is evaluated again by the live behavior. Persist the authored
            // per-particle start color, not the already-multiplied current color from the probe.
            Color32 color = p.startColor;
            JToken rotation;
            JToken rotationBase = null;
            JToken stateRotationEuler = null;
            if (IsLocalAlignedBillboard(renderer))
            {
                float angle = -p.rotation * Mathf.Deg2Rad;
                Quaternion localRotation = Quaternion.AngleAxis(-p.rotation, Vector3.forward);
                Quaternion q = localRotation;
                if (ps.main.simulationSpace == ParticleSystemSimulationSpace.World)
                {
                    Quaternion baseRotation = renderer.transform.rotation;
                    q = baseRotation * localRotation;
                    rotationBase = new JArray().Add(-baseRotation.x).Add(-baseRotation.y)
                        .Add(baseRotation.z).Add(baseRotation.w);
                }
                rotation = new JArray().Add(-q.x).Add(-q.y).Add(q.z).Add(q.w);
                stateRotationEuler = new JArray().Add(0f).Add(0f).Add(angle);
            }
            else if (UsesQuaternionParticleRotation(renderer))
            {
                Vector3 rotationEulerRadians = p.rotation3D * Mathf.Deg2Rad;
                Quaternion localRotation = Quaternion.Euler(p.rotation3D);
                Quaternion q = localRotation;
                // Unity world-space particles keep their spawn orientation in world space.
                // Quarks deliberately skips emitter.matrixWorld for world-space batches, so
                // preserve the emitter's world rotation as an explicit quaternion operand.
                if (ps.main.simulationSpace == ParticleSystemSimulationSpace.World)
                {
                    Quaternion baseRotation = ps.transform.rotation;
                    q = baseRotation * localRotation;
                    rotationBase = new JArray().Add(-baseRotation.x).Add(-baseRotation.y)
                        .Add(baseRotation.z).Add(baseRotation.w);
                }
                rotation = new JArray().Add(-q.x).Add(-q.y).Add(q.z).Add(q.w);
                stateRotationEuler = new JArray().Add(-rotationEulerRadians.x)
                    .Add(-rotationEulerRadians.y).Add(rotationEulerRadians.z);
            }
            else rotation = -p.rotation * Mathf.Deg2Rad;
            var state = new JObject()
                .Set("position", Vec3Rh(initialPosition))
                .Set("velocity", Vec3Rh(p.velocity))
                .Set("size", Vec3(size))
                .Set("baseSize", Vec3(authoredStartSize))
                .Set("color", new JArray().Add(color.r / 255f).Add(color.g / 255f)
                    .Add(color.b / 255f).Add(color.a / 255f))
                .Set("life", p.startLifetime)
                .Set("spawnAgeOffset", age)
                // Absolute time on the root effect clock. This is required for nested/sub
                // emitters: their Quarks system clock is local to each trigger, while Unity's
                // lifetime/trajectory state is evaluated on the hierarchy simulation clock.
                .Set("globalSpawnTime", Mathf.Max(0, spawnTime))
                // Unity updates nested particle systems at discrete hierarchy ticks. A particle
                // may have an inferred continuous birth time before the tick on which it first
                // exists in GetParticles. Preserve both: globalSpawnTime drives lifetime curves;
                // scheduleTime drives discrete visibility/emission ordering.
                .Set("scheduleTime", Mathf.Max(0,
                    // Serialize the closed tick boundary robustly across float (Unity) and
                    // double (JavaScript) clocks without crossing into the previous 60 Hz tick.
                    firstObservedTime - ConstantOf(ps.main.startDelay) - 1e-6f))
                // Web gates startDelay outside the Quarks system and restarts its local clock;
                // birth times in the spawn stream are therefore relative to that gated clock.
                .Set("spawnTime", Mathf.Max(0, spawnTime - ConstantOf(ps.main.startDelay)))
                .Set("rotation", rotation)
                .Set("frame", frame)
                .Set("seed", (double)p.randomSeed);
            if (CapturedRendererFlips.TryGetValue(FlipKey(ps, p.randomSeed), out bool[] flip))
                state.Set("rendererFlip", new JArray().Add(flip[0]).Add(flip[1]));
            state.Set("particleId", particleId ?? $"{p.randomSeed}:0");
            if (stateRotationEuler != null) state.Set("rotationEulerRadians", stateRotationEuler);
            if (rotationBase != null) state.Set("rotationBase", rotationBase);
            var sizeLife = ps.sizeOverLifetime;
            if (sizeLife.enabled && !sizeLife.separateAxes
                && sizeLife.size.mode == ParticleSystemCurveMode.TwoCurves)
            {
                float t = p.startLifetime > 1e-6f ? age / p.startLifetime : 0f;
                float min = sizeLife.size.curveMin.Evaluate(t) * sizeLife.size.curveMultiplier;
                float max = sizeLife.size.curveMax.Evaluate(t) * sizeLife.size.curveMultiplier;
                float baseScalar = Mathf.Abs(authoredStartSize.x) > 1e-6f ? authoredStartSize.x : 1f;
                float sampled = size.x / baseScalar;
                float lerp = Mathf.Abs(max - min) > 1e-6f ? (sampled - min) / (max - min) : 0f;
                state.Set("sizeCurveLerp", Mathf.Clamp01(lerp));
            }
            var rotationLife = ps.rotationOverLifetime;
            if (rotationLife.enabled && rotationLife.separateAxes)
            {
                float t = p.startLifetime > 1e-6f ? age / p.startLifetime : 0f;
                // Particle.angularVelocity3D is exposed in degrees/sec and uses Unity's
                // clockwise Z convention, while MinMaxCurve values are radians/sec.
                Vector3 sampledAngularVelocity = p.angularVelocity3D * Mathf.Deg2Rad;
                sampledAngularVelocity.z = -sampledAngularVelocity.z;
                state.Set("rotationCurveLerp", new JArray()
                    .Add(InferCurveLerp(rotationLife.x, t, sampledAngularVelocity.x))
                    .Add(InferCurveLerp(rotationLife.y, t, sampledAngularVelocity.y))
                    .Add(InferCurveLerp(rotationLife.z, t, sampledAngularVelocity.z)));
            }
            return state;
        }

        private static bool UsesQuaternionParticleRotation(ParticleSystemRenderer renderer) =>
            renderer != null && (renderer.renderMode == ParticleSystemRenderMode.Mesh
                || (renderer.renderMode == ParticleSystemRenderMode.Billboard
                    && renderer.alignment == ParticleSystemRenderSpace.Local));

        private static bool IsLocalAlignedBillboard(ParticleSystemRenderer renderer) =>
            renderer != null && renderer.renderMode == ParticleSystemRenderMode.Billboard
                && renderer.alignment == ParticleSystemRenderSpace.Local;

        private static float InferCurveLerp(ParticleSystem.MinMaxCurve curve, float t, float sampled)
        {
            if (curve.mode != ParticleSystemCurveMode.TwoCurves) return 0f;
            float min = curve.curveMin.Evaluate(t) * curve.curveMultiplier;
            float max = curve.curveMax.Evaluate(t) * curve.curveMultiplier;
            return Mathf.Abs(max - min) > 1e-6f ? Mathf.Clamp01((sampled - min) / (max - min)) : 0f;
        }

        private static void CalibrateRotationCurveLerps(ParticleSystem ps,
            ParticleSystem.Particle current, Vector3 originEulerDegrees, float originAge, JObject state)
        {
            var module = ps.rotationOverLifetime;
            float endAge = current.startLifetime - current.remainingLifetime;
            Vector3 deltaDegrees = current.rotation3D - originEulerDegrees;
            deltaDegrees.x = Mathf.DeltaAngle(0, deltaDegrees.x);
            deltaDegrees.y = Mathf.DeltaAngle(0, deltaDegrees.y);
            deltaDegrees.z = Mathf.DeltaAngle(0, deltaDegrees.z);
            float fx = InferIntegratedCurveLerp(module.x, originAge, endAge, current.startLifetime,
                deltaDegrees.x * Mathf.Deg2Rad);
            float fy = InferIntegratedCurveLerp(module.y, originAge, endAge, current.startLifetime,
                deltaDegrees.y * Mathf.Deg2Rad);
            float fz = InferIntegratedCurveLerp(module.z, originAge, endAge, current.startLifetime,
                deltaDegrees.z * Mathf.Deg2Rad);
            state.Set("rotationCurveLerp", new JArray().Add(fx).Add(fy).Add(fz));

            // The first probe observes a particle a fraction of a frame after birth. Rewind that
            // already-applied lifetime rotation so Web integration starts from the real birth pose.
            Vector3 birthEuler = originEulerDegrees;
            birthEuler.x -= IntegrateTwoCurves(module.x, 0, originAge, current.startLifetime, fx) * Mathf.Rad2Deg;
            birthEuler.y -= IntegrateTwoCurves(module.y, 0, originAge, current.startLifetime, fy) * Mathf.Rad2Deg;
            birthEuler.z -= IntegrateTwoCurves(module.z, 0, originAge, current.startLifetime, fz) * Mathf.Rad2Deg;
            state.Set("rotationEulerRadians", new JArray()
                .Add(-birthEuler.x * Mathf.Deg2Rad).Add(-birthEuler.y * Mathf.Deg2Rad)
                .Add(birthEuler.z * Mathf.Deg2Rad));
        }

        private static float InferIntegratedCurveLerp(ParticleSystem.MinMaxCurve curve,
            float startAge, float endAge, float life, float observedRadians)
        {
            if (curve.mode != ParticleSystemCurveMode.TwoCurves || life <= 1e-6f) return 0f;
            const int samples = 16;
            float minIntegral = 0f, maxIntegral = 0f;
            float dt = (endAge - startAge) / samples;
            for (int i = 0; i < samples; i++)
            {
                float age = startAge + (i + 0.5f) * dt;
                float t = Mathf.Clamp01(age / life);
                minIntegral += curve.curveMin.Evaluate(t) * curve.curveMultiplier * dt;
                maxIntegral += curve.curveMax.Evaluate(t) * curve.curveMultiplier * dt;
            }
            return Mathf.Abs(maxIntegral - minIntegral) > 1e-6f
                ? Mathf.Clamp01((observedRadians - minIntegral) / (maxIntegral - minIntegral)) : 0f;
        }

        private static float IntegrateTwoCurves(ParticleSystem.MinMaxCurve curve,
            float startAge, float endAge, float life, float factor)
        {
            if (life <= 1e-6f || endAge <= startAge) return 0f;
            const int samples = 16;
            float integral = 0f;
            float dt = (endAge - startAge) / samples;
            for (int i = 0; i < samples; i++)
            {
                float t = Mathf.Clamp01((startAge + (i + 0.5f) * dt) / life);
                float min = curve.curveMin.Evaluate(t) * curve.curveMultiplier;
                float max = curve.curveMax.Evaluate(t) * curve.curveMultiplier;
                integral += Mathf.Lerp(min, max, factor) * dt;
            }
            return integral;
        }

        private static int[] CaptureCurrentFrames(ParticleSystem ps, ParticleSystemRenderer renderer, int count)
        {
            if (DisableTrajectoryBake) return null;
            var tsa = ps.textureSheetAnimation;
            // A trajectory cache is an exact state backend: capture the rendered atlas cell for
            // both Lifetime and Speed modes. Re-evaluating even a deterministic lifetime curve
            // on Web can cross a discrete frame boundary because Unity exposes particles only
            // after its fixed simulation tick.
            if (count == 0)
                return null;
            GameObject cameraObject = new GameObject("Quarks UV Bake Camera");
            Mesh baked = new Mesh();
            Mesh unflipped = new Mesh();
            try
            {
                Camera camera = cameraObject.AddComponent<Camera>();
                camera.transform.position = new Vector3(2.15f, 1.55f, 4.55f);
                camera.transform.LookAt(new Vector3(0, 0.95f, 0));
                renderer.BakeMesh(baked, camera, false);
                Vector2[] uv = baked.uv;
                if (uv == null || uv.Length < count) return null;
                int stride = uv.Length / count;
                if (stride <= 0) return null;
                Vector3 authoredFlip = renderer.flip;
                bool fractionalFlip = authoredFlip.x > 0f && authoredFlip.x < 1f
                    || authoredFlip.y > 0f && authoredFlip.y < 1f;
                if (fractionalFlip)
                {
                    try
                    {
                        renderer.flip = Vector3.zero;
                        renderer.BakeMesh(unflipped, camera, false);
                    }
                    finally { renderer.flip = authoredFlip; }
                    Vector2[] baseUv = unflipped.uv;
                    var particles = new ParticleSystem.Particle[Mathf.Max(1, ps.main.maxParticles)];
                    int particleCount = ps.GetParticles(particles);
                    if (baseUv != null && baseUv.Length == uv.Length && particleCount >= count)
                    {
                        for (int i = 0; i < count; i++)
                        {
                            int n = Mathf.Min(stride, uv.Length - i * stride);
                            float minU = float.PositiveInfinity, maxU = float.NegativeInfinity;
                            float minV = float.PositiveInfinity, maxV = float.NegativeInfinity;
                            for (int k = 0; k < n; k++)
                            {
                                Vector2 value = baseUv[i * stride + k];
                                minU = Mathf.Min(minU, value.x); maxU = Mathf.Max(maxU, value.x);
                                minV = Mathf.Min(minV, value.y); maxV = Mathf.Max(maxV, value.y);
                            }
                            float identityX = 0f, reflectedX = 0f, identityY = 0f, reflectedY = 0f;
                            for (int k = 0; k < n; k++)
                            {
                                Vector2 source = baseUv[i * stride + k];
                                Vector2 actual = uv[i * stride + k];
                                identityX += Mathf.Abs(actual.x - source.x);
                                reflectedX += Mathf.Abs(actual.x - (minU + maxU - source.x));
                                identityY += Mathf.Abs(actual.y - source.y);
                                reflectedY += Mathf.Abs(actual.y - (minV + maxV - source.y));
                            }
                            CapturedRendererFlips[FlipKey(ps, particles[i].randomSeed)] = new[]
                            {
                                reflectedX + 1e-5f < identityX,
                                reflectedY + 1e-5f < identityY,
                            };
                        }
                    }
                }
                if (!tsa.enabled) return null;
                int uCount = Mathf.Max(1, tsa.numTilesX);
                int vCount = Mathf.Max(1, tsa.numTilesY);
                var frames = new int[count];
                for (int i = 0; i < count; i++)
                {
                    Vector2 center = Vector2.zero;
                    int n = Mathf.Min(stride, uv.Length - i * stride);
                    for (int k = 0; k < n; k++) center += uv[i * stride + k];
                    center /= Mathf.Max(1, n);
                    int col = Mathf.Clamp(Mathf.FloorToInt(center.x * uCount), 0, uCount - 1);
                    int rowBottom = Mathf.Clamp(Mathf.FloorToInt(center.y * vCount), 0, vCount - 1);
                    frames[i] = (vCount - 1 - rowBottom) * uCount + col;
                }
                return frames;
            }
            finally
            {
                Object.DestroyImmediate(baked);
                Object.DestroyImmediate(unflipped);
                Object.DestroyImmediate(cameraObject);
            }
        }

        private static void AddRotationOverLife(ParticleSystem ps, JObject particleIr, JArray behaviors,
            bool quaternionBillboard = false, bool verticalBillboard = false)
        {
            var m = ps.rotationOverLifetime;
            if (!m.enabled) return;
            if (m.separateAxes || quaternionBillboard)
            {
                particleIr.Set("unityRotationOverLifetime3D", new JObject()
                    // ParticleSystemModule exposes angular values in radians; preserve them.
                    .Set("x", quaternionBillboard && !m.separateAxes ? ValueConverter.Constant(0)
                        : CurveForSemanticRotation(m.x, "rotationOverLifetime.x"))
                    .Set("y", quaternionBillboard && !m.separateAxes ? ValueConverter.Constant(0)
                        : CurveForSemanticRotation(m.y, "rotationOverLifetime.y"))
                    // Unity LH → Web RH flips X/Y angular axes, while Z retains handedness.
                    .Set("z", CurveForSemanticRotation(m.z, "rotationOverLifetime.z",
                        quaternionBillboard ? -1f : 1f)));
                return;
            }
            // ParticleSystemModule exposes rotation-over-lifetime in radians/sec. Quarks also
            // integrates radians/sec, so no Deg2Rad conversion is permitted here. Billboard
            // rotation changes sign under Unity LH → Web RH, matching the captured start angle.
            behaviors.Add(new JObject()
                .Set("type", "RotationOverLife")
                .Set("angularVelocity", ScaleCurve(m.z, verticalBillboard ? 1f : -1f)));
        }

        private static JToken CurveForSemanticRotation(ParticleSystem.MinMaxCurve curve, string lane,
            float scale = 1f)
        {
            if (curve.mode == ParticleSystemCurveMode.TwoCurves)
                return ValueConverter.TwoCurves(curve, lane, scale);
            return Mathf.Approximately(scale, 1f) ? ValueConverter.Curve(curve) : ScaleCurve(curve, scale);
        }

        private static void AddVelocityOverLife(ParticleSystem ps, JObject particleIr)
        {
            var m = ps.velocityOverLifetime;
            if (!m.enabled) return;
            particleIr.Set("unityVelocityOverLifetime", new JObject()
                .Set("schema", "unity-velocity-over-lifetime@1")
                .Set("linearX", CurveForSemanticVelocity(m.x, "velocityOverLifetime.x"))
                .Set("linearY", CurveForSemanticVelocity(m.y, "velocityOverLifetime.y"))
                .Set("linearZ", CurveForSemanticVelocity(m.z, "velocityOverLifetime.z"))
                .Set("space", m.space == ParticleSystemSimulationSpace.World ? "world" : "local"));
        }

        private static JToken CurveForSemanticVelocity(ParticleSystem.MinMaxCurve curve, string lane) =>
            curve.mode == ParticleSystemCurveMode.TwoCurves
                ? ValueConverter.TwoCurves(curve, lane)
                : ValueConverter.Curve(curve);

        private static void AddLimitVelocity(ParticleSystem ps, JObject particleIr, JArray behaviors)
        {
            var m = ps.limitVelocityOverLifetime;
            if (!m.enabled) return;
            if (m.separateAxes)
            {
                particleIr.Set("unityLimitVelocity3D", new JObject()
                    .Set("schema", "unity-limit-velocity-3d@1")
                    .Set("x", ValueConverter.Curve(m.limitX))
                    .Set("y", ValueConverter.Curve(m.limitY))
                    .Set("z", ValueConverter.Curve(m.limitZ))
                    .Set("dampen", m.dampen)
                    .Set("space", m.space == ParticleSystemSimulationSpace.World ? "world" : "local"));
                return;
            }
            particleIr.Set("unityLimitVelocity", new JObject()
                .Set("schema", "unity-limit-velocity@1")
                .Set("speed", ValueConverter.Curve(m.limit))
                .Set("dampen", m.dampen));
        }

        private static void AddForceOverLife(ParticleSystem ps, JArray behaviors)
        {
            var m = ps.forceOverLifetime;
            if (!m.enabled) return;
            behaviors.Add(new JObject()
                .Set("type", "ForceOverLife")
                .Set("x", ValueConverter.Curve(m.x))
                .Set("y", ValueConverter.Curve(m.y))
                .Set("z", ValueConverter.Curve(m.z)));
        }

        private static void AddNoise(ParticleSystem ps, JObject particleIr, JArray behaviors)
        {
            var m = ps.noise;
            if (!m.enabled) return;
            particleIr.Set("unityNoiseLowering", new JObject()
                .Set("schema", "particle-trajectory-cache@5")
                .Set("backend", "unity-sampled-60hz-state@1")
                .Set("quality", m.quality.ToString())
                .Set("octaves", m.octaveCount)
                .Set("damping", m.damping));
            behaviors.Add(new JObject()
                .Set("type", "Noise")
                .Set("frequency", ValueConverter.Constant(m.frequency))
                .Set("power", ValueConverter.Curve(m.strength))
                .Set("positionAmount", ValueConverter.Constant(1))
                .Set("rotationAmount", ValueConverter.Constant(0)));
        }

        private static void AddInheritVelocity(ParticleSystem ps, JArray behaviors)
        {
            var m = ps.inheritVelocity;
            if (!m.enabled) return;
            behaviors.Add(new JObject()
                .Set("type", "InheritVelocity")
                .Set("multiplier", ValueConverter.Curve(m.curve))
                .Set("mode", m.mode == ParticleSystemInheritVelocityMode.Current ? "current" : "initial"));
        }

        private static void AddRandomizeDirection(ParticleSystem ps, JArray behaviors)
        {
            var shape = ps.shape;
            if (!shape.enabled || shape.randomDirectionAmount <= 0f) return;
            // Unity's randomDirectionAmount is a 0..1 blend; map to a 0..π scatter angle.
            behaviors.Add(new JObject()
                .Set("type", "ChangeEmitDirection")
                .Set("angle", ValueConverter.Constant(shape.randomDirectionAmount * Mathf.PI)));
        }

        private static void AddColorBySpeed(ParticleSystem ps, JArray behaviors)
        {
            var m = ps.colorBySpeed;
            if (!m.enabled) return;
            behaviors.Add(new JObject()
                .Set("type", "ColorBySpeed")
                .Set("color", ValueConverter.StartColorGradient(m.color))
                .Set("speedRange", SpeedRange(m.range)));
        }

        private static void AddSizeBySpeed(ParticleSystem ps, JArray behaviors)
        {
            var m = ps.sizeBySpeed;
            if (!m.enabled) return;
            var curve = m.separateAxes ? m.x : m.size;
            behaviors.Add(new JObject()
                .Set("type", "SizeBySpeed")
                .Set("size", ValueConverter.Curve(curve))
                .Set("speedRange", SpeedRange(m.range)));
        }

        private static void AddRotationBySpeed(ParticleSystem ps, JArray behaviors)
        {
            var m = ps.rotationBySpeed;
            if (!m.enabled) return;
            behaviors.Add(new JObject()
                .Set("type", "RotationBySpeed")
                .Set("angularVelocity", ScaleCurve(m.z, Mathf.Deg2Rad))
                .Set("speedRange", SpeedRange(m.range)));
        }

        private static void AddCollision(ParticleSystem ps, JObject particleIr, JArray behaviors)
        {
            var m = ps.collision;
            if (!m.enabled) return;
            if (m.type == ParticleSystemCollisionType.Planes)
            {
                bool anyPlane = false;
                for (int i = 0; i < 6; i++)
                    if (m.GetPlane(i) != null) { anyPlane = true; break; }
                if (!anyPlane)
                {
                    particleIr.Set("sceneQuery", new JObject()
                        .Set("schema", "particle-scene-query@1")
                        .Set("provider", "none")
                        .Set("shape", "empty-plane-set"));
                    return;
                }
            }
            particleIr.Set("sceneQuery", new JObject()
                .Set("schema", "particle-scene-query@1")
                .Set("provider", "reference-ground-plane@1")
                .Set("shape", "plane").Set("normal", Vec3(0, 1, 0)).Set("constant", 0));
            // quarks ApplyCollision resolves against a host-provided collider; only `bounce` is
            // portable (the plane/world colliders themselves aren't part of the effect JSON).
            behaviors.Add(new JObject()
                .Set("type", "ApplyCollision")
                .Set("bounce", ConstantOf(m.bounce)));
        }

        private static JToken SpeedRange(Vector2 range) => ValueConverter.Interval(range.x, range.y);

        private static void AddSubEmitters(ParticleSystem ps, ExportContext ctx, JArray behaviors)
        {
            var m = ps.subEmitters;
            if (!m.enabled) return;
            for (int i = 0; i < m.subEmittersCount; i++)
            {
                ParticleSystem sub = m.GetSubEmitterSystem(i);
                string uuid = ctx.GetNodeUuid(sub);
                if (sub == null || uuid == null) continue;
                ParticleSystemSubEmitterProperties properties = m.GetSubEmitterProperties(i);
                behaviors.Add(new JObject()
                    .Set("type", "EmitSubParticleSystem")
                    .Set("subParticleSystem", uuid)
                    .Set("useVelocityAsBasis", false)
                    .Set("mode", MapSubEmitMode(m.GetSubEmitterType(i)))
                    .Set("emitProbability", m.GetSubEmitterEmitProbability(i))
                    .Set("unityInheritance", new JObject()
                        .Set("schema", "unity-sub-emitter-inheritance@1")
                        .Set("size", (properties & ParticleSystemSubEmitterProperties.InheritSize) != 0)
                        .Set("color", (properties & ParticleSystemSubEmitterProperties.InheritColor) != 0)
                        .Set("rotation", (properties & ParticleSystemSubEmitterProperties.InheritRotation) != 0)
                        .Set("lifetime", (properties & ParticleSystemSubEmitterProperties.InheritLifetime) != 0)));
            }
        }

        // ---- helpers ---------------------------------------------------------------------

        private static int MapSubEmitMode(ParticleSystemSubEmitterType type)
        {
            // quarks SubParticleEmitMode: Death=0, Birth=1, Frame=2
            switch (type)
            {
                case ParticleSystemSubEmitterType.Birth: return 1;
                case ParticleSystemSubEmitterType.Death: return 0;
                default: return 2;
            }
        }

        private static float ConstantOf(ParticleSystem.MinMaxCurve c)
        {
            switch (c.mode)
            {
                case ParticleSystemCurveMode.Constant: return c.constant;
                case ParticleSystemCurveMode.TwoConstants: return (c.constantMin + c.constantMax) * 0.5f;
                default: return c.constantMax != 0 ? c.constantMax : c.constant;
            }
        }

        private static JToken ScaleCurve(ParticleSystem.MinMaxCurve c, float scale)
        {
            switch (c.mode)
            {
                case ParticleSystemCurveMode.Constant: return ValueConverter.Constant(c.constant * scale);
                case ParticleSystemCurveMode.TwoConstants: return ValueConverter.Interval(c.constantMin * scale, c.constantMax * scale);
                case ParticleSystemCurveMode.Curve: return ValueConverter.Bezier(c.curve, c.curveMultiplier * scale);
                case ParticleSystemCurveMode.TwoCurves: return ValueConverter.Bezier(c.curveMax, c.curveMultiplier * scale);
                default: return ValueConverter.Constant(c.constant * scale);
            }
        }

        private static JToken Vec3(float x, float y, float z) => new JArray().Add(x).Add(y).Add(z);
    }
}
