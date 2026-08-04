using UnityEditor;
using UnityEngine;
using System.Collections.Generic;

namespace BabylonQuarks.UnityExporter
{
    /// <summary>
    /// Reviewed, bounded lowering for effect-driving MonoBehaviours. These controllers are
    /// simulation inputs, not material guesses: both semantic capture and camera oracle invoke
    /// the same reference implementation against the same y=0 fixture.
    /// </summary>
    public static class ControllerSemanticCompiler
    {
        private const string SlashDecalType = "MaykerStudio.VFX.SlashDecal";
        private const string ProjectileType = "MaykerStudio.Demo.Projectile";
        // Cartoon FX legacy's auto-destruct script only observes whether this hierarchy has
        // finished.  The portable effect-lifecycle@1 already owns that same one-shot terminal
        // transition, so it is intentionally not emitted as a visual controller.
        private const string CfxAutoDestructType = "CFX_AutoDestructShuriken";
        private const string CfxLightIntensityFadeType = "CFX_LightIntensityFade";
        private const string CfxAutoRotateType = "CFX_AutoRotate";
        private const string CfxLightFlickerType = "CFX_LightFlicker";
        // Imported pack helpers whose scene-side action is not portable in a standalone
        // prefab preview. Their particle hierarchy remains valid; compile them as explicit
        // no-op adapters instead of rejecting the whole visual effect.
        private const string ProjectorMaterialChangerType = "ProjectorMaterialChanger";
        private const string ParticleCollisionInstanceType = "ParticleCollisionInstance";
        private const string ColliderTurnOffType = "ColliderTurnOff";
        private static readonly Dictionary<MonoBehaviour, float> ReferenceControllerTimes =
            new Dictionary<MonoBehaviour, float>();
        private static readonly Dictionary<MonoBehaviour, float> ReferenceLightBaseIntensity =
            new Dictionary<MonoBehaviour, float>();
        // Rendering-pipeline metadata components derive from MonoBehaviour for Unity
        // serialization, but they are not executable effect controllers. Their semantics are
        // consumed by the light/material exporters instead of the controller IR.
        private const string UrpAdditionalLightDataType =
            "UnityEngine.Rendering.Universal.UniversalAdditionalLightData";

        private static bool IsRenderingMetadata(string type)
        {
            return type == UrpAdditionalLightDataType;
        }

        public static void Validate(GameObject root, ExportContext ctx)
        {
            foreach (MonoBehaviour behaviour in root.GetComponentsInChildren<MonoBehaviour>(true))
            {
                if (behaviour == null) continue; // Missing optional demo scripts are asset diagnostics, not executable behaviour.
                string type = behaviour.GetType().FullName;
                if (IsRenderingMetadata(type)) continue;
                string path = SemanticValidator.HierarchyPath(behaviour.transform);
                if (type == SlashDecalType)
                    ctx.Warning("CONTROLLER_SLASH_DECAL_ADAPTER", path,
                        "SlashDecal CapsuleCast/grounded-edge/Play semantics are compiled by unity-effect-controller@1 against reference-ground-plane@1.");
                else if (type == ProjectileType)
                    ctx.Warning("CONTROLLER_PROJECTILE_HOST_EVENT", path,
                        "Projectile motion starts only after the host calls Fire(); the controller parameters are exported but standalone preview leaves that host event inactive.");
                else if (type == CfxAutoDestructType)
                    ctx.Warning("CONTROLLER_LIFECYCLE_OBSERVER", path,
                        "CFX_AutoDestructShuriken is lowered to effect-lifecycle@1 stop-and-clear after the particle hierarchy is no longer alive.");
                else if (type == CfxLightIntensityFadeType)
                    ctx.Warning("CONTROLLER_LIGHT_FADE_ADAPTER", path,
                        "CFX_LightIntensityFade is lowered to deterministic-light-fade@1 with its authored delay, duration and terminal intensity.");
                else if (type == CfxAutoRotateType)
                    ctx.Warning("CONTROLLER_AUTO_ROTATE_ADAPTER", path,
                        "CFX_AutoRotate is lowered to constant-euler-rotation@1 in authored self/world space.");
                else if (type == CfxLightFlickerType)
                    ctx.Warning("CONTROLLER_LIGHT_FLICKER_ADAPTER", path,
                        "CFX_LightFlicker is lowered to sampled-unity-perlin-light@1 with an explicit effect-local reference phase.");
                else if (type == ProjectorMaterialChangerType)
                    ctx.Warning("CONTROLLER_PROJECTOR_PREVIEW_NOOP", path,
                        "ProjectorMaterialChanger is scene-projector animation; standalone WebGL keeps the particle hierarchy and omits the projector-only material mutation.");
                else if (type == ParticleCollisionInstanceType)
                    ctx.Warning("CONTROLLER_PARTICLE_COLLISION_PREVIEW_NOOP", path,
                        "ParticleCollisionInstance requires external colliders and collision callbacks; standalone WebGL keeps the source effect and omits scene-spawned collision children.");
                else if (type == ColliderTurnOffType)
                    ctx.Warning("CONTROLLER_COLLIDER_LIFETIME_NOOP", path,
                        "ColliderTurnOff only changes a scene collider; standalone WebGL has no external collider to toggle.");
                else
                    ctx.Error("CONTROLLER_UNSUPPORTED", path,
                        $"MonoBehaviour '{type}' can affect effect state but has no reviewed controller adapter.");
            }
        }

