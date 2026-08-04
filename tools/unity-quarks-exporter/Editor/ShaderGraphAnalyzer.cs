using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEngine;

namespace BabylonQuarks.UnityExporter
{
    /// <summary>
    /// Data-driven Shader Graph wiring analysis. Answers, per texture property, whether it
    /// feeds the Alpha chain, the BaseColor chain, or both — so the Web fidelity shader can
    /// route "noise sheet drives coverage, HDR _Color drives RGB" correctly for ANY pack,
    /// without name-based cases or pixel heuristics.
    /// </summary>
    public sealed class ShaderGraphInfo
    {
        /// <summary>Texture reference names (e.g. "_Main") reachable from SurfaceDescription.Alpha / AlphaClipThreshold.</summary>
        public readonly HashSet<string> AlphaTextures = new HashSet<string>();
        /// <summary>Texture reference names reachable from SurfaceDescription.BaseColor.</summary>
        public readonly HashSet<string> ColorTextures = new HashSet<string>();
        public bool SceneColorInColor;
        public bool VertexColorInAlpha;
        public bool VertexColorInColor;
        /// <summary>
        /// AlphaClipThreshold is computed by graph nodes (UV/custom data/math), rather than
        /// being a direct material property. It must not be flattened to a static cutoff.
        /// </summary>
        public bool AlphaClipDynamic;
        public bool AlphaClipEnabled;
        /// <summary>
        /// Exact particle semantic feeding AlphaClipThreshold. This is deliberately a
        /// component-qualified value (for example custom1.y), never a node-only guess.
        /// Null means the dynamic expression is outside the strict lowering subset.
        /// </summary>
        public string AlphaClipSource;
        /// <summary>
        /// Reviewed material-folded selector guarding AlphaClipSource. The Trail graph chooses
        /// a constant-one threshold when this property is positive and particle UV1 otherwise.
        /// The strict exporter currently accepts only the non-positive, UV1-selected branch.
        /// </summary>
        public string AlphaClipZeroToggleProperty;
        public readonly HashSet<string> ReachableNodeTypes = new HashSet<string>();
        public string SourceHash;

        /// <summary>
        /// The v1 Web compiler intentionally accepts only a small expression subset. A graph
        /// outside it must be baked or rejected; reachability is not treated as equivalence.
        /// </summary>
        public bool IsStrictTemplateSupported(out string unsupported)
        {
            var allowed = new HashSet<string>
            {
                "BlockNode", "PropertyNode", "SampleTexture2DNode", "VertexColorNode",
                "MultiplyNode", "AddNode", "SubtractNode", "LerpNode", "SaturateNode",
                "OneMinusNode", "StepNode", "ComparisonNode", "BranchNode",
                "SplitNode", "CombineNode", "Vector2Node", "UVNode", "SceneColorNode",
                "SceneDepthNode", "ScreenPositionNode", "SampleTexture2DNode",
                "SamplerStateNode", "TilingAndOffsetNode", "RotateNode", "RedirectNodeData",
                "PreviewNode", "NoiseNode", "NormalFromTextureNode", "SubGraphNode",
            };
            var bad = new List<string>();
            foreach (string type in ReachableNodeTypes)
            {
                string shortName = type;
                int dot = shortName.LastIndexOf('.');
                if (dot >= 0) shortName = shortName.Substring(dot + 1);
                if (!allowed.Contains(shortName)) bad.Add(shortName);
            }
            bad.Sort();
            unsupported = string.Join(", ", bad);
            return bad.Count == 0;
        }
    }

    public static class ShaderGraphAnalyzer
    {
        private sealed class GraphEdge
        {
            public string SourceNode;
            public int SourceSlot;
            public string DestinationNode;
            public int DestinationSlot;
        }

        private static readonly Dictionary<string, ShaderGraphInfo> Cache = new Dictionary<string, ShaderGraphInfo>();

        /// <summary>Returns wiring info for a Shader Graph shader, or null for non-SG shaders.</summary>
        public static ShaderGraphInfo Analyze(Shader shader)
        {
            if (shader == null) return null;
            string path = AssetDatabase.GetAssetPath(shader);
            if (string.IsNullOrEmpty(path) || !path.EndsWith(".shadergraph")) return null;
            if (Cache.TryGetValue(path, out var cached)) return cached;

            ShaderGraphInfo info = null;
            try
            {
                string raw = File.ReadAllText(path);
                info = Parse(raw);
                if (info != null)
                {
                    info.SourceHash = Hash128.Compute(raw).ToString();
                    // Trail.shadergraph is already a reviewed manual lowering locked to this
                    // exact content hash. Its clip chain is:
                    // _Clip * ((_CustomUV > 0) ? 1 : UV1.x). UV1 is a vertex semantic;
                    // it is not ParticleSystem Custom1 (that stream may occupy TEXCOORD2+).
                    if (info.SourceHash == "5dec7e398437ea7cc9af539891fa91ea"
                        && info.AlphaClipDynamic && string.IsNullOrEmpty(info.AlphaClipSource))
                    {
                        info.AlphaClipSource = "uv1.x";
                        info.AlphaClipZeroToggleProperty = "_CustomUV";
                    }
                }
            }
            catch (System.Exception e)
            {
                Debug.LogWarning($"[Quarks Exporter] ShaderGraph analysis failed for {path}: {e.Message}");
            }
            Cache[path] = info;
            return info;
        }

