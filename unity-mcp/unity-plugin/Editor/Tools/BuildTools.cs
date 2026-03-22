// BuildTools — build pipeline and player settings operations.

#if UNITY_EDITOR

using System;
using System.Collections.Generic;
using System.Linq;

using UnityEditor;
using UnityEditor.Build.Reporting;

using UnityEngine;

namespace UnityMCP
{
    internal static class BuildTools
    {
        [MCPTool("manage_build", Description = "Inspect build settings, switch platform, or trigger a build")]
        [MCPParam("action", Required = true, EnumValues = new[] { "get_settings", "get_scenes", "set_scenes", "switch_platform", "build", "get_player_settings" }, Description = "Action to perform")]
        [MCPParam("platform", Description = "Build target: Android, iOS, StandaloneWindows64, StandaloneOSX, WebGL")]
        [MCPParam("outputPath", Description = "Build output path (for build action)")]
        [MCPParam("scenes", Type = "array", ItemType = "string", Description = "Scene paths for set_scenes")]
        [MCPParam("options", Type = "array", ItemType = "string", Description = "Build options: Development, AllowDebugging, CompressWithLz4, etc.")]
        internal static object ManageBuild(Dictionary<string, object> args)
        {
            var action = ToolRegistry.GetString(args, "action");

            switch (action)
            {
                case "get_settings":
                    {
                        return new Dictionary<string, object>
                    {
                        { "activeBuildTarget", EditorUserBuildSettings.activeBuildTarget.ToString() },
                        { "activeScriptingBackend", PlayerSettings.GetScriptingBackend(EditorUserBuildSettings.selectedBuildTargetGroup).ToString() },
                        { "buildTargetGroup", EditorUserBuildSettings.selectedBuildTargetGroup.ToString() },
                        { "development", EditorUserBuildSettings.development },
                        { "companyName", PlayerSettings.companyName },
                        { "productName", PlayerSettings.productName },
                        { "bundleVersion", PlayerSettings.bundleVersion },
                        { "applicationIdentifier", PlayerSettings.applicationIdentifier }
                    };
                    }

                case "get_scenes":
                    {
                        var scenes = EditorBuildSettings.scenes.Select((s, i) => new Dictionary<string, object>
                    {
                        { "index", i },
                        { "path", s.path },
                        { "enabled", s.enabled },
                        { "guid", s.guid.ToString() }
                    }).ToList();

                        return new Dictionary<string, object> { { "scenes", scenes }, { "count", scenes.Count } };
                    }

                case "set_scenes":
                    {
                        if (!args.ContainsKey("scenes") || args["scenes"] is not List<object> scenePaths)
                            return new Dictionary<string, object> { { "error", "scenes array is required" } };

                        var newScenes = scenePaths.Select(p => new EditorBuildSettingsScene(p.ToString(), true)).ToArray();
                        EditorBuildSettings.scenes = newScenes;

                        return new Dictionary<string, object>
                    {
                        { "set", true },
                        { "count", newScenes.Length }
                    };
                    }

                case "switch_platform":
                    {
                        var platform = ToolRegistry.GetString(args, "platform");
                        if (string.IsNullOrEmpty(platform))
                            return new Dictionary<string, object> { { "error", "platform is required" } };

                        if (!Enum.TryParse<BuildTarget>(platform, true, out var target))
                            return new Dictionary<string, object> { { "error", $"Unknown platform: {platform}. Use Android, iOS, StandaloneWindows64, StandaloneOSX, WebGL" } };

                        var group = BuildPipeline.GetBuildTargetGroup(target);
                        var success = EditorUserBuildSettings.SwitchActiveBuildTarget(group, target);

                        return new Dictionary<string, object>
                    {
                        { "switched", success },
                        { "target", target.ToString() },
                        { "group", group.ToString() }
                    };
                    }

                case "build":
                    {
                        var outputPath = ToolRegistry.GetString(args, "outputPath");
                        if (string.IsNullOrEmpty(outputPath))
                            return new Dictionary<string, object> { { "error", "outputPath is required" } };

                        var target = EditorUserBuildSettings.activeBuildTarget;
                        if (args.ContainsKey("platform"))
                        {
                            var platform = ToolRegistry.GetString(args, "platform");
                            if (!Enum.TryParse<BuildTarget>(platform, true, out target))
                                return new Dictionary<string, object> { { "error", $"Unknown platform: {platform}" } };
                        }

                        var buildOptions = BuildOptions.None;
                        if (args.ContainsKey("options") && args["options"] is List<object> opts)
                        {
                            foreach (var opt in opts)
                            {
                                if (Enum.TryParse<BuildOptions>(opt.ToString(), true, out var bo))
                                    buildOptions |= bo;
                            }
                        }

                        var scenes = EditorBuildSettings.scenes
                            .Where(s => s.enabled)
                            .Select(s => s.path)
                            .ToArray();

                        var report = BuildPipeline.BuildPlayer(scenes, outputPath, target, buildOptions);

                        return new Dictionary<string, object>
                    {
                        { "result", report.summary.result.ToString() },
                        { "totalTime", report.summary.totalTime.TotalSeconds },
                        { "totalSize", report.summary.totalSize },
                        { "totalErrors", report.summary.totalErrors },
                        { "totalWarnings", report.summary.totalWarnings },
                        { "outputPath", report.summary.outputPath },
                        { "platform", report.summary.platform.ToString() }
                    };
                    }

                case "get_player_settings":
                    {
                        var targetGroup = EditorUserBuildSettings.selectedBuildTargetGroup;
                        return new Dictionary<string, object>
                    {
                        { "companyName", PlayerSettings.companyName },
                        { "productName", PlayerSettings.productName },
                        { "bundleVersion", PlayerSettings.bundleVersion },
                        { "applicationIdentifier", PlayerSettings.applicationIdentifier },
                        { "defaultScreenWidth", PlayerSettings.defaultScreenWidth },
                        { "defaultScreenHeight", PlayerSettings.defaultScreenHeight },
                        { "fullscreenMode", PlayerSettings.fullScreenMode.ToString() },
                        { "colorSpace", PlayerSettings.colorSpace.ToString() },
                        { "graphicsAPIs", PlayerSettings.GetGraphicsAPIs(EditorUserBuildSettings.activeBuildTarget).Select(a => a.ToString()).ToList() },
                        { "scriptingBackend", PlayerSettings.GetScriptingBackend(targetGroup).ToString() },
                        { "apiCompatibilityLevel", PlayerSettings.GetApiCompatibilityLevel(targetGroup).ToString() },
                        { "targetGroup", targetGroup.ToString() }
                    };
                    }

                default:
                    return new Dictionary<string, object> { { "error", $"Unknown action: {action}" } };
            }
        }
    }
}

#endif
