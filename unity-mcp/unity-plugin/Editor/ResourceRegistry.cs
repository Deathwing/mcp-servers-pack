// UnityMCP — Resource registry for MCP Resources protocol.
// Exposes project info, scene hierarchy, and console logs as resources.

#if UNITY_EDITOR

using System;
using System.Collections.Generic;
using System.Linq;

using UnityEditor;
using UnityEditor.SceneManagement;

using UnityEngine;
using UnityEngine.SceneManagement;

namespace UnityMCP
{
    public static class ResourceRegistry
    {
        public static object ListResources()
        {
            var resources = new List<object>
            {
                new Dictionary<string, object>
                {
                    { "uri", "unity://project/info" },
                    { "name", "Project Info" },
                    { "description", "Unity project settings, platform, and version info" },
                    { "mimeType", "application/json" }
                },
                new Dictionary<string, object>
                {
                    { "uri", "unity://scene/hierarchy" },
                    { "name", "Scene Hierarchy" },
                    { "description", "Current scene's GameObject hierarchy tree" },
                    { "mimeType", "application/json" }
                },
                new Dictionary<string, object>
                {
                    { "uri", "unity://console/logs" },
                    { "name", "Console Logs" },
                    { "description", "Recent Unity console log entries" },
                    { "mimeType", "application/json" }
                },
                new Dictionary<string, object>
                {
                    { "uri", "unity://build/settings" },
                    { "name", "Build Settings" },
                    { "description", "Build target, scenes in build, scripting backend" },
                    { "mimeType", "application/json" }
                }
            };

            return new Dictionary<string, object> { { "resources", resources } };
        }

        public static object ReadResource(string uri)
        {
            switch (uri)
            {
                case "unity://project/info":
                    return ReadProjectInfo();
                case "unity://scene/hierarchy":
                    return ReadSceneHierarchy();
                case "unity://console/logs":
                    return ReadConsoleLogs();
                case "unity://build/settings":
                    return ReadBuildSettings();
                default:
                    throw new ArgumentException($"Unknown resource URI: {uri}");
            }
        }

        private static object ReadProjectInfo()
        {
            return new Dictionary<string, object>
            {
                { "uri", "unity://project/info" },
                { "mimeType", "application/json" },
                { "text", MiniJSON.Serialize(new Dictionary<string, object>
                    {
                        { "productName", Application.productName },
                        { "companyName", Application.companyName },
                        { "version", Application.version },
                        { "unityVersion", Application.unityVersion },
                        { "platform", Application.platform.ToString() },
                        { "buildTarget", EditorUserBuildSettings.activeBuildTarget.ToString() },
                        { "scriptingBackend", PlayerSettings.GetScriptingBackend(EditorUserBuildSettings.selectedBuildTargetGroup).ToString() },
                        { "dataPath", Application.dataPath },
                        { "isPlaying", EditorApplication.isPlaying }
                    })
                }
            };
        }

        private static object ReadSceneHierarchy()
        {
            var scene = SceneManager.GetActiveScene();
            var roots = scene.GetRootGameObjects();
            var hierarchy = new List<object>();

            foreach (var root in roots)
                hierarchy.Add(BuildHierarchyNode(root.transform, 0, 3)); // depth limit 3

            return new Dictionary<string, object>
            {
                { "uri", "unity://scene/hierarchy" },
                { "mimeType", "application/json" },
                { "text", MiniJSON.Serialize(new Dictionary<string, object>
                    {
                        { "sceneName", scene.name },
                        { "scenePath", scene.path },
                        { "rootCount", roots.Length },
                        { "hierarchy", hierarchy }
                    })
                }
            };
        }