        private static ShaderGraphInfo Parse(string raw)
        {
            // .shadergraph = stream of pretty-printed JSON objects. Split by brace depth.
            List<string> objects = SplitTopLevelObjects(raw);
            if (objects.Count == 0) return null;

            // Per-object field extraction (fields unique within one object).
            var idOf = new Regex("\"m_ObjectId\":\\s*\"([0-9a-f]+)\"");
            var typeOf = new Regex("\"m_Type\":\\s*\"([^\"]+)\"");
            var descOf = new Regex("\"m_SerializedDescriptor\":\\s*\"([^\"]+)\"");
            var propRefOf = new Regex("\"m_Property\":\\s*\\{\\s*\"m_Id\":\\s*\"([0-9a-f]+)\"", RegexOptions.Singleline);
            var refNameOf = new Regex("\"m_DefaultReferenceName\":\\s*\"([^\"]+)\"");
            var overrideNameOf = new Regex("\"m_OverrideReferenceName\":\\s*\"([^\"]+)\"");

            var typeById = new Dictionary<string, string>();
            var descById = new Dictionary<string, string>();
            var propIdByNode = new Dictionary<string, string>();   // PropertyNode → property object id
            var refNameByProp = new Dictionary<string, string>();  // property object id → reference name
            var texPropIds = new HashSet<string>();
            var uvChannelByNode = new Dictionary<string, int>();
            var swizzleMaskByNode = new Dictionary<string, string>();
            var outputChannelOf = new Regex("\\\"m_OutputChannel\\\":\\s*(-?[0-9]+)");
            var swizzleMaskOf = new Regex("\\\"convertedMask\\\":\\s*\\\"([xyzwrgba]+)\\\"");

            foreach (string obj in objects)
            {
                var idM = idOf.Match(obj);
                if (!idM.Success) continue;
                string id = idM.Groups[1].Value;
                string type = typeOf.Match(obj) is Match tm && tm.Success ? tm.Groups[1].Value : "";
                typeById[id] = type;
                var outputChannel = outputChannelOf.Match(obj);
                if (type.Contains("UVNode") && outputChannel.Success)
                    uvChannelByNode[id] = int.Parse(outputChannel.Groups[1].Value);
                var swizzleMask = swizzleMaskOf.Match(obj);
                if (type.Contains("SwizzleNode") && swizzleMask.Success)
                    swizzleMaskByNode[id] = swizzleMask.Groups[1].Value;
                var dm = descOf.Match(obj);
                if (dm.Success) descById[id] = dm.Groups[1].Value;
                var pm = propRefOf.Match(obj);
                if (pm.Success) propIdByNode[id] = pm.Groups[1].Value;
                if (type.Contains("ShaderProperty"))
                {
                    string name = null;
                    var om = overrideNameOf.Match(obj);
                    if (om.Success && om.Groups[1].Value.Length > 0) name = om.Groups[1].Value;
                    if (name == null)
                    {
                        var rm = refNameOf.Match(obj);
                        if (rm.Success) name = rm.Groups[1].Value;
                    }
                    if (name != null) refNameByProp[id] = name;
                }
                if (type.Contains("Texture2DShaderProperty")) texPropIds.Add(id);
            }

            // Edges live in the GraphData object (the one containing "m_Edges").
            // Each edge: OutputSlot(node A) → InputSlot(node B). Reverse-walk B → A.
            var edgeRe = new Regex(
                "\"m_OutputSlot\":\\s*\\{\\s*\"m_Node\":\\s*\\{\\s*\"m_Id\":\\s*\"([0-9a-f]+)\"\\s*\\}\\s*,\\s*\"m_SlotId\":\\s*(-?[0-9]+)\\s*\\}\\s*,\\s*" +
                "\"m_InputSlot\":\\s*\\{\\s*\"m_Node\":\\s*\\{\\s*\"m_Id\":\\s*\"([0-9a-f]+)\"\\s*\\}\\s*,\\s*\"m_SlotId\":\\s*(-?[0-9]+)",
                RegexOptions.Singleline);
            var inputsOf = new Dictionary<string, List<string>>(); // node → upstream nodes
            var inputEdgesOf = new Dictionary<string, List<GraphEdge>>();
            foreach (string obj in objects)
            {
                if (!obj.Contains("\"m_Edges\"")) continue;
                foreach (Match m in edgeRe.Matches(obj))
                {
                    string src = m.Groups[1].Value;
                    int srcSlot = int.Parse(m.Groups[2].Value);
                    string dst = m.Groups[3].Value;
                    int dstSlot = int.Parse(m.Groups[4].Value);
                    if (!inputsOf.TryGetValue(dst, out var list))
                    {
                        list = new List<string>();
                        inputsOf[dst] = list;
                    }
                    list.Add(src);
                    if (!inputEdgesOf.TryGetValue(dst, out var edges))
                    {
                        edges = new List<GraphEdge>();
                        inputEdgesOf[dst] = edges;
                    }
                    edges.Add(new GraphEdge
                    {
                        SourceNode = src,
                        SourceSlot = srcSlot,
                        DestinationNode = dst,
                        DestinationSlot = dstSlot,
                    });
                }
                break;
            }

            var info = new ShaderGraphInfo();
            // The compiled fragment only clips when AlphaClipThreshold is an active, connected
            // master-stack block. Material `_AlphaClip` floats and stale target flags are not
            // execution semantics (Impact is connected; Slash keeps an unconnected block).
            foreach (var kv in descById)
                if (kv.Value == "SurfaceDescription.AlphaClipThreshold"
                    && inputsOf.TryGetValue(kv.Key, out var clipInputs) && clipInputs.Count > 0)
                    info.AlphaClipEnabled = true;
            CollectChain(info, "SurfaceDescription.Alpha", true, descById, typeById, propIdByNode, refNameByProp, texPropIds, inputsOf);
            CollectChain(info, "SurfaceDescription.AlphaClipThreshold", true, descById, typeById, propIdByNode, refNameByProp, texPropIds, inputsOf);
            CollectChain(info, "SurfaceDescription.BaseColor", false, descById, typeById, propIdByNode, refNameByProp, texPropIds, inputsOf);
            info.AlphaClipDynamic = info.AlphaClipEnabled && ChainContainsComputedNode(
                "SurfaceDescription.AlphaClipThreshold", descById, typeById, inputsOf);
            if (info.AlphaClipDynamic)
                info.AlphaClipSource = ResolveParticleAlphaClipSource(
                    descById, typeById, uvChannelByNode, swizzleMaskByNode, propIdByNode,
                    refNameByProp, inputEdgesOf);
            return info;
        }