        public static JArray BuildPrograms(GameObject root, ExportContext ctx)
        {
            var result = new JArray();
            foreach (MonoBehaviour behaviour in root.GetComponentsInChildren<MonoBehaviour>(true))
            {
                if (behaviour == null) continue;
                string type = behaviour.GetType().FullName;
                if (IsRenderingMetadata(type)) continue;
                var serialized = new SerializedObject(behaviour);
                if (type == SlashDecalType)
                {
                    ParticleSystem target = behaviour.GetComponent<ParticleSystem>();
                    ParticleSystem source = serialized.FindProperty("slash")?.objectReferenceValue as ParticleSystem;
                    Vector3 rotation = serialized.FindProperty("rotation")?.vector3Value ?? Vector3.zero;
                    result.Add(new JObject()
                        .Set("schema", "effect-controller@1")
                        .Set("kind", "capsule-grounded-emitter-gate")
                        .Set("sourceEmitter", ctx.GetNodeUuid(source))
                        .Set("targetEmitter", ctx.GetNodeUuid(target))
                        .Set("decalOffsetY", serialized.FindProperty("decalOffsetY")?.floatValue ?? 0f)
                        .Set("maxDistance", serialized.FindProperty("maxDistance")?.floatValue ?? 0.5f)
                        .Set("capsuleHeight", serialized.FindProperty("capsuleHeight")?.floatValue ?? 2f)
                        .Set("capsuleRadius", serialized.FindProperty("capsuleRadius")?.floatValue ?? 0.2f)
                        .Set("hitRotationEuler", new JArray().Add(rotation.x).Add(rotation.y).Add(rotation.z))
                        .Set("sceneQuery", "reference-ground-plane@1")
                        .Set("activation", "grounded-rising-edge")
                        .Set("lowering", "reference-scene-schedule@1"));
                }
                else if (type == ProjectileType)
                {
                    result.Add(new JObject()
                        .Set("schema", "effect-controller@1")
                        .Set("kind", "projectile-host-motion")
                        .Set("targetNode", ctx.GetTransformUuid(behaviour.transform))
                        .Set("speed", serialized.FindProperty("speed")?.floatValue ?? 10f)
                        .Set("distance", serialized.FindProperty("distance")?.floatValue ?? 30f)
                        .Set("activation", "host-event:Fire")
                        .Set("lowering", "runtime-input-contract@1"));
                }
                else if (type == CfxLightIntensityFadeType)
                {
                    Light light = behaviour.GetComponent<Light>();
                    if (light == null) continue;
                    Vector3 local = root.transform.InverseTransformPoint(light.transform.position);
                    Color color = light.color;
                    result.Add(new JObject()
                        .Set("schema", "effect-controller@1")
                        .Set("kind", "deterministic-light-fade")
                        .Set("targetNode", ctx.GetTransformUuid(behaviour.transform))
                        .Set("position", new JArray().Add(local.x).Add(local.y).Add(-local.z))
                        .Set("color", new JArray().Add(color.r).Add(color.g).Add(color.b))
                        .Set("range", Mathf.Max(0f, light.range))
                        .Set("baseIntensity", Mathf.Max(0f, light.intensity))
                        .Set("finalIntensity", Mathf.Max(0f,
                            serialized.FindProperty("finalIntensity")?.floatValue ?? 0f))
                        .Set("delay", Mathf.Max(0f, serialized.FindProperty("delay")?.floatValue ?? 0f))
                        .Set("duration", Mathf.Max(1e-6f,
                            serialized.FindProperty("duration")?.floatValue ?? 1f))
                        .Set("autodestruct", serialized.FindProperty("autodestruct")?.boolValue ?? false)
                        .Set("activation", "effect-enable")
                        .Set("lowering", "deterministic-light-fade@1"));
                }
                else if (type == CfxAutoRotateType)
                {
                    Vector3 rotation = serialized.FindProperty("rotation")?.vector3Value ?? Vector3.zero;
                    Space space = (Space)(serialized.FindProperty("space")?.enumValueIndex ?? (int)Space.Self);
                    result.Add(new JObject()
                        .Set("schema", "effect-controller@1")
                        .Set("kind", "constant-euler-rotation")
                        .Set("targetNode", ctx.GetTransformUuid(behaviour.transform))
                        .Set("degreesPerSecond", new JArray().Add(rotation.x).Add(rotation.y).Add(rotation.z))
                        .Set("space", space == Space.World ? "world" : "self")
                        .Set("activation", "effect-enable")
                        .Set("lowering", "constant-euler-rotation@1"));
                }
                else if (type == CfxLightFlickerType)
                {
                    Light light = behaviour.GetComponent<Light>();
                    if (light == null) continue;
                    const float domainStep = 1f / 128f;
                    const int sampleCount = 8193; // x=[0,64], dense enough for linear interpolation.
                    var samples = new JArray();
                    for (int i = 0; i < sampleCount; i++)
                        samples.Add(Mathf.PerlinNoise(i * domainStep, 0f));
                    Vector3 local = root.transform.InverseTransformPoint(light.transform.position);
                    Color color = light.color;
                    result.Add(new JObject()
                        .Set("schema", "effect-controller@1")
                        .Set("kind", "sampled-unity-perlin-light")
                        .Set("targetNode", ctx.GetTransformUuid(behaviour.transform))
                        .Set("position", new JArray().Add(local.x).Add(local.y).Add(-local.z))
                        .Set("color", new JArray().Add(color.r).Add(color.g).Add(color.b))
                        .Set("range", Mathf.Max(0f, light.range))
                        .Set("baseIntensity", Mathf.Max(0f, light.intensity))
                        .Set("addIntensity", serialized.FindProperty("addIntensity")?.floatValue ?? 1f)
                        .Set("smoothFactor", Mathf.Max(0f,
                            serialized.FindProperty("smoothFactor")?.floatValue ?? 1f))
                        .Set("referencePhase", 0f)
                        .Set("domainStep", domainStep)
                        .Set("samples", samples)
                        .Set("activation", "effect-enable")
                        .Set("lowering", "sampled-unity-perlin-light@1"));
                }
            }
            return result;
        }

