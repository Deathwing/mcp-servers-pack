// ScriptTools — manage_script, apply_text_edits tool implementations.

#if UNITY_EDITOR

using System.Collections.Generic;
using System.IO;
using System.Linq;

using UnityEditor;

using UnityEngine;

namespace UnityMCP
{
    internal static class ScriptTools
    {
        [MCPTool("manage_script", Description = "Create, read, update, or delete C# scripts in the Unity project")]
        [MCPParam("action", Required = true, EnumValues = new[] { "create", "read", "update", "delete", "list" }, Description = "Action to perform")]
        [MCPParam("path", Description = "Script path relative to Assets/ (e.g. 'Scripts/MyScript.cs')")]
        [MCPParam("content", Description = "Full script content (for create/update)")]
        [MCPParam("directory", Description = "Directory to list scripts in (for list action)")]
        internal static object ManageScript(Dictionary<string, object> args)
        {
            var action = ToolRegistry.GetString(args, "action");
            var projectPath = Application.dataPath; // .../Assets

            switch (action)
            {
                case "read":
                    {
                        var path = ToolRegistry.GetString(args, "path");
                        if (string.IsNullOrEmpty(path))
                            return new Dictionary<string, object> { { "error", "path is required" } };

                        var fullPath = Path.Combine(projectPath, path);
                        if (!File.Exists(fullPath))
                            return new Dictionary<string, object> { { "error", $"File not found: {path}" } };

                        return new Dictionary<string, object>
                    {
                        { "path", path },
                        { "content", File.ReadAllText(fullPath) },
                        { "lines", File.ReadAllLines(fullPath).Length }
                    };
                    }

                case "create":
                    {
                        var path = ToolRegistry.GetString(args, "path");
                        var content = ToolRegistry.GetString(args, "content");
                        if (string.IsNullOrEmpty(path))
                            return new Dictionary<string, object> { { "error", "path is required" } };
                        if (string.IsNullOrEmpty(content))
                            return new Dictionary<string, object> { { "error", "content is required" } };

                        var fullPath = Path.Combine(projectPath, path);
                        var dir = Path.GetDirectoryName(fullPath);
                        if (!Directory.Exists(dir))
                            Directory.CreateDirectory(dir);

                        File.WriteAllText(fullPath, content);
                        AssetDatabase.Refresh();

                        return new Dictionary<string, object> { { "created", path } };
                    }

                case "update":
                    {
                        var path = ToolRegistry.GetString(args, "path");
                        var content = ToolRegistry.GetString(args, "content");
                        if (string.IsNullOrEmpty(path))
                            return new Dictionary<string, object> { { "error", "path is required" } };
                        if (string.IsNullOrEmpty(content))
                            return new Dictionary<string, object> { { "error", "content is required" } };

                        var fullPath = Path.Combine(projectPath, path);
                        if (!File.Exists(fullPath))
                            return new Dictionary<string, object> { { "error", $"File not found: {path}" } };

                        File.WriteAllText(fullPath, content);
                        AssetDatabase.Refresh();

                        return new Dictionary<string, object> { { "updated", path } };
                    }

                case "delete":
                    {
                        var path = ToolRegistry.GetString(args, "path");
                        if (string.IsNullOrEmpty(path))
                            return new Dictionary<string, object> { { "error", "path is required" } };

                        var assetPath = "Assets/" + path;
                        if (!AssetDatabase.DeleteAsset(assetPath))
                            return new Dictionary<string, object> { { "error", $"Could not delete: {assetPath}" } };

                        return new Dictionary<string, object> { { "deleted", path } };
                    }

                case "list":
                    {
                        var directory = ToolRegistry.GetString(args, "directory", "");
                        var searchDir = Path.Combine(projectPath, directory);
                        if (!Directory.Exists(searchDir))
                            return new Dictionary<string, object> { { "error", $"Directory not found: {directory}" } };

                        var files = Directory.GetFiles(searchDir, "*.cs", SearchOption.AllDirectories)
                            .Select(f => f.Replace(projectPath + "/", "").Replace(projectPath + "\\", ""))
                            .OrderBy(f => f)
                            .ToList();

                        return new Dictionary<string, object> { { "scripts", files }, { "count", files.Count } };
                    }

                default:
                    return new Dictionary<string, object> { { "error", $"Unknown action: {action}" } };
            }
        }

        [MCPTool("apply_text_edits", Description = "Apply surgical text edits to a file (line-range replacements). More efficient than rewriting entire scripts.")]
        [MCPParam("path", Required = true, Description = "File path relative to project root")]
        [MCPParam("edits", Required = true, Type = "array", Description = "Array of edits to apply", JsonSchema = "{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"startLine\":{\"type\":\"number\",\"description\":\"1-based start line\"},\"endLine\":{\"type\":\"number\",\"description\":\"1-based end line (inclusive)\"},\"newText\":{\"type\":\"string\",\"description\":\"Replacement text\"}},\"required\":[\"startLine\",\"endLine\",\"newText\"]}}")]
        internal static object ApplyTextEdits(Dictionary<string, object> args)
        {
            var path = ToolRegistry.GetString(args, "path");
            if (string.IsNullOrEmpty(path))
                return new Dictionary<string, object> { { "error", "path is required" } };

            var projectRoot = Path.GetDirectoryName(Application.dataPath);
            var fullPath = Path.Combine(projectRoot, path);
            if (!File.Exists(fullPath))
                fullPath = Path.Combine(Application.dataPath, path);
            if (!File.Exists(fullPath))
                return new Dictionary<string, object> { { "error", $"File not found: {path}" } };

            var edits = args.ContainsKey("edits") ? args["edits"] as List<object> : null;
            if (edits == null || edits.Count == 0)
                return new Dictionary<string, object> { { "error", "edits array is required" } };

            var lines = new List<string>(File.ReadAllLines(fullPath));

            // Apply edits in reverse order to preserve line numbers
            var sortedEdits = edits
                .OfType<Dictionary<string, object>>()
                .OrderByDescending(e => ToolRegistry.GetInt(e, "startLine"))
                .ToList();

            int applied = 0, skipped = 0;
            foreach (var edit in sortedEdits)
            {
                var startLine = ToolRegistry.GetInt(edit, "startLine") - 1; // Convert to 0-based
                var endLine = ToolRegistry.GetInt(edit, "endLine") - 1;
                var newText = ToolRegistry.GetString(edit, "newText");

                if (startLine < 0 || endLine >= lines.Count || startLine > endLine)
                {
                    skipped++;
                    continue;
                }

                lines.RemoveRange(startLine, endLine - startLine + 1);
                var newLines = newText.Split('\n');
                lines.InsertRange(startLine, newLines);
                applied++;
            }

            try
            {
                File.WriteAllLines(fullPath, lines);
            }
            catch (IOException ex)
            {
                return new Dictionary<string, object> { { "error", $"Failed to write file: {ex.Message}" } };
            }

            AssetDatabase.Refresh();

            var result = new Dictionary<string, object>
            {
                { "applied", applied },
                { "path", path }
            };
            if (skipped > 0)
                result["skipped"] = skipped;
            return result;
        }
    }
}

#endif
