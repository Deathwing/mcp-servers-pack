// PhysicsTools — physics queries and settings inspection.

#if UNITY_EDITOR

using System;
using System.Collections.Generic;
using System.Linq;

using UnityEditor;

using UnityEngine;

namespace UnityMCP
{
    internal static class PhysicsTools
    {
        [MCPTool("manage_physics", Description = "Perform physics queries (raycast, overlap), inspect Collider/Rigidbody, and read physics settings")]
        [MCPParam("action", Required = true, EnumValues = new[] { "raycast", "overlap_sphere", "overlap_box", "get_colliders", "get_rigidbody", "get_settings" }, Description = "Action to perform")]
        [MCPParam("origin", Type = "object", Description = "Ray origin {x, y, z}")]
        [MCPParam("direction", Type = "object", Description = "Ray direction {x, y, z}")]
        [MCPParam("center", Type = "object", Description = "Sphere/box center {x, y, z}")]
        [MCPParam("radius", Type = "number", Description = "Sphere radius")]
        [MCPParam("halfExtents", Type = "object", Description = "Box half extents {x, y, z}")]
        [MCPParam("maxDistance", Type = "number", Description = "Raycast max distance (default: 1000)")]
        [MCPParam("layerMask", Type = "number", Description = "Layer mask (default: -1 = all)")]
        [MCPParam("name", Description = "GameObject name or path")]
        [MCPParam("instanceId", Type = "number", Description = "Instance ID of the GameObject")]
        internal static object ManagePhysics(Dictionary<string, object> args)
        {
            var action = ToolRegistry.GetString(args, "action");