        /// <summary>
        /// Strictly lowers Block(AlphaClipThreshold) &lt;- Split(component) &lt;- UV(channel).
        /// Unity particle Custom1 is carried in TEXCOORD1 by this exporter/runtime contract.
        /// Other expression shapes remain unsupported instead of silently selecting a channel.
        /// </summary>
        private static string ResolveParticleAlphaClipSource(
            Dictionary<string, string> descById,
            Dictionary<string, string> typeById,
            Dictionary<string, int> uvChannelByNode,
            Dictionary<string, string> swizzleMaskByNode,
            Dictionary<string, string> propIdByNode,
            Dictionary<string, string> refNameByProp,
            Dictionary<string, List<GraphEdge>> inputEdgesOf)
        {
            string block = null;
            foreach (var kv in descById)
                if (kv.Value == "SurfaceDescription.AlphaClipThreshold") { block = kv.Key; break; }
            if (block == null || !inputEdgesOf.TryGetValue(block, out var blockEdges)
                || blockEdges.Count != 1)
                return null;

            GraphEdge valueEdge = blockEdges[0];
            if (!typeById.TryGetValue(valueEdge.SourceNode, out string sourceType)) return null;

            // Supported scalar product: an authored `_Clip` property multiplied by a
            // component selected from particle UV1/Custom1. The material value is folded
            // into dynamicAlphaClipScale by ExportContext; this method preserves the vector
            // source and component rather than flattening it to a guessed `.z`.
            if (sourceType.Contains("MultiplyNode"))
            {
                if (!inputEdgesOf.TryGetValue(valueEdge.SourceNode, out var multiplyEdges)
                    || multiplyEdges.Count != 2)
                    return null;
                GraphEdge componentEdge = null;
                bool hasClipProperty = false;
                foreach (GraphEdge edge in multiplyEdges)
                {
                    if (propIdByNode.TryGetValue(edge.SourceNode, out string propertyId)
                        && refNameByProp.TryGetValue(propertyId, out string propertyName)
                        && propertyName == "_Clip")
                        hasClipProperty = true;
                    else
                        componentEdge = edge;
                }
                if (!hasClipProperty || componentEdge == null) return null;
                valueEdge = componentEdge;
                if (!typeById.TryGetValue(valueEdge.SourceNode, out sourceType)) return null;
            }

            string component;
            if (sourceType.Contains("SplitNode"))
            {
                switch (valueEdge.SourceSlot)
                {
                    case 1: component = "x"; break;
                    case 2: component = "y"; break;
                    case 3: component = "z"; break;
                    case 4: component = "w"; break;
                    default: return null;
                }
            }
            else if (sourceType.Contains("SwizzleNode")
                && swizzleMaskByNode.TryGetValue(valueEdge.SourceNode, out string mask)
                && mask.Length == 1 && "xyzw".Contains(mask))
            {
                component = mask;
            }
            else return null;

            if (!inputEdgesOf.TryGetValue(valueEdge.SourceNode, out var splitEdges)
                || splitEdges.Count != 1 || splitEdges[0].DestinationSlot != 0)
                return null;
            string valueNode = splitEdges[0].SourceNode;
            if (!typeById.TryGetValue(valueNode, out string valueType)
                || !valueType.Contains("UVNode")
                || !uvChannelByNode.TryGetValue(valueNode, out int uvChannel)
                || uvChannel != 1)
                return null;
            return "custom1." + component;
        }

