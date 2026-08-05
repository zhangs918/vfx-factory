using UnityEditor;
using UnityEngine;

namespace BabylonQuarks.UnityExporter
{
    /// <summary>
    /// Single access path for Unity material properties. Shader Graph and imported legacy
    /// materials frequently hide values from Material.HasProperty; the serialized fallback
    /// belongs here so compilers do not each implement a subtly different reader.
    /// </summary>
    public static class MaterialPropertyReader
    {
        public static bool TryGetFloat(Material material, string name, out float value)
        {
            value = 0f;
            if (material == null || string.IsNullOrEmpty(name)) return false;
            if (material.HasProperty(name))
            {
                value = material.GetFloat(name);
                return true;
            }
            var serialized = new SerializedObject(material);
            var floats = serialized.FindProperty("m_SavedProperties.m_Floats");
            if (floats == null) return false;
            for (int i = 0; i < floats.arraySize; i++)
            {
                var element = floats.GetArrayElementAtIndex(i);
                var key = element.FindPropertyRelative("first");
                var number = element.FindPropertyRelative("second");
                if (key != null && number != null && key.stringValue == name)
                {
                    value = number.floatValue;
                    return true;
                }
            }
            return false;
        }

        public static int ReadInt(Material material, string name, int fallback) =>
            TryGetFloat(material, name, out float value) ? (int)value : fallback;

        public static float ReadFloat(Material material, string name, float fallback) =>
            TryGetFloat(material, name, out float value) ? value : fallback;

        public static bool ReadBool(Material material, string name, bool fallback) =>
            TryGetFloat(material, name, out float value) ? value > 0.5f : fallback;
    }
}