            switch (action)
            {
                case "raycast":
                    {
                        if (!args.ContainsKey("origin") || !args.ContainsKey("direction"))
                            return new Dictionary<string, object> { { "error", "origin and direction are required" } };

                        var origin = DictToVec3(args["origin"] as Dictionary<string, object>);
                        var direction = DictToVec3(args["direction"] as Dictionary<string, object>);
                        var maxDist = ToolRegistry.GetFloat(args, "maxDistance", 1000f);
                        var layerMask = ToolRegistry.GetInt(args, "layerMask", -1);

                        var hits = Physics.RaycastAll(origin, direction.normalized, maxDist, layerMask);
                        var results = hits
                            .OrderBy(h => h.distance)
                            .Take(20)
                            .Select(h => new Dictionary<string, object>
                            {
                            { "gameObject", h.collider.gameObject.name },
                            { "path", ToolRegistry.GetGameObjectPath(h.collider.gameObject) },
                            { "point", Vec3ToDict(h.point) },
                            { "normal", Vec3ToDict(h.normal) },
                            { "distance", h.distance },
                            { "colliderType", h.collider.GetType().Name }
                            })
                            .ToList();

                        return new Dictionary<string, object> { { "hits", results }, { "count", results.Count } };
                    }

                case "overlap_sphere":
                    {
                        if (!args.ContainsKey("center"))
                            return new Dictionary<string, object> { { "error", "center is required" } };

                        var center = DictToVec3(args["center"] as Dictionary<string, object>);
                        var radius = ToolRegistry.GetFloat(args, "radius", 5f);
                        var layerMask = ToolRegistry.GetInt(args, "layerMask", -1);

                        var colliders = Physics.OverlapSphere(center, radius, layerMask);
                        var results = colliders.Take(50).Select(c => new Dictionary<string, object>
                    {
                        { "gameObject", c.gameObject.name },
                        { "path", ToolRegistry.GetGameObjectPath(c.gameObject) },
                        { "colliderType", c.GetType().Name },
                        { "isTrigger", c.isTrigger }
                    }).ToList();

                        return new Dictionary<string, object> { { "colliders", results }, { "count", results.Count } };
                    }

                case "overlap_box":
                    {
                        if (!args.ContainsKey("center") || !args.ContainsKey("halfExtents"))
                            return new Dictionary<string, object> { { "error", "center and halfExtents are required" } };

                        var center = DictToVec3(args["center"] as Dictionary<string, object>);
                        var halfExtents = DictToVec3(args["halfExtents"] as Dictionary<string, object>);
                        var layerMask = ToolRegistry.GetInt(args, "layerMask", -1);

                        var colliders = Physics.OverlapBox(center, halfExtents, Quaternion.identity, layerMask);
                        var results = colliders.Take(50).Select(c => new Dictionary<string, object>
                    {
                        { "gameObject", c.gameObject.name },
                        { "path", ToolRegistry.GetGameObjectPath(c.gameObject) },
                        { "colliderType", c.GetType().Name },
                        { "isTrigger", c.isTrigger }
                    }).ToList();

                        return new Dictionary<string, object> { { "colliders", results }, { "count", results.Count } };
                    }

                case "get_colliders":
                    {
                        var go = ToolRegistry.FindGameObject(args);
                        if (go == null) return new Dictionary<string, object> { { "error", "GameObject not found" } };

                        var colliders = go.GetComponentsInChildren<Collider>().Select(c =>
                        {
                            var info = new Dictionary<string, object>
                            {
                            { "type", c.GetType().Name },
                            { "gameObject", c.gameObject.name },
                            { "enabled", c.enabled },
                            { "isTrigger", c.isTrigger },
                            { "bounds", Vec3ToDict(c.bounds.size) }
                            };

                            if (c is BoxCollider box)
                            {
                                info["center"] = Vec3ToDict(box.center);
                                info["size"] = Vec3ToDict(box.size);
                            }
                            else if (c is SphereCollider sphere)
                            {
                                info["center"] = Vec3ToDict(sphere.center);
                                info["radius"] = sphere.radius;
                            }
                            else if (c is CapsuleCollider capsule)
                            {
                                info["center"] = Vec3ToDict(capsule.center);
                                info["radius"] = capsule.radius;
                                info["height"] = capsule.height;
                                info["direction"] = capsule.direction;
                            }
                            else if (c is MeshCollider mesh)
                            {
                                info["convex"] = mesh.convex;
                                info["sharedMesh"] = mesh.sharedMesh?.name;
                            }

                            return info;
                        }).ToList();

                        return new Dictionary<string, object> { { "colliders", colliders }, { "count", colliders.Count } };
                    }

                case "get_rigidbody":
                    {
                        var go = ToolRegistry.FindGameObject(args);
                        if (go == null) return new Dictionary<string, object> { { "error", "GameObject not found" } };

                        var rb = go.GetComponent<Rigidbody>();
                        if (rb == null)
                            return new Dictionary<string, object> { { "error", "No Rigidbody found" } };

                        return new Dictionary<string, object>
                    {
                        { "gameObject", go.name },
                        { "mass", rb.mass },
                        { "linearDamping", rb.linearDamping },
                        { "angularDamping", rb.angularDamping },
                        { "useGravity", rb.useGravity },
                        { "isKinematic", rb.isKinematic },
                        { "interpolation", rb.interpolation.ToString() },
                        { "collisionDetectionMode", rb.collisionDetectionMode.ToString() },
                        { "constraints", rb.constraints.ToString() },
                        { "position", Vec3ToDict(rb.position) },
                        { "velocity", Application.isPlaying ? (object)Vec3ToDict(rb.linearVelocity) : "N/A (edit mode)" },
                        { "angularVelocity", Application.isPlaying ? (object)Vec3ToDict(rb.angularVelocity) : "N/A (edit mode)" }
                    };
                    }

                case "get_settings":
                    {
                        return new Dictionary<string, object>
                    {
                        { "gravity", Vec3ToDict(Physics.gravity) },
                        { "defaultSolverIterations", Physics.defaultSolverIterations },
                        { "defaultSolverVelocityIterations", Physics.defaultSolverVelocityIterations },
                        { "bounceThreshold", Physics.bounceThreshold },
                        { "sleepThreshold", Physics.sleepThreshold },
                        { "defaultContactOffset", Physics.defaultContactOffset },
                        { "defaultMaxAngularSpeed", Physics.defaultMaxAngularSpeed },
                        { "autoSimulation", Physics.simulationMode.ToString() }
                    };
                    }

                default:
                    return new Dictionary<string, object> { { "error", $"Unknown action: {action}" } };
            }
        }

        private static Dictionary<string, object> Vec3ToDict(Vector3 v)
        {
            return new Dictionary<string, object> { { "x", v.x }, { "y", v.y }, { "z", v.z } };
        }

        private static Vector3 DictToVec3(Dictionary<string, object> dict)
        {
            if (dict == null) return Vector3.zero;
            return new Vector3(
                dict.ContainsKey("x") ? Convert.ToSingle(dict["x"]) : 0f,
                dict.ContainsKey("y") ? Convert.ToSingle(dict["y"]) : 0f,
                dict.ContainsKey("z") ? Convert.ToSingle(dict["z"]) : 0f
            );
        }
    }
}

#endif
