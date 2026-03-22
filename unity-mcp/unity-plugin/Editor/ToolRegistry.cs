// ToolRegistry — reflection-based tool discovery from [MCPTool] attributes + shared helpers.

#if UNITY_EDITOR

using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;

using UnityEditor;

using UnityEngine;

namespace UnityMCP
{
    public static class ToolRegistry
    {
        private sealed class ToolInfo
        {
            public MCPToolAttribute Tool;
            public MCPParamAttribute[] Params;
            public Func<Dictionary<string, object>, object> Handler;
        }

        private static Dictionary<string, ToolInfo> _tools;

        static ToolRegistry()
        {
            DiscoverTools();
        }

        /// <summary>
        /// Re-discover tools from all loaded assemblies. Called automatically after assembly reload.
        /// </summary>
        public static void Reload()
        {
            DiscoverTools();
        }

        private static void DiscoverTools()
        {
            _tools = new Dictionary<string, ToolInfo>();
            var handlerType = typeof(Func<Dictionary<string, object>, object>);
            var attrType = typeof(MCPToolAttribute);

            // Scan ALL assemblies that reference UnityMCP (not just our own)
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                // Skip dynamic/system assemblies for performance
                if (assembly.IsDynamic) continue;

                // Quick check: does this assembly reference UnityMCP or IS UnityMCP?
                if (assembly != attrType.Assembly)
                {
                    bool referencesUs = false;
                    try
                    {
                        foreach (var refAsm in assembly.GetReferencedAssemblies())
                        {
                            if (refAsm.Name == attrType.Assembly.GetName().Name)
                            {
                                referencesUs = true;
                                break;
                            }
                        }
                    }
                    catch { continue; }
                    if (!referencesUs) continue;
                }

                Type[] types;
                try { types = assembly.GetTypes(); }
                catch (ReflectionTypeLoadException ex) { types = ex.Types.Where(t => t != null).ToArray(); }
                catch { continue; }

                foreach (var type in types)
                {
                    if (!type.IsClass) continue;

                    foreach (var method in type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static))
                    {
                        var toolAttr = method.GetCustomAttribute<MCPToolAttribute>();
                        if (toolAttr == null) continue;

                        try
                        {
                            var handler = (Func<Dictionary<string, object>, object>)method.CreateDelegate(handlerType);
                            _tools[toolAttr.Name] = new ToolInfo
                            {
                                Tool = toolAttr,
                                Params = method.GetCustomAttributes<MCPParamAttribute>().ToArray(),
                                Handler = handler
                            };
                        }
                        catch (Exception ex)
                        {
                            Debug.LogWarning($"[UnityMCP] Failed to bind tool '{toolAttr.Name}' on {type.Name}.{method.Name}: {ex.Message}");
                        }
                    }
                }
            }

