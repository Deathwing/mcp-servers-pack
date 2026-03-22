// ViewTools — camera_capture, get_selection, set_selection, run_tests.

#if UNITY_EDITOR

using System;
using System.Collections.Generic;
using System.Linq;

using UnityEditor;

using UnityEngine;

namespace UnityMCP
{
    internal static class ViewTools
    {
        [MCPTool("camera_capture", Description = "Capture a screenshot from the Scene view or Game view camera")]
        [MCPParam("view", EnumValues = new[] { "scene", "game" }, Description = "Which camera view to capture")]
        [MCPParam("width", Type = "number", Description = "Image width in pixels (default: 1920)")]
        [MCPParam("height", Type = "number", Description = "Image height in pixels (default: 1080)")]
        internal static object CameraCapture(Dictionary<string, object> args)
        {
            var view = ToolRegistry.GetString(args, "view", "scene");
            var width = ToolRegistry.GetInt(args, "width", 1920);
            var height = ToolRegistry.GetInt(args, "height", 1080);

            try
            {
                Camera cam = null;

                if (view == "game")
                {
                    cam = Camera.main;
                    if (cam == null)
                        return new Dictionary<string, object> { { "error", "No main camera found" } };
                }
                else
                {
                    var sceneView = SceneView.lastActiveSceneView;
                    if (sceneView == null)
                        return new Dictionary<string, object> { { "error", "No active scene view" } };
                    cam = sceneView.camera;
                }

                var rt = new RenderTexture(width, height, 24);
                cam.targetTexture = rt;
                cam.Render();

                var tex = new Texture2D(width, height, TextureFormat.RGB24, false);
                RenderTexture.active = rt;
                tex.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                tex.Apply();

                cam.targetTexture = null;
                RenderTexture.active = null;

                var bytes = tex.EncodeToPNG();
                var base64 = Convert.ToBase64String(bytes);

                UnityEngine.Object.DestroyImmediate(rt);
                UnityEngine.Object.DestroyImmediate(tex);

                return new Dictionary<string, object>
                {
                    { "image", base64 },
                    { "format", "png" },
                    { "width", width },
                    { "height", height },
                    { "encoding", "base64" }
                };
            }
            catch (Exception ex)
            {
                return new Dictionary<string, object> { { "error", ex.Message } };
            }
        }

        [MCPTool("get_selection", Description = "Get the currently selected objects in the Unity Editor")]
        internal static object GetSelection(Dictionary<string, object> args)
        {
            var selected = Selection.gameObjects.Select(go => new Dictionary<string, object>
            {
                { "name", go.name },
                { "instanceId", go.GetInstanceID() },
                { "path", ToolRegistry.GetGameObjectPath(go) }
            }).ToList();

            return new Dictionary<string, object>
            {
                { "selection", selected },
                { "count", selected.Count },
                { "activeObject", Selection.activeGameObject?.name }
            };
        }

        [MCPTool("set_selection", Description = "Set the selected objects in the Unity Editor")]
        [MCPParam("names", Type = "array", ItemType = "string", Description = "GameObject names to select")]
        [MCPParam("instanceIds", Type = "array", ItemType = "number", Description = "Instance IDs to select")]
        internal static object SetSelection(Dictionary<string, object> args)
        {
            var objects = new List<UnityEngine.Object>();

            if (args.ContainsKey("names") && args["names"] is List<object> names)
            {
                foreach (var name in names)
                {
                    var go = GameObject.Find(name.ToString());
                    if (go != null) objects.Add(go);
                }
            }

            if (args.ContainsKey("instanceIds") && args["instanceIds"] is List<object> ids)
            {
                foreach (var id in ids)
                {
                    if (id is double d)
                    {
                        var obj = EditorUtility.InstanceIDToObject((int)d);
                        if (obj != null) objects.Add(obj);
                    }
                }
            }

            Selection.objects = objects.ToArray();
            return new Dictionary<string, object>
            {
                { "selected", objects.Count },
                { "names", objects.Select(o => o.name).ToList() }
            };
        }