        private static Dictionary<string, object> BuildHierarchyNode(Transform t, int depth, int maxDepth)
        {
            var node = new Dictionary<string, object>
            {
                { "name", t.name },
                { "active", t.gameObject.activeSelf },
                { "childCount", t.childCount }
            };

            var components = t.GetComponents<Component>();
            var compNames = new List<object>();
            foreach (var c in components)
            {
                if (c != null) compNames.Add(c.GetType().Name);
            }
            node["components"] = compNames;

            if (depth < maxDepth && t.childCount > 0)
            {
                var children = new List<object>();
                for (int i = 0; i < t.childCount; i++)
                    children.Add(BuildHierarchyNode(t.GetChild(i), depth + 1, maxDepth));
                node["children"] = children;
            }

            return node;
        }

        private static object ReadConsoleLogs()
        {
            // Use reflection to access LogEntries (internal Unity API)
            var entries = new List<object>();
            try
            {
                var logEntriesType = typeof(Editor).Assembly.GetType("UnityEditor.LogEntries");
                if (logEntriesType != null)
                {
                    var getCount = logEntriesType.GetMethod("GetCount",
                        System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public);
                    var startGetting = logEntriesType.GetMethod("StartGettingEntries",
                        System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public);
                    var endGetting = logEntriesType.GetMethod("EndGettingEntries",
                        System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public);
                    var getEntry = logEntriesType.GetMethod("GetEntryInternal",
                        System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public);

                    if (getCount != null && startGetting != null && endGetting != null)
                    {
                        int count = (int)getCount.Invoke(null, null);
                        int start = Math.Max(0, count - 50); // last 50 entries
                        startGetting.Invoke(null, null);

                        var logEntryType = typeof(Editor).Assembly.GetType("UnityEditor.LogEntry");
                        if (logEntryType != null && getEntry != null)
                        {
                            var entry = Activator.CreateInstance(logEntryType);
                            var messageField = logEntryType.GetField("message");
                            var modeField = logEntryType.GetField("mode");

                            for (int i = start; i < count; i++)
                            {
                                getEntry.Invoke(null, new object[] { i, entry });
                                var msg = messageField?.GetValue(entry)?.ToString() ?? "";
                                var mode = modeField?.GetValue(entry);
                                entries.Add(new Dictionary<string, object>
                                {
                                    { "index", i },
                                    { "message", msg.Length > 500 ? msg.Substring(0, 500) + "..." : msg },
                                    { "mode", mode?.ToString() ?? "" }
                                });
                            }
                        }

                        endGetting.Invoke(null, null);
                    }
                }
            }
            catch (Exception ex)
            {
                entries.Add(new Dictionary<string, object>
                {
                    { "error", $"Failed to read console: {ex.Message}" }
                });
            }

            return new Dictionary<string, object>
            {
                { "uri", "unity://console/logs" },
                { "mimeType", "application/json" },
                { "text", MiniJSON.Serialize(new Dictionary<string, object>
                    {
                        { "count", entries.Count },
                        { "entries", entries }
                    })
                }
            };
        }

        private static object ReadBuildSettings()
        {
            var scenes = new List<object>();
            foreach (var scene in EditorBuildSettings.scenes)
            {
                scenes.Add(new Dictionary<string, object>
                {
                    { "path", scene.path },
                    { "enabled", scene.enabled },
                    { "guid", scene.guid.ToString() }
                });
            }

            return new Dictionary<string, object>
            {
                { "uri", "unity://build/settings" },
                { "mimeType", "application/json" },
                { "text", MiniJSON.Serialize(new Dictionary<string, object>
                    {
                        { "activeBuildTarget", EditorUserBuildSettings.activeBuildTarget.ToString() },
                        { "targetGroup", EditorUserBuildSettings.selectedBuildTargetGroup.ToString() },
                        { "scenes", scenes },
                        { "scriptingBackend", PlayerSettings.GetScriptingBackend(EditorUserBuildSettings.selectedBuildTargetGroup).ToString() },
                        { "il2cpp", PlayerSettings.GetScriptingBackend(EditorUserBuildSettings.selectedBuildTargetGroup) == ScriptingImplementation.IL2CPP }
                    })
                }
            };
        }
    }
}

#endif