            Debug.Log($"[UnityMCP] Discovered {_tools.Count} tools via attributes");
        }

        public static List<string> GetToolNames() => _tools.Keys.ToList();

        public static object Execute(string name, Dictionary<string, object> args)
        {
            if (_tools.TryGetValue(name, out var info))
                return info.Handler(args);
            throw new Exception($"Unknown tool: {name}");
        }

        /// <summary>
        /// Returns full MCP-compatible tool metadata including inputSchema for each tool.
        /// The TS server uses this to dynamically register tools.
        /// </summary>
        public static object GetToolsMetadata()
        {
            var tools = new List<object>();

            foreach (var kv in _tools)
            {
                var info = kv.Value;
                var properties = new Dictionary<string, object>();
                var required = new List<string>();

                foreach (var p in info.Params)
                {
                    Dictionary<string, object> propSchema;

                    // Raw JSON Schema override
                    if (!string.IsNullOrEmpty(p.JsonSchema))
                    {
                        propSchema = MiniJSON.Deserialize(p.JsonSchema) as Dictionary<string, object>
                                     ?? new Dictionary<string, object> { { "type", p.Type } };
                    }
                    else if (p.EnumValues?.Length > 0)
                    {
                        propSchema = new Dictionary<string, object>
                        {
                            { "type", "string" },
                            { "enum", p.EnumValues.ToList() }
                        };
                    }
                    else if (p.Type == "array")
                    {
                        propSchema = new Dictionary<string, object> { { "type", "array" } };
                        if (!string.IsNullOrEmpty(p.ItemType))
                            propSchema["items"] = new Dictionary<string, object> { { "type", p.ItemType } };
                    }
                    else
                    {
                        propSchema = new Dictionary<string, object> { { "type", p.Type } };
                    }

                    if (!string.IsNullOrEmpty(p.Description))
                        propSchema["description"] = p.Description;

                    properties[p.Name] = propSchema;
                    if (p.Required) required.Add(p.Name);
                }

                var inputSchema = new Dictionary<string, object>
                {
                    { "type", "object" },
                    { "properties", properties }
                };
                if (required.Count > 0)
                    inputSchema["required"] = required;

                tools.Add(new Dictionary<string, object>
                {
                    { "name", info.Tool.Name },
                    { "description", info.Tool.Description },
                    { "inputSchema", inputSchema }
                });
            }

            return new Dictionary<string, object> { { "tools", tools } };
        }

        // ─── Shared parameter helpers ─────────────────────────────

        public static string GetString(Dictionary<string, object> args, string key, string defaultValue = "")
        {
            return args.ContainsKey(key) && args[key] != null ? args[key].ToString() : defaultValue;
        }

        public static int GetInt(Dictionary<string, object> args, string key, int defaultValue = 0)
        {
            if (args.ContainsKey(key) && args[key] != null)
            {
                if (args[key] is double d) return (int)d;
                if (args[key] is long l) return (int)l;
                if (int.TryParse(args[key].ToString(), out int v)) return v;
            }
            return defaultValue;
        }

        public static bool GetBool(Dictionary<string, object> args, string key, bool defaultValue = false)
        {
            if (args.ContainsKey(key) && args[key] != null)
            {
                if (args[key] is bool b) return b;
                if (bool.TryParse(args[key].ToString(), out bool v)) return v;
            }
            return defaultValue;
        }

        public static float GetFloat(Dictionary<string, object> args, string key, float defaultValue = 0f)
        {
            if (args.ContainsKey(key) && args[key] != null)
            {
                if (args[key] is double d) return (float)d;
                if (args[key] is float f) return f;
                if (float.TryParse(args[key].ToString(), System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out float v)) return v;
            }
            return defaultValue;
        }

        public static GameObject FindGameObject(Dictionary<string, object> args)
        {
            if (args.ContainsKey("instanceId"))
            {
                var id = GetInt(args, "instanceId");
                if (id != 0)
                {
                    var obj = EditorUtility.InstanceIDToObject(id) as GameObject;
                    if (obj != null) return obj;
                }
            }

            var name = GetString(args, "name");
            if (!string.IsNullOrEmpty(name))
                return GameObject.Find(name);

            return null;
        }

        public static string GetGameObjectPath(GameObject go)
        {
            var path = go.name;
            var parent = go.transform.parent;
            while (parent != null)
            {
                path = parent.name + "/" + path;
                parent = parent.parent;
            }
            return path;
        }

        public static Type FindType(string typeName)
        {
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                var type = assembly.GetType(typeName);
                if (type != null) return type;

                type = assembly.GetType("UnityEngine." + typeName);
                if (type != null) return type;

                type = assembly.GetType("UnityEditor." + typeName);
                if (type != null) return type;
            }
            return null;
        }

        public static object SerializedPropertyToValue(SerializedProperty prop)
        {
            switch (prop.propertyType)
            {
                case SerializedPropertyType.Integer: return prop.intValue;
                case SerializedPropertyType.Boolean: return prop.boolValue;
                case SerializedPropertyType.Float: return prop.floatValue;
                case SerializedPropertyType.String: return prop.stringValue;
                case SerializedPropertyType.Enum: return prop.enumNames[prop.enumValueIndex];
                case SerializedPropertyType.Vector2:
                    var v2 = prop.vector2Value;
                    return new Dictionary<string, object> { { "x", v2.x }, { "y", v2.y } };
                case SerializedPropertyType.Vector3:
                    var v3 = prop.vector3Value;
                    return new Dictionary<string, object> { { "x", v3.x }, { "y", v3.y }, { "z", v3.z } };
                case SerializedPropertyType.Vector4:
                    var v4 = prop.vector4Value;
                    return new Dictionary<string, object> { { "x", v4.x }, { "y", v4.y }, { "z", v4.z }, { "w", v4.w } };
                case SerializedPropertyType.Quaternion:
                    var q = prop.quaternionValue;
                    return new Dictionary<string, object> { { "x", q.x }, { "y", q.y }, { "z", q.z }, { "w", q.w } };
                case SerializedPropertyType.Color:
                    var c = prop.colorValue;
                    return new Dictionary<string, object> { { "r", c.r }, { "g", c.g }, { "b", c.b }, { "a", c.a } };
                case SerializedPropertyType.Rect:
                    var r = prop.rectValue;
                    return new Dictionary<string, object> { { "x", r.x }, { "y", r.y }, { "width", r.width }, { "height", r.height } };
                case SerializedPropertyType.ObjectReference:
                    var obj = prop.objectReferenceValue;
                    if (obj == null) return null;
                    return new Dictionary<string, object>
                    {
                        { "name", obj.name },
                        { "type", obj.GetType().Name },
                        { "instanceID", obj.GetInstanceID() }
                    };
                case SerializedPropertyType.ArraySize:
                    return prop.intValue;
                default:
                    // For generic/nested types, try to iterate children
                    if (prop.isArray)
                    {
                        var arr = new List<object>();
                        for (int i = 0; i < prop.arraySize; i++)
                            arr.Add(SerializedPropertyToValue(prop.GetArrayElementAtIndex(i)));
                        return arr;
                    }
                    if (prop.hasChildren)
                    {
                        var dict = new Dictionary<string, object>();
                        var iter = prop.Copy();
                        var end = iter.GetEndProperty();
                        if (iter.NextVisible(true))
                        {
                            do
                            {
                                if (SerializedProperty.EqualContents(iter, end)) break;
                                dict[iter.name] = SerializedPropertyToValue(iter.Copy());
                            } while (iter.NextVisible(false));
                        }
                        return dict;
                    }
                    return prop.propertyType.ToString();
            }
        }

        public static void SetSerializedProperty(SerializedProperty prop, object value)
        {
            switch (prop.propertyType)
            {
                case SerializedPropertyType.Integer:
                    if (value is double d) prop.intValue = (int)d;
                    else if (value is long l) prop.intValue = (int)l;
                    else if (int.TryParse(value.ToString(), out int i)) prop.intValue = i;
                    break;
                case SerializedPropertyType.Boolean:
                    if (value is bool b) prop.boolValue = b;
                    else if (bool.TryParse(value.ToString(), out bool bv)) prop.boolValue = bv;
                    break;
                case SerializedPropertyType.Float:
                    if (value is double df) prop.floatValue = (float)df;
                    else if (float.TryParse(value.ToString(), out float f)) prop.floatValue = f;
                    break;
                case SerializedPropertyType.String:
                    prop.stringValue = value.ToString();
                    break;
                case SerializedPropertyType.Enum:
                    if (value is string enumName)
                    {
                        var idx = Array.IndexOf(prop.enumNames, enumName);
                        if (idx >= 0) prop.enumValueIndex = idx;
                        else if (int.TryParse(enumName, out int ei)) prop.enumValueIndex = ei;
                    }
                    else if (value is double de) prop.enumValueIndex = (int)de;
                    else if (value is long le) prop.enumValueIndex = (int)le;
                    break;
                case SerializedPropertyType.Vector2:
                    if (value is Dictionary<string, object> v2d)
                        prop.vector2Value = new Vector2(
                            v2d.ContainsKey("x") ? Convert.ToSingle(v2d["x"]) : 0f,
                            v2d.ContainsKey("y") ? Convert.ToSingle(v2d["y"]) : 0f);
                    break;
                case SerializedPropertyType.Vector3:
                    if (value is Dictionary<string, object> v3d)
                        prop.vector3Value = new Vector3(
                            v3d.ContainsKey("x") ? Convert.ToSingle(v3d["x"]) : 0f,
                            v3d.ContainsKey("y") ? Convert.ToSingle(v3d["y"]) : 0f,
                            v3d.ContainsKey("z") ? Convert.ToSingle(v3d["z"]) : 0f);
                    break;
                case SerializedPropertyType.Vector4:
                    if (value is Dictionary<string, object> v4d)
                        prop.vector4Value = new Vector4(
                            v4d.ContainsKey("x") ? Convert.ToSingle(v4d["x"]) : 0f,
                            v4d.ContainsKey("y") ? Convert.ToSingle(v4d["y"]) : 0f,
                            v4d.ContainsKey("z") ? Convert.ToSingle(v4d["z"]) : 0f,
                            v4d.ContainsKey("w") ? Convert.ToSingle(v4d["w"]) : 0f);
                    break;
                case SerializedPropertyType.Quaternion:
                    if (value is Dictionary<string, object> qd)
                        prop.quaternionValue = new Quaternion(
                            qd.ContainsKey("x") ? Convert.ToSingle(qd["x"]) : 0f,
                            qd.ContainsKey("y") ? Convert.ToSingle(qd["y"]) : 0f,
                            qd.ContainsKey("z") ? Convert.ToSingle(qd["z"]) : 0f,
                            qd.ContainsKey("w") ? Convert.ToSingle(qd["w"]) : 1f);
                    break;
                case SerializedPropertyType.Color:
                    if (value is Dictionary<string, object> cd)
                        prop.colorValue = new Color(
                            cd.ContainsKey("r") ? Convert.ToSingle(cd["r"]) : 0f,
                            cd.ContainsKey("g") ? Convert.ToSingle(cd["g"]) : 0f,
                            cd.ContainsKey("b") ? Convert.ToSingle(cd["b"]) : 0f,
                            cd.ContainsKey("a") ? Convert.ToSingle(cd["a"]) : 1f);
                    break;
                case SerializedPropertyType.ObjectReference:
                    if (value is Dictionary<string, object> od && od.ContainsKey("instanceID"))
                    {
                        var instanceId = Convert.ToInt32(od["instanceID"]);
                        prop.objectReferenceValue = EditorUtility.InstanceIDToObject(instanceId);
                    }
                    else if (value == null)
                    {
                        prop.objectReferenceValue = null;
                    }
                    break;
            }
        }
    }
}

#endif
