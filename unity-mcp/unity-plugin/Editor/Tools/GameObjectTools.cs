// GameObjectTools — manage_gameobject tool implementation.

#if UNITY_EDITOR

using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace UnityMCP
{
    internal static class GameObjectTools
    {
        [MCPTool("manage_gameobject", Description = "Create, destroy, find, inspect, or modify GameObjects and their Components")]
        [MCPParam("action", Required = true, EnumValues = new[] { "find", "get_components", "get_properties", "set_properties", "create", "destroy", "add_component", "remove_component", "set_parent", "set_active" }, Description = "Action to perform")]
        [MCPParam("name", Description = "GameObject name or path")]
        [MCPParam("instanceId", Type = "number", Description = "Instance ID of the GameObject")]
        [MCPParam("query", Description = "Search query for find action")]
        [MCPParam("componentType", Description = "Component type name (e.g. 'Transform', 'MeshRenderer')")]
        [MCPParam("properties", Type = "object", Description = "Properties to set (key-value pairs)")]
        [MCPParam("parentName", Description = "Parent GameObject name/path")]
        [MCPParam("primitiveType", Description = "Primitive type for create (Cube, Sphere, Capsule, Cylinder, Plane, Quad)")]
        [MCPParam("active", Type = "boolean", Description = "Active state for set_active")]
        internal static object ManageGameObject(Dictionary<string, object> args)
        {
            var action = ToolRegistry.GetString(args, "action");

            switch (action)
            {
                case "find":
                {
                    var query = ToolRegistry.GetString(args, "query");
                    if (string.IsNullOrEmpty(query))
                        return new Dictionary<string, object> { { "error", "query is required" } };

                    var all = Resources.FindObjectsOfTypeAll<GameObject>();
                    var results = all
                        .Where(go => go.scene.isLoaded && go.name.Contains(query, StringComparison.OrdinalIgnoreCase))
                        .Take(50)
                        .Select(go => new Dictionary<string, object>
                        {
                            { "name", go.name },
                            { "instanceId", go.GetInstanceID() },
                            { "path", ToolRegistry.GetGameObjectPath(go) },
                            { "active", go.activeSelf }
                        })
                        .ToList();

                    return new Dictionary<string, object> { { "results", results }, { "count", results.Count } };
                }

                case "get_components":
                {
                    var go = ToolRegistry.FindGameObject(args);
                    if (go == null) return new Dictionary<string, object> { { "error", "GameObject not found" } };

                    var components = go.GetComponents<Component>()
                        .Where(c => c != null)
                        .Select(c => new Dictionary<string, object>
                        {
                            { "type", c.GetType().FullName },
                            { "enabled", c is Behaviour b ? (object)b.enabled : true }
                        })
                        .ToList();

                    return new Dictionary<string, object> { { "gameObject", go.name }, { "components", components } };
                }

                case "get_properties":
                {
                    var go = ToolRegistry.FindGameObject(args);
                    if (go == null) return new Dictionary<string, object> { { "error", "GameObject not found" } };

                    var compType = ToolRegistry.GetString(args, "componentType", "Transform");
                    var comp = go.GetComponent(compType);
                    if (comp == null) return new Dictionary<string, object> { { "error", $"Component '{compType}' not found" } };

                    var serialized = new SerializedObject(comp);
                    var props = new Dictionary<string, object>();
                    var iter = serialized.GetIterator();
                    iter.NextVisible(true);
                    do
                    {
                        props[iter.name] = ToolRegistry.SerializedPropertyToValue(iter);
                    } while (iter.NextVisible(false));

                    return new Dictionary<string, object>
                    {
                        { "gameObject", go.name },
                        { "component", compType },
                        { "properties", props }
                    };
                }

                case "set_properties":
                {
                    var go = ToolRegistry.FindGameObject(args);
                    if (go == null) return new Dictionary<string, object> { { "error", "GameObject not found" } };

                    var compType = ToolRegistry.GetString(args, "componentType", "Transform");
                    var comp = go.GetComponent(compType);
                    if (comp == null) return new Dictionary<string, object> { { "error", $"Component '{compType}' not found" } };

                    var properties = args.ContainsKey("properties") ? args["properties"] as Dictionary<string, object> : null;
                    if (properties == null)
                        return new Dictionary<string, object> { { "error", "properties is required" } };

                    Undo.RecordObject(comp, "MCP Set Properties");
                    var serialized = new SerializedObject(comp);
                    var changed = new List<string>();

                    foreach (var kv in properties)
                    {
                        var prop = serialized.FindProperty(kv.Key);
                        if (prop == null) continue;
                        ToolRegistry.SetSerializedProperty(prop, kv.Value);
                        changed.Add(kv.Key);
                    }

                    serialized.ApplyModifiedProperties();
                    return new Dictionary<string, object> { { "changed", changed } };
                }

                case "create":
                {
                    var name = ToolRegistry.GetString(args, "name", "New GameObject");
                    var primitiveType = ToolRegistry.GetString(args, "primitiveType");

                    GameObject go;
                    if (!string.IsNullOrEmpty(primitiveType) && Enum.TryParse<PrimitiveType>(primitiveType, true, out var pt))
                    {
                        go = GameObject.CreatePrimitive(pt);
                        go.name = name;
                    }
                    else
                    {
                        go = new GameObject(name);
                    }

                    Undo.RegisterCreatedObjectUndo(go, "MCP Create GameObject");

                    var parentName = ToolRegistry.GetString(args, "parentName");
                    if (!string.IsNullOrEmpty(parentName))
                    {
                        var parent = GameObject.Find(parentName);
                        if (parent != null)
                            go.transform.SetParent(parent.transform, false);
                    }

                    return new Dictionary<string, object>
                    {
                        { "created", go.name },
                        { "instanceId", go.GetInstanceID() },
                        { "path", ToolRegistry.GetGameObjectPath(go) }
                    };
                }

                case "destroy":
                {
                    var go = ToolRegistry.FindGameObject(args);
                    if (go == null) return new Dictionary<string, object> { { "error", "GameObject not found" } };
                    Undo.DestroyObjectImmediate(go);
                    return new Dictionary<string, object> { { "destroyed", true } };
                }

                case "add_component":
                {
                    var go = ToolRegistry.FindGameObject(args);
                    if (go == null) return new Dictionary<string, object> { { "error", "GameObject not found" } };

                    var compType = ToolRegistry.GetString(args, "componentType");
                    if (string.IsNullOrEmpty(compType))
                        return new Dictionary<string, object> { { "error", "componentType is required" } };

                    var type = ToolRegistry.FindType(compType);
                    if (type == null)
                        return new Dictionary<string, object> { { "error", $"Type '{compType}' not found" } };

                    var comp = Undo.AddComponent(go, type);
                    return new Dictionary<string, object>
                    {
                        { "added", comp.GetType().Name },
                        { "gameObject", go.name }
                    };
                }

                case "remove_component":
                {
                    var go = ToolRegistry.FindGameObject(args);
                    if (go == null) return new Dictionary<string, object> { { "error", "GameObject not found" } };

                    var compType = ToolRegistry.GetString(args, "componentType");
                    var comp = go.GetComponent(compType);
                    if (comp == null) return new Dictionary<string, object> { { "error", $"Component '{compType}' not found" } };

                    Undo.DestroyObjectImmediate(comp);
                    return new Dictionary<string, object> { { "removed", compType } };
                }

                case "set_parent":
                {
                    var go = ToolRegistry.FindGameObject(args);
                    if (go == null) return new Dictionary<string, object> { { "error", "GameObject not found" } };

                    var parentName = ToolRegistry.GetString(args, "parentName");
                    if (string.IsNullOrEmpty(parentName))
                    {
                        Undo.SetTransformParent(go.transform, null, "MCP Set Parent");
                    }
                    else
                    {
                        var parent = GameObject.Find(parentName);
                        if (parent == null) return new Dictionary<string, object> { { "error", $"Parent '{parentName}' not found" } };
                        Undo.SetTransformParent(go.transform, parent.transform, "MCP Set Parent");
                    }

                    return new Dictionary<string, object> { { "parent", parentName ?? "root" } };
                }

                case "set_active":
                {
                    var go = ToolRegistry.FindGameObject(args);
                    if (go == null) return new Dictionary<string, object> { { "error", "GameObject not found" } };

                    var active = ToolRegistry.GetBool(args, "active", true);
                    Undo.RecordObject(go, "MCP Set Active");
                    go.SetActive(active);
                    return new Dictionary<string, object> { { "active", active } };
                }

                default:
                    return new Dictionary<string, object> { { "error", $"Unknown action: {action}" } };
            }
        }
    }
}

#endif
