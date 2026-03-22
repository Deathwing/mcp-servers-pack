// TransformTools — transform convenience operations.

#if UNITY_EDITOR

using System;
using System.Collections.Generic;

using UnityEditor;

using UnityEngine;

namespace UnityMCP
{
    internal static class TransformTools
    {
        [MCPTool("manage_transform", Description = "Get or set Transform properties (position, rotation, scale, parent) with convenience operations like look_at and reset")]
        [MCPParam("action", Required = true, EnumValues = new[] { "get", "set", "look_at", "reset", "world_to_local", "local_to_world" }, Description = "Action to perform")]
        [MCPParam("name", Description = "GameObject name or path")]
        [MCPParam("instanceId", Type = "number", Description = "Instance ID of the GameObject")]
        [MCPParam("space", EnumValues = new[] { "world", "local" }, Description = "Coordinate space (default: world)")]
        [MCPParam("position", Type = "object", Description = "Position {x, y, z}")]
        [MCPParam("rotation", Type = "object", Description = "Euler rotation {x, y, z}")]
        [MCPParam("scale", Type = "object", Description = "Local scale {x, y, z}")]
        [MCPParam("targetName", Description = "Target GameObject name for look_at")]
        [MCPParam("point", Type = "object", Description = "Point {x, y, z} for look_at, world_to_local, or local_to_world")]
        internal static object ManageTransform(Dictionary<string, object> args)
        {
            var action = ToolRegistry.GetString(args, "action");

            var go = ToolRegistry.FindGameObject(args);
            if (go == null) return new Dictionary<string, object> { { "error", "GameObject not found" } };

            var t = go.transform;

            switch (action)
            {
                case "get":
                    {
                        var space = ToolRegistry.GetString(args, "space", "world");
                        return new Dictionary<string, object>
                    {
                        { "gameObject", go.name },
                        { "space", space },
                        { "position", Vec3ToDict(space == "local" ? t.localPosition : t.position) },
                        { "rotation", Vec3ToDict(space == "local" ? t.localEulerAngles : t.eulerAngles) },
                        { "localScale", Vec3ToDict(t.localScale) },
                        { "lossyScale", Vec3ToDict(t.lossyScale) },
                        { "parent", t.parent != null ? ToolRegistry.GetGameObjectPath(t.parent.gameObject) : null },
                        { "childCount", t.childCount }
                    };
                    }

                case "set":
                    {
                        Undo.RecordObject(t, "MCP Set Transform");
                        var space = ToolRegistry.GetString(args, "space", "world");

                        if (args.ContainsKey("position"))
                        {
                            var pos = DictToVec3(args["position"] as Dictionary<string, object>, space == "local" ? t.localPosition : t.position);
                            if (space == "local") t.localPosition = pos;
                            else t.position = pos;
                        }

                        if (args.ContainsKey("rotation"))
                        {
                            var rot = DictToVec3(args["rotation"] as Dictionary<string, object>, space == "local" ? t.localEulerAngles : t.eulerAngles);
                            if (space == "local") t.localEulerAngles = rot;
                            else t.eulerAngles = rot;
                        }

                        if (args.ContainsKey("scale"))
                        {
                            var scale = DictToVec3(args["scale"] as Dictionary<string, object>, t.localScale);
                            t.localScale = scale;
                        }

                        return new Dictionary<string, object>
                    {
                        { "gameObject", go.name },
                        { "position", Vec3ToDict(t.position) },
                        { "rotation", Vec3ToDict(t.eulerAngles) },
                        { "localScale", Vec3ToDict(t.localScale) }
                    };
                    }

                case "look_at":
                    {
                        Undo.RecordObject(t, "MCP Look At");
                        if (args.ContainsKey("targetName"))
                        {
                            var target = GameObject.Find(ToolRegistry.GetString(args, "targetName"));
                            if (target == null) return new Dictionary<string, object> { { "error", "Target not found" } };
                            t.LookAt(target.transform);
                        }
                        else if (args.ContainsKey("point"))
                        {
                            var pt = DictToVec3(args["point"] as Dictionary<string, object>, Vector3.zero);
                            t.LookAt(pt);
                        }
                        else
                        {
                            return new Dictionary<string, object> { { "error", "targetName or point is required" } };
                        }

                        return new Dictionary<string, object>
                    {
                        { "gameObject", go.name },
                        { "rotation", Vec3ToDict(t.eulerAngles) }
                    };
                    }

                case "reset":
                    {
                        Undo.RecordObject(t, "MCP Reset Transform");
                        t.localPosition = Vector3.zero;
                        t.localRotation = Quaternion.identity;
                        t.localScale = Vector3.one;
                        return new Dictionary<string, object> { { "gameObject", go.name }, { "reset", true } };
                    }

                case "world_to_local":
                    {
                        if (!args.ContainsKey("point"))
                            return new Dictionary<string, object> { { "error", "point is required" } };
                        var world = DictToVec3(args["point"] as Dictionary<string, object>, Vector3.zero);
                        var local = t.InverseTransformPoint(world);
                        return new Dictionary<string, object> { { "local", Vec3ToDict(local) } };
                    }

                case "local_to_world":
                    {
                        if (!args.ContainsKey("point"))
                            return new Dictionary<string, object> { { "error", "point is required" } };
                        var local = DictToVec3(args["point"] as Dictionary<string, object>, Vector3.zero);
                        var world = t.TransformPoint(local);
                        return new Dictionary<string, object> { { "world", Vec3ToDict(world) } };
                    }

                default:
                    return new Dictionary<string, object> { { "error", $"Unknown action: {action}" } };
            }
        }

        private static Dictionary<string, object> Vec3ToDict(Vector3 v)
        {
            return new Dictionary<string, object> { { "x", v.x }, { "y", v.y }, { "z", v.z } };
        }

        private static Vector3 DictToVec3(Dictionary<string, object> dict, Vector3 fallback)
        {
            if (dict == null) return fallback;
            return new Vector3(
                dict.ContainsKey("x") ? Convert.ToSingle(dict["x"]) : fallback.x,
                dict.ContainsKey("y") ? Convert.ToSingle(dict["y"]) : fallback.y,
                dict.ContainsKey("z") ? Convert.ToSingle(dict["z"]) : fallback.z
            );
        }
    }
}

#endif