        [MCPTool("run_tests", Description = "List or run Unity Test Runner tests. Listing is synchronous; running starts async—check console for results.")]
        [MCPParam("action", EnumValues = new[] { "list", "run" }, Description = "Action: list discovers tests, run executes them (default: list)")]
        [MCPParam("mode", EnumValues = new[] { "edit", "play" }, Description = "Test mode (default: edit)")]
        [MCPParam("filter", Description = "Test name substring filter")]
        internal static object RunTests(Dictionary<string, object> args)
        {
            var action = ToolRegistry.GetString(args, "action", "list");
            var mode = ToolRegistry.GetString(args, "mode", "edit");
            var filter = ToolRegistry.GetString(args, "filter", "");

            if (action == "list")
            {
                // Discover tests via reflection — no compile-time dependency on test-framework
                var tests = new List<Dictionary<string, object>>();
                foreach (var asm in System.AppDomain.CurrentDomain.GetAssemblies())
                {
                    if (asm.IsDynamic) continue;
                    System.Type[] types;
                    try { types = asm.GetTypes(); }
                    catch (System.Reflection.ReflectionTypeLoadException ex) { types = ex.Types.Where(t => t != null).ToArray(); }
                    catch { continue; }

                    foreach (var type in types)
                    {
                        System.Reflection.MethodInfo[] methods;
                        try { methods = type.GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance); }
                        catch { continue; }

                        foreach (var method in methods)
                        {
                            object[] attrs;
                            try { attrs = method.GetCustomAttributes(false); }
                            catch { continue; }

                            bool isTest = attrs.Any(a =>
                            {
                                var name = a.GetType().Name;
                                return name == "TestAttribute" || name == "UnityTestAttribute" || name == "TestCaseAttribute";
                            });
                            if (!isTest) continue;

                            var fullName = $"{type.FullName}.{method.Name}";
                            if (!string.IsNullOrEmpty(filter) && !fullName.Contains(filter, System.StringComparison.OrdinalIgnoreCase))
                                continue;

                            tests.Add(new Dictionary<string, object>
                            {
                                { "name", method.Name },
                                { "fullName", fullName },
                                { "class", type.FullName },
                                { "assembly", asm.GetName().Name }
                            });
                        }
                    }
                }
                return new Dictionary<string, object> { { "tests", tests }, { "count", tests.Count } };
            }

            if (action == "run")
            {
                // Invoke TestRunnerApi via reflection to avoid asmdef dependency
                var apiType = System.Type.GetType("UnityEditor.TestTools.TestRunner.Api.TestRunnerApi, UnityEditor.TestRunner");
                if (apiType == null)
                    return new Dictionary<string, object> { { "error", "Unity Test Framework not found. Ensure com.unity.test-framework is installed." } };

                var filterType = System.Type.GetType("UnityEditor.TestTools.TestRunner.Api.Filter, UnityEditor.TestRunner");
                var testModeType = System.Type.GetType("UnityEditor.TestTools.TestRunner.Api.TestMode, UnityEditor.TestRunner");
                var execSettingsType = System.Type.GetType("UnityEditor.TestTools.TestRunner.Api.ExecutionSettings, UnityEditor.TestRunner");
                if (filterType == null || testModeType == null || execSettingsType == null)
                    return new Dictionary<string, object> { { "error", "Test Framework API types not resolved" } };

                try
                {
                    var api = ScriptableObject.CreateInstance(apiType);
                    var filterObj = System.Activator.CreateInstance(filterType);

                    int testModeValue = mode == "play" ? 2 : 1; // EditMode=1, PlayMode=2
                    filterType.GetProperty("testMode")?.SetValue(filterObj, System.Enum.ToObject(testModeType, testModeValue));

                    if (!string.IsNullOrEmpty(filter))
                        filterType.GetProperty("testNames")?.SetValue(filterObj, new[] { filter });

                    var settings = System.Activator.CreateInstance(execSettingsType, filterObj);
                    apiType.GetMethod("Execute")?.Invoke(api, new[] { settings });

                    return new Dictionary<string, object>
                    {
                        { "status", "started" },
                        { "mode", mode },
                        { "filter", filter },
                        { "message", "Tests started. Use read_console to check results." }
                    };
                }
                catch (Exception ex)
                {
                    return new Dictionary<string, object> { { "error", $"Failed to start tests: {ex.Message}" } };
                }
            }

            return new Dictionary<string, object> { { "error", $"Unknown action: {action}. Use 'list' or 'run'." } };
        }
    }
}

#endif
