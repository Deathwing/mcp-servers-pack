// EditorTools — execute_menu_item, manage_editor, read_console, evaluate_expression.

#if UNITY_EDITOR

using System;
using System.Collections.Generic;
using System.Linq;

using UnityEditor;

using UnityEngine;

namespace UnityMCP
{
    internal static class EditorTools
    {
        [MCPTool("execute_menu_item", Description = "Execute a Unity Editor menu item by path (e.g. 'Edit/Play', 'File/Save')")]
        [MCPParam("menuPath", Required = true, Description = "Full menu item path, e.g. 'Edit/Play'")]
        internal static object ExecuteMenuItem(Dictionary<string, object> args)
        {
            var menuPath = ToolRegistry.GetString(args, "menuPath");
            if (string.IsNullOrEmpty(menuPath))
                return new Dictionary<string, object> { { "error", "menuPath is required" } };

            var result = EditorApplication.ExecuteMenuItem(menuPath);
            return new Dictionary<string, object>
            {
                { "success", result },
                { "menuPath", menuPath }
            };
        }

        [MCPTool("manage_editor", Description = "Control Unity Editor state: play/pause/stop, refresh assets, compilation status")]
        [MCPParam("action", Required = true, EnumValues = new[] { "play", "pause", "stop", "step", "is_playing", "refresh_assets", "is_compiling", "get_project_info" }, Description = "Editor action to perform")]
        internal static object ManageEditor(Dictionary<string, object> args)
        {
            var action = ToolRegistry.GetString(args, "action");

            switch (action)
            {
                case "play":
                    EditorApplication.isPlaying = true;
                    return new Dictionary<string, object> { { "playing", true } };

                case "pause":
                    EditorApplication.isPaused = !EditorApplication.isPaused;
                    return new Dictionary<string, object> { { "paused", EditorApplication.isPaused } };

                case "stop":
                    EditorApplication.isPlaying = false;
                    return new Dictionary<string, object> { { "playing", false } };

                case "step":
                    EditorApplication.Step();
                    return new Dictionary<string, object> { { "stepped", true } };

                case "is_playing":
                    return new Dictionary<string, object>
                    {
                        { "isPlaying", EditorApplication.isPlaying },
                        { "isPaused", EditorApplication.isPaused }
                    };

                case "refresh_assets":
                    AssetDatabase.Refresh();
                    return new Dictionary<string, object> { { "refreshed", true } };

                case "is_compiling":
                    return new Dictionary<string, object> { { "isCompiling", EditorApplication.isCompiling } };

                case "get_project_info":
                    return new Dictionary<string, object>
                    {
                        { "projectPath", Application.dataPath },
                        { "productName", Application.productName },
                        { "companyName", Application.companyName },
                        { "unityVersion", Application.unityVersion },
                        { "platform", EditorUserBuildSettings.activeBuildTarget.ToString() },
                        { "isPlaying", EditorApplication.isPlaying },
                        { "isCompiling", EditorApplication.isCompiling }
                    };

                default:
                    return new Dictionary<string, object> { { "error", $"Unknown action: {action}" } };
            }
        }

        [MCPTool("read_console", Description = "Read Unity Editor console logs (errors, warnings, info)")]
        [MCPParam("count", Type = "number", Description = "Max number of log entries to return (default: 50)")]
        [MCPParam("filter", EnumValues = new[] { "all", "error", "warning", "log" }, Description = "Filter by log type")]
        [MCPParam("clear", Type = "boolean", Description = "Clear console after reading")]
        internal static object ReadConsole(Dictionary<string, object> args)
        {
            var count = ToolRegistry.GetInt(args, "count", 50);
            var filter = ToolRegistry.GetString(args, "filter", "all");
            var logEntries = new List<object>();

            try
            {
                var logEntriesType = Type.GetType("UnityEditor.LogEntries, UnityEditor");
                if (logEntriesType == null)
                    return new Dictionary<string, object> { { "error", "Cannot access LogEntries API" } };

                var getCountMethod = logEntriesType.GetMethod("GetCount",
                    System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public);
                var startMethod = logEntriesType.GetMethod("StartGettingEntries",
                    System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public);
                var getEntryMethod = logEntriesType.GetMethod("GetEntryInternal",
                    System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public);
                var endMethod = logEntriesType.GetMethod("EndGettingEntries",
                    System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public);

                if (getCountMethod == null || startMethod == null || endMethod == null)
                    return new Dictionary<string, object> { { "error", "LogEntries API methods not found" } };

                var totalCount = (int)getCountMethod.Invoke(null, null);
                startMethod.Invoke(null, null);

                try
                {
                    var logEntryType = Type.GetType("UnityEditor.LogEntry, UnityEditor");
                    if (logEntryType == null)
                        return new Dictionary<string, object> { { "error", "LogEntry type not found" } };

                    var entry = Activator.CreateInstance(logEntryType);
                    var messageField = logEntryType.GetField("message",
                        System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public);
                    var modeField = logEntryType.GetField("mode",
                        System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public);

                    var startIdx = Math.Max(0, totalCount - count);
                    for (int i = startIdx; i < totalCount; i++)
                    {
                        if (getEntryMethod != null)
                            getEntryMethod.Invoke(null, new object[] { i, entry });

                        var message = messageField?.GetValue(entry)?.ToString() ?? "";
                        var mode = modeField != null ? (int)modeField.GetValue(entry) : 0;

                        var logType = (mode & 1) != 0 ? "error" : (mode & 2) != 0 ? "warning" : "log";

                        if (filter != "all" && filter != logType) continue;

                        logEntries.Add(new Dictionary<string, object>
                        {
                            { "message", message },
                            { "type", logType },
                            { "index", i }
                        });
                    }
                }
                finally
                {
                    endMethod.Invoke(null, null);
                }
            }
            catch (Exception ex)
            {
                return new Dictionary<string, object> { { "error", ex.Message } };
            }