        /// <summary>Apply grounded controllers after all systems have been reset at t=0.</summary>
        public static void PrepareReferenceSimulation(GameObject root)
        {
            ReferenceControllerTimes.Clear();
            ReferenceLightBaseIntensity.Clear();
            foreach (MonoBehaviour behaviour in root.GetComponentsInChildren<MonoBehaviour>(true))
            {
                if (behaviour == null) continue;
                if (behaviour.GetType().FullName == CfxLightFlickerType)
                {
                    ReferenceControllerTimes[behaviour] = 0f;
                    Light light = behaviour.GetComponent<Light>();
                    if (light != null) ReferenceLightBaseIntensity[behaviour] = light.intensity;
                    continue;
                }
                if (behaviour.GetType().FullName != SlashDecalType) continue;
                var serialized = new SerializedObject(behaviour);
                ParticleSystem slash = serialized.FindProperty("slash")?.objectReferenceValue as ParticleSystem;
                ParticleSystem decal = behaviour.GetComponent<ParticleSystem>();
                if (slash == null || decal == null) continue;

                float height = serialized.FindProperty("capsuleHeight")?.floatValue ?? 2f;
                float radius = serialized.FindProperty("capsuleRadius")?.floatValue ?? 0.2f;
                float maxDistance = serialized.FindProperty("maxDistance")?.floatValue ?? 0.5f;
                Vector3 axis = slash.transform.rotation * Vector3.right;
                Vector3 center = slash.transform.position;
                Vector3 a = center + axis * Mathf.Max(0f, height * 0.5f - radius);
                Vector3 b = center - axis * Mathf.Max(0f, height * 0.5f - radius);
                float segmentDistance = a.y * b.y <= 0f ? 0f : Mathf.Min(Mathf.Abs(a.y), Mathf.Abs(b.y));
                if (Mathf.Max(0f, segmentDistance - radius) > maxDistance) continue;

                float offset = serialized.FindProperty("decalOffsetY")?.floatValue ?? 0f;
                Vector3 rotation = serialized.FindProperty("rotation")?.vector3Value ?? Vector3.zero;
                Vector3 hit = center;
                hit.y = 0f;
                behaviour.transform.SetPositionAndRotation(hit + Vector3.up * offset, Quaternion.Euler(rotation));
                decal.Play(true);
            }
        }