        private static bool ChainContainsComputedNode(
            string blockDescriptor,
            Dictionary<string, string> descById,
            Dictionary<string, string> typeById,
            Dictionary<string, List<string>> inputsOf)
        {
            string start = null;
            foreach (var kv in descById)
                if (kv.Value == blockDescriptor) { start = kv.Key; break; }
            if (start == null) return false;

            var seen = new HashSet<string>();
            var stack = new Stack<string>();
            stack.Push(start);
            while (stack.Count > 0)
            {
                string id = stack.Pop();
                if (!seen.Add(id)) continue;
                string type = typeById.TryGetValue(id, out var t) ? t : "";
                // A direct Property → Block edge is a static material threshold. Any other
                // upstream node means the graph computes the cutoff per vertex/fragment.
                if (!type.Contains("BlockNode") && !type.Contains("PropertyNode"))
                    return true;
                if (inputsOf.TryGetValue(id, out var ups))
                    foreach (string up in ups) stack.Push(up);
            }
            return false;
        }

        private static void CollectChain(
            ShaderGraphInfo info,
            string blockDescriptor,
            bool alphaChain,
            Dictionary<string, string> descById,
            Dictionary<string, string> typeById,
            Dictionary<string, string> propIdByNode,
            Dictionary<string, string> refNameByProp,
            HashSet<string> texPropIds,
            Dictionary<string, List<string>> inputsOf)
        {
            string start = null;
            foreach (var kv in descById)
            {
                if (kv.Value == blockDescriptor) { start = kv.Key; break; }
            }
            if (start == null) return;

            var seen = new HashSet<string>();
            var stack = new Stack<string>();
            stack.Push(start);
            while (stack.Count > 0)
            {
                string id = stack.Pop();
                if (!seen.Add(id)) continue;

                string type = typeById.TryGetValue(id, out var t) ? t : "";
                if (!string.IsNullOrEmpty(type)) info.ReachableNodeTypes.Add(type);
                if (type.Contains("SceneColorNode") && !alphaChain) info.SceneColorInColor = true;
                if (type.Contains("VertexColorNode"))
                {
                    if (alphaChain) info.VertexColorInAlpha = true;
                    else info.VertexColorInColor = true;
                }
                if (propIdByNode.TryGetValue(id, out var propId)
                    && texPropIds.Contains(propId)
                    && refNameByProp.TryGetValue(propId, out var refName))
                {
                    if (alphaChain) info.AlphaTextures.Add(refName);
                    else info.ColorTextures.Add(refName);
                }

                if (inputsOf.TryGetValue(id, out var ups))
                {
                    foreach (string up in ups) stack.Push(up);
                }
            }
        }

        private static List<string> SplitTopLevelObjects(string raw)
        {
            var result = new List<string>();
            int depth = 0;
            int start = -1;
            bool inString = false;
            for (int i = 0; i < raw.Length; i++)
            {
                char c = raw[i];
                if (inString)
                {
                    if (c == '\\') i++;
                    else if (c == '"') inString = false;
                    continue;
                }
                if (c == '"') { inString = true; continue; }
                if (c == '{')
                {
                    if (depth == 0) start = i;
                    depth++;
                }
                else if (c == '}')
                {
                    depth--;
                    if (depth == 0 && start >= 0)
                    {
                        result.Add(raw.Substring(start, i - start + 1));
                        start = -1;
                    }
                }
            }
            return result;
        }
    }
}
