// PackageTools — Unity Package Manager operations.

#if UNITY_EDITOR

using System;
using System.Collections.Generic;
using System.Linq;

using UnityEditor;
using UnityEditor.PackageManager;
using UnityEditor.PackageManager.Requests;

using UnityEngine;

namespace UnityMCP
{
    internal static class PackageTools
    {
        [MCPTool("manage_packages", Description = "List, add, remove, or inspect Unity Package Manager (UPM) packages")]
        [MCPParam("action", Required = true, EnumValues = new[] { "list", "add", "remove", "search", "info" }, Description = "Action to perform")]
        [MCPParam("packageId", Description = "Package identifier (e.g. 'com.unity.textmeshpro' or 'com.unity.textmeshpro@3.0.6')")]
        [MCPParam("query", Description = "Search query for package search")]
        internal static object ManagePackages(Dictionary<string, object> args)
        {
            var action = ToolRegistry.GetString(args, "action");

            switch (action)
            {
                case "list":
                    {
                        var request = Client.List(true);
                        WaitForRequest(request);

                        if (request.Status == StatusCode.Failure)
                            return new Dictionary<string, object> { { "error", request.Error?.message ?? "Failed to list packages" } };

                        var packages = request.Result.Select(p => new Dictionary<string, object>
                    {
                        { "name", p.name },
                        { "displayName", p.displayName },
                        { "version", p.version },
                        { "source", p.source.ToString() }
                    }).ToList();

                        return new Dictionary<string, object> { { "packages", packages }, { "count", packages.Count } };
                    }

                case "add":
                    {
                        var packageId = ToolRegistry.GetString(args, "packageId");
                        if (string.IsNullOrEmpty(packageId))
                            return new Dictionary<string, object> { { "error", "packageId is required" } };

                        var request = Client.Add(packageId);
                        WaitForRequest(request);

                        if (request.Status == StatusCode.Failure)
                            return new Dictionary<string, object> { { "error", request.Error?.message ?? "Failed to add package" } };

                        return new Dictionary<string, object>
                    {
                        { "added", true },
                        { "name", request.Result.name },
                        { "version", request.Result.version }
                    };
                    }

                case "remove":
                    {
                        var packageId = ToolRegistry.GetString(args, "packageId");
                        if (string.IsNullOrEmpty(packageId))
                            return new Dictionary<string, object> { { "error", "packageId is required" } };

                        var request = Client.Remove(packageId);
                        WaitForRequest(request);

                        if (request.Status == StatusCode.Failure)
                            return new Dictionary<string, object> { { "error", request.Error?.message ?? "Failed to remove package" } };

                        return new Dictionary<string, object> { { "removed", true }, { "packageId", packageId } };
                    }

                case "search":
                    {
                        var query = ToolRegistry.GetString(args, "query");
                        if (string.IsNullOrEmpty(query))
                            return new Dictionary<string, object> { { "error", "query is required" } };

                        var request = Client.Search(query);
                        WaitForRequest(request);

                        if (request.Status == StatusCode.Failure)
                            return new Dictionary<string, object> { { "error", request.Error?.message ?? "Search failed" } };

                        var packages = request.Result.Select(p => new Dictionary<string, object>
                    {
                        { "name", p.name },
                        { "displayName", p.displayName },
                        { "version", p.version },
                        { "description", p.description?.Length > 200 ? p.description.Substring(0, 200) + "..." : p.description }
                    }).ToList();

                        return new Dictionary<string, object> { { "results", packages }, { "count", packages.Count } };
                    }

                case "info":
                    {
                        var packageId = ToolRegistry.GetString(args, "packageId");
                        if (string.IsNullOrEmpty(packageId))
                            return new Dictionary<string, object> { { "error", "packageId is required" } };

                        // List installed and find the matching one
                        var listReq = Client.List(true);
                        WaitForRequest(listReq);

                        if (listReq.Status == StatusCode.Failure)
                            return new Dictionary<string, object> { { "error", "Failed to list packages" } };

                        var pkg = listReq.Result.FirstOrDefault(p => p.name == packageId);
                        if (pkg == null)
                            return new Dictionary<string, object> { { "error", $"Package '{packageId}' not found in installed packages" } };

                        var deps = pkg.dependencies.Select(d => new Dictionary<string, object>
                    {
                        { "name", d.name },
                        { "version", d.version }
                    }).ToList();

                        return new Dictionary<string, object>
                    {
                        { "name", pkg.name },
                        { "displayName", pkg.displayName },
                        { "version", pkg.version },
                        { "description", pkg.description },
                        { "source", pkg.source.ToString() },
                        { "resolvedPath", pkg.resolvedPath },
                        { "dependencies", deps },
                        { "author", pkg.author.name ?? "" }
                    };
                    }

                default:
                    return new Dictionary<string, object> { { "error", $"Unknown action: {action}" } };
            }
        }

        private static void WaitForRequest(Request request)
        {
            // Package Manager requests are async but we're on main thread, so spin-wait
            while (!request.IsCompleted)
            {
                System.Threading.Thread.Sleep(10);
            }
        }
    }
}

#endif