        /// <summary>
        /// A stopped nested controller target is not advanced by ParticleSystem.Simulate on its
        /// particle-system ancestor in EditMode. Advance that explicitly-owned subtree once.
        /// </summary>
        public static void AdvanceReferenceSimulation(GameObject root, float delta)
        {
            foreach (MonoBehaviour behaviour in root.GetComponentsInChildren<MonoBehaviour>(true))
            {
                if (behaviour == null) continue;
                if (behaviour.GetType().FullName == CfxAutoRotateType)
                {
                    var serialized = new SerializedObject(behaviour);
                    Vector3 rotation = serialized.FindProperty("rotation")?.vector3Value ?? Vector3.zero;
                    Space space = (Space)(serialized.FindProperty("space")?.enumValueIndex ?? (int)Space.Self);
                    behaviour.transform.Rotate(rotation * delta, space);
                    continue;
                }
                if (behaviour.GetType().FullName == CfxLightFlickerType)
                {
                    var serialized = new SerializedObject(behaviour);
                    Light light = behaviour.GetComponent<Light>();
                    if (light == null) continue;
                    float time = ReferenceControllerTimes.TryGetValue(behaviour, out float current) ? current : 0f;
                    float smooth = Mathf.Max(0f, serialized.FindProperty("smoothFactor")?.floatValue ?? 1f);
                    float add = serialized.FindProperty("addIntensity")?.floatValue ?? 1f;
                    float baseIntensity = ReferenceLightBaseIntensity.TryGetValue(behaviour, out float authored)
                        ? authored : light.intensity;
                    light.intensity = baseIntensity + add * Mathf.PerlinNoise(time * smooth, 0f);
                    ReferenceControllerTimes[behaviour] = time + delta;
                    continue;
                }
                if (behaviour.GetType().FullName != SlashDecalType) continue;
                ParticleSystem decal = behaviour.GetComponent<ParticleSystem>();
                if (decal != null && decal.isPlaying) decal.Simulate(delta, true, false, false);
            }
        }
    }
}