            if (ToolRegistry.GetBool(args, "clear"))
            {
                var clearMethod = Type.GetType("UnityEditor.LogEntries, UnityEditor")?
                    .GetMethod("Clear", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public);
                clearMethod?.Invoke(null, null);
            }

            return new Dictionary<string, object>
            {
                { "entries", logEntries },
                { "count", logEntries.Count }
            };
        }

        [MCPTool("evaluate_expression", Description = "Read a predefined Unity Editor property. Supports: Application.dataPath, Application.unityVersion, Application.productName, Application.companyName, Application.isPlaying, EditorApplication.isCompiling, EditorApplication.isPlaying, QualitySettings.names, Screen.width/height, SystemInfo.* properties. For complex queries use manage_editor, manage_gameobject, or manage_scene instead.")]
        [MCPParam("expression", Required = true, Description = "Property to read (e.g. 'Application.dataPath', 'SystemInfo.graphicsDeviceName')")]
        internal static object EvaluateExpression(Dictionary<string, object> args)
        {
            var expression = ToolRegistry.GetString(args, "expression");
            if (string.IsNullOrEmpty(expression))
                return new Dictionary<string, object> { { "error", "expression is required" } };

            try
            {
                // Application properties
                if (expression == "Application.dataPath")
                    return new Dictionary<string, object> { { "result", Application.dataPath } };
                if (expression == "Application.unityVersion")
                    return new Dictionary<string, object> { { "result", Application.unityVersion } };
                if (expression == "Application.productName")
                    return new Dictionary<string, object> { { "result", Application.productName } };
                if (expression == "Application.companyName")
                    return new Dictionary<string, object> { { "result", Application.companyName } };
                if (expression == "Application.isPlaying")
                    return new Dictionary<string, object> { { "result", Application.isPlaying } };
                if (expression == "Application.platform")
                    return new Dictionary<string, object> { { "result", Application.platform.ToString() } };
                if (expression == "Application.targetFrameRate")
                    return new Dictionary<string, object> { { "result", Application.targetFrameRate } };

                // Editor properties
                if (expression == "EditorApplication.isCompiling")
                    return new Dictionary<string, object> { { "result", EditorApplication.isCompiling } };
                if (expression == "EditorApplication.isPlaying")
                    return new Dictionary<string, object> { { "result", EditorApplication.isPlaying } };
                if (expression == "EditorApplication.timeSinceStartup")
                    return new Dictionary<string, object> { { "result", EditorApplication.timeSinceStartup } };

                // Quality/Screen info
                if (expression == "QualitySettings.names")
                    return new Dictionary<string, object> { { "result", QualitySettings.names.ToList() } };
                if (expression == "Screen.width")
                    return new Dictionary<string, object> { { "result", Screen.width } };
                if (expression == "Screen.height")
                    return new Dictionary<string, object> { { "result", Screen.height } };

                // SystemInfo properties
                if (expression == "SystemInfo.graphicsDeviceName")
                    return new Dictionary<string, object> { { "result", SystemInfo.graphicsDeviceName } };
                if (expression == "SystemInfo.operatingSystem")
                    return new Dictionary<string, object> { { "result", SystemInfo.operatingSystem } };
                if (expression == "SystemInfo.systemMemorySize")
                    return new Dictionary<string, object> { { "result", SystemInfo.systemMemorySize } };
                if (expression == "SystemInfo.processorType")
                    return new Dictionary<string, object> { { "result", SystemInfo.processorType } };

                // Build target
                if (expression == "EditorUserBuildSettings.activeBuildTarget")
                    return new Dictionary<string, object> { { "result", EditorUserBuildSettings.activeBuildTarget.ToString() } };

                return new Dictionary<string, object>
                {
                    { "error", $"Unknown property: '{expression}'. Supported: Application.*, EditorApplication.*, QualitySettings.names, Screen.width/height, SystemInfo.*, EditorUserBuildSettings.activeBuildTarget. For complex queries use manage_editor, manage_gameobject, or manage_scene." }
                };
            }
            catch (Exception ex)
            {
                return new Dictionary<string, object> { { "error", ex.Message } };
            }
        }
    }
}

#endif
