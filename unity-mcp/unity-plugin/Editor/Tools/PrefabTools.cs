// PrefabTools — prefab workflow operations.

#if UNITY_EDITOR

using System;
using System.Collections.Generic;
using System.Linq;

using UnityEditor;

using UnityEngine;

namespace UnityMCP
{
    internal static class PrefabTools
    {
        [MCPTool("manage_prefab", Description = "Instantiate, inspect, apply/revert overrides, unpack, or check prefab status")]
        [MCPParam("action", Required = true, EnumValues = new[] { "instantiate", "status", "apply", "revert", "unpack", "find_prefab_assets" }, Description = "Action to perform")]
        [MCPParam("assetPath", Description = "Prefab asset path (e.g. 'Assets/Prefabs/Player.prefab')")]
        [MCPParam("name", Description = "GameObject name or path (for scene instance)")]
        [MCPParam("instanceId", Type = "number", Description = "Instance ID of the scene instance")]
        [MCPParam("parentName", Description = "Parent GameObject name for instantiation")]
        [MCPParam("query", Description = "Search query for find_prefab_assets")]
        [MCPParam("unpackMode", EnumValues = new[] { "root", "completely" }, Description = "Unpack mode (default: root)")]
        internal static object ManagePrefab(Dictionary<string, object> args)
        {
            var action = ToolRegistry.GetString(args, "action");

            switch (action)
            {
                case "instantiate":
                    {
                        var assetPath = ToolRegistry.GetString(args, "assetPath");
                        if (string.IsNullOrEmpty(assetPath))
                            return new Dictionary<string, object> { { "error", "assetPath is required" } };

                        var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
                        if (prefab == null)
                            return new Dictionary<string, object> { { "error", $"Prefab not found at '{assetPath}'" } };

                        var instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
                        Undo.RegisterCreatedObjectUndo(instance, "MCP Instantiate Prefab");

                        var parentName = ToolRegistry.GetString(args, "parentName");
                        if (!string.IsNullOrEmpty(parentName))
                        {
                            var parent = GameObject.Find(parentName);
                            if (parent != null)
                                instance.transform.SetParent(parent.transform, false);
                        }

                        return new Dictionary<string, object>
                    {
                        { "instantiated", instance.name },
                        { "instanceId", instance.GetInstanceID() },
                        { "path", ToolRegistry.GetGameObjectPath(instance) },
                        { "assetPath", assetPath }
                    };
                    }

                case "status":
                    {
                        var go = ToolRegistry.FindGameObject(args);
                        if (go == null) return new Dictionary<string, object> { { "error", "GameObject not found" } };

                        var status = PrefabUtility.GetPrefabInstanceStatus(go);
                        var type = PrefabUtility.GetPrefabAssetType(go);
                        var isPartOfPrefab = PrefabUtility.IsPartOfAnyPrefab(go);
                        var nearestRoot = PrefabUtility.GetNearestPrefabInstanceRoot(go);
                        var assetPath = PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(go);

                        var result = new Dictionary<string, object>
                    {
                        { "gameObject", go.name },
                        { "instanceStatus", status.ToString() },
                        { "assetType", type.ToString() },
                        { "isPartOfPrefab", isPartOfPrefab },
                        { "assetPath", assetPath },
                        { "nearestRoot", nearestRoot != null ? nearestRoot.name : null }
                    };

                        if (status == PrefabInstanceStatus.Connected)
                        {
                            var overrides = PrefabUtility.GetObjectOverrides(go, true);
                            var propOverrides = PrefabUtility.GetPropertyModifications(go);
                            result["overrideCount"] = overrides.Count;
                            result["propertyModificationCount"] = propOverrides?.Length ?? 0;
                            result["hasOverrides"] = PrefabUtility.HasPrefabInstanceAnyOverrides(go, false);
                        }

                        return result;
                    }

                case "apply":
                    {
                        var go = ToolRegistry.FindGameObject(args);
                        if (go == null) return new Dictionary<string, object> { { "error", "GameObject not found" } };

                        var root = PrefabUtility.GetNearestPrefabInstanceRoot(go);
                        if (root == null)
                            return new Dictionary<string, object> { { "error", "Not a prefab instance" } };

                        var assetPath = PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(root);
                        PrefabUtility.ApplyPrefabInstance(root, InteractionMode.UserAction);

                        return new Dictionary<string, object>
                    {
                        { "applied", true },
                        { "gameObject", root.name },
                        { "assetPath", assetPath }
                    };
                    }

                case "revert":
                    {
                        var go = ToolRegistry.FindGameObject(args);
                        if (go == null) return new Dictionary<string, object> { { "error", "GameObject not found" } };

                        var root = PrefabUtility.GetNearestPrefabInstanceRoot(go);
                        if (root == null)
                            return new Dictionary<string, object> { { "error", "Not a prefab instance" } };

                        PrefabUtility.RevertPrefabInstance(root, InteractionMode.UserAction);

                        return new Dictionary<string, object>
                    {
                        { "reverted", true },
                        { "gameObject", root.name }
                    };
                    }

                case "unpack":
                    {
                        var go = ToolRegistry.FindGameObject(args);
                        if (go == null) return new Dictionary<string, object> { { "error", "GameObject not found" } };

                        var root = PrefabUtility.GetNearestPrefabInstanceRoot(go);
                        if (root == null)
                            return new Dictionary<string, object> { { "error", "Not a prefab instance" } };

                        var mode = ToolRegistry.GetString(args, "unpackMode", "root") == "completely"
                            ? PrefabUnpackMode.Completely
                            : PrefabUnpackMode.OutermostRoot;

                        PrefabUtility.UnpackPrefabInstance(root, mode, InteractionMode.UserAction);

                        return new Dictionary<string, object>
                    {
                        { "unpacked", true },
                        { "gameObject", root.name },
                        { "mode", mode.ToString() }
                    };
                    }

                case "find_prefab_assets":
                    {
                        var query = ToolRegistry.GetString(args, "query");
                        var filter = string.IsNullOrEmpty(query) ? "t:Prefab" : $"t:Prefab {query}";
                        var guids = AssetDatabase.FindAssets(filter);

                        var results = guids.Take(50).Select(guid =>
                        {
                            var path = AssetDatabase.GUIDToAssetPath(guid);
                            return new Dictionary<string, object>
                            {
                            { "path", path },
                            { "name", System.IO.Path.GetFileNameWithoutExtension(path) },
                            { "guid", guid }
                            };
                        }).ToList();

                        return new Dictionary<string, object> { { "results", results }, { "count", results.Count } };
                    }

                default:
                    return new Dictionary<string, object> { { "error", $"Unknown action: {action}" } };
            }
        }
    }
}

#endif
