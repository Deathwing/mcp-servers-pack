// AssetTools — manage_asset, find_in_file, find_project_assets.

#if UNITY_EDITOR

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

using UnityEditor;

using UnityEngine;

namespace UnityMCP
{
    internal static class AssetTools
    {
        [MCPTool("manage_asset", Description = "Import, move, copy, delete, or search for assets in the project")]
        [MCPParam("action", Required = true, EnumValues = new[] { "find", "get_info", "get_dependencies", "move", "copy", "delete", "import" }, Description = "Action to perform")]
        [MCPParam("path", Description = "Asset path")]
        [MCPParam("query", Description = "Search query for find action")]
        [MCPParam("destination", Description = "Destination path for move/copy")]
        [MCPParam("type", Description = "Asset type filter for find")]
        internal static object ManageAsset(Dictionary<string, object> args)
        {
            var action = ToolRegistry.GetString(args, "action");

            switch (action)
            {
                case "find":
                    {
                        var query = ToolRegistry.GetString(args, "query");
                        var type = ToolRegistry.GetString(args, "type");
                        var searchFilter = string.IsNullOrEmpty(type) ? query : $"{query} t:{type}";

                        var guids = AssetDatabase.FindAssets(searchFilter);
                        var results = guids
                            .Take(50)
                            .Select(g =>
                            {
                                var p = AssetDatabase.GUIDToAssetPath(g);
                                return new Dictionary<string, object>
                                {
                                { "path", p },
                                { "guid", g },
                                { "type", AssetDatabase.GetMainAssetTypeAtPath(p)?.Name ?? "Unknown" }
                                };
                            })
                            .ToList();

                        return new Dictionary<string, object> { { "results", results }, { "count", results.Count } };
                    }

                case "get_info":
                    {
                        var path = ToolRegistry.GetString(args, "path");
                        if (string.IsNullOrEmpty(path))
                            return new Dictionary<string, object> { { "error", "path is required" } };

                        var asset = AssetDatabase.LoadMainAssetAtPath(path);
                        if (asset == null)
                            return new Dictionary<string, object> { { "error", $"Asset not found: {path}" } };

                        return new Dictionary<string, object>
                    {
                        { "path", path },
                        { "type", asset.GetType().FullName },
                        { "name", asset.name },
                        { "guid", AssetDatabase.AssetPathToGUID(path) }
                    };
                    }

                case "get_dependencies":
                    {
                        var path = ToolRegistry.GetString(args, "path");
                        if (string.IsNullOrEmpty(path))
                            return new Dictionary<string, object> { { "error", "path is required" } };

                        var deps = AssetDatabase.GetDependencies(path, true).Where(d => d != path).ToList();
                        return new Dictionary<string, object> { { "dependencies", deps }, { "count", deps.Count } };
                    }

                case "move":
                    {
                        var path = ToolRegistry.GetString(args, "path");
                        var dest = ToolRegistry.GetString(args, "destination");
                        var result = AssetDatabase.MoveAsset(path, dest);
                        return string.IsNullOrEmpty(result)
                            ? new Dictionary<string, object> { { "moved", dest } }
                            : new Dictionary<string, object> { { "error", result } };
                    }

                case "copy":
                    {
                        var path = ToolRegistry.GetString(args, "path");
                        var dest = ToolRegistry.GetString(args, "destination");
                        var success = AssetDatabase.CopyAsset(path, dest);
                        return new Dictionary<string, object> { { "copied", success }, { "destination", dest } };
                    }

                case "delete":
                    {
                        var path = ToolRegistry.GetString(args, "path");
                        var success = AssetDatabase.DeleteAsset(path);
                        return new Dictionary<string, object> { { "deleted", success } };
                    }

                case "import":
                    {
                        var path = ToolRegistry.GetString(args, "path");
                        AssetDatabase.ImportAsset(path);
                        return new Dictionary<string, object> { { "imported", path } };
                    }

                default:
                    return new Dictionary<string, object> { { "error", $"Unknown action: {action}" } };
            }
        }

        [MCPTool("find_in_file", Description = "Search for text patterns in project files (like grep)")]
        [MCPParam("pattern", Required = true, Description = "Search pattern (supports regex)")]
        [MCPParam("filePattern", Description = "File glob pattern (e.g. '*.cs', '*.shader')")]
        [MCPParam("directory", Description = "Directory to search in (relative to Assets/)")]
        [MCPParam("maxResults", Type = "number", Description = "Maximum number of results (default: 50)")]
        internal static object FindInFile(Dictionary<string, object> args)
        {
            var pattern = ToolRegistry.GetString(args, "pattern");
            var filePattern = ToolRegistry.GetString(args, "filePattern", "*.cs");
            var directory = ToolRegistry.GetString(args, "directory", "");
            var maxResults = ToolRegistry.GetInt(args, "maxResults", 50);

            var searchDir = Path.Combine(Application.dataPath, directory);
            if (!Directory.Exists(searchDir))
                return new Dictionary<string, object> { { "error", $"Directory not found: {directory}" } };

            var results = new List<object>();
            var files = Directory.GetFiles(searchDir, filePattern, SearchOption.AllDirectories);

            System.Text.RegularExpressions.Regex regex = null;
            try
            {
                regex = new System.Text.RegularExpressions.Regex(pattern,
                    System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            }
            catch (System.ArgumentException)
            {
                // Invalid regex — fall back to simple string search
            }

            foreach (var file in files)
            {
                if (results.Count >= maxResults) break;

                string[] lines;
                try { lines = File.ReadAllLines(file); }
                catch (IOException) { continue; }
                catch (UnauthorizedAccessException) { continue; }

                for (int i = 0; i < lines.Length; i++)
                {
                    if (results.Count >= maxResults) break;

                    bool match = regex != null
                        ? regex.IsMatch(lines[i])
                        : lines[i].Contains(pattern, StringComparison.OrdinalIgnoreCase);

                    if (match)
                    {
                        results.Add(new Dictionary<string, object>
                        {
                            { "file", file.Replace(Application.dataPath + "/", "")
                                         .Replace(Application.dataPath + "\\", "") },
                            { "line", i + 1 },
                            { "text", lines[i].Trim() }
                        });
                    }
                }
            }

            return new Dictionary<string, object> { { "results", results }, { "count", results.Count } };
        }

        [MCPTool("find_project_assets", Description = "Find assets in the project by type, name, or label")]
        [MCPParam("query", Required = true, Description = "Search query")]
        [MCPParam("type", Description = "Asset type (e.g. 'Prefab', 'Material', 'Texture2D')")]
        [MCPParam("labels", Type = "array", ItemType = "string", Description = "Asset labels to filter by")]
        [MCPParam("maxResults", Type = "number", Description = "Maximum number of results (default: 50)")]
        internal static object FindProjectAssets(Dictionary<string, object> args)
        {
            var query = ToolRegistry.GetString(args, "query");
            var type = ToolRegistry.GetString(args, "type");
            var maxResults = ToolRegistry.GetInt(args, "maxResults", 50);

            var searchFilter = string.IsNullOrEmpty(type) ? query : $"{query} t:{type}";
            var guids = AssetDatabase.FindAssets(searchFilter);

            var results = guids.Take(maxResults).Select(guid =>
            {
                var path = AssetDatabase.GUIDToAssetPath(guid);
                return new Dictionary<string, object>
                {
                    { "path", path },
                    { "guid", guid },
                    { "type", AssetDatabase.GetMainAssetTypeAtPath(path)?.Name ?? "Unknown" }
                };
            }).ToList();

            return new Dictionary<string, object> { { "results", results }, { "count", results.Count } };
        }
    }
}

#endif
