// ProfilerTools — profiler, memory, and performance stats.

#if UNITY_EDITOR

using System;
using System.Collections.Generic;

using UnityEditor;

using UnityEngine;
using UnityEngine.Profiling;

namespace UnityMCP
{
    internal static class ProfilerTools
    {
        [MCPTool("manage_profiler", Description = "Get memory usage, GC stats, frame timing, and asset memory breakdown")]
        [MCPParam("action", Required = true, EnumValues = new[] { "memory_summary", "asset_memory", "frame_timing", "gc_info" }, Description = "Action to perform")]
        internal static object ManageProfiler(Dictionary<string, object> args)
        {
            var action = ToolRegistry.GetString(args, "action");

            switch (action)
            {
                case "memory_summary":
                    {
                        var totalReserved = Profiler.GetTotalReservedMemoryLong();
                        var totalAllocated = Profiler.GetTotalAllocatedMemoryLong();
                        var totalUnused = Profiler.GetTotalUnusedReservedMemoryLong();
                        var monoHeap = Profiler.GetMonoHeapSizeLong();
                        var monoUsed = Profiler.GetMonoUsedSizeLong();
                        var gfxReserved = Profiler.GetAllocatedMemoryForGraphicsDriver();

                        return new Dictionary<string, object>
                    {
                        { "totalReservedMB", totalReserved / (1024.0 * 1024.0) },
                        { "totalAllocatedMB", totalAllocated / (1024.0 * 1024.0) },
                        { "totalUnusedMB", totalUnused / (1024.0 * 1024.0) },
                        { "monoHeapMB", monoHeap / (1024.0 * 1024.0) },
                        { "monoUsedMB", monoUsed / (1024.0 * 1024.0) },
                        { "graphicsDriverMB", gfxReserved / (1024.0 * 1024.0) },
                        { "systemMemoryMB", SystemInfo.systemMemorySize },
                        { "graphicsMemoryMB", SystemInfo.graphicsMemorySize }
                    };
                    }

                case "asset_memory":
                    {
                        var textures = Resources.FindObjectsOfTypeAll<Texture>();
                        long textureMemory = 0;
                        int textureCount = 0;
                        foreach (var tex in textures)
                        {
                            textureMemory += Profiler.GetRuntimeMemorySizeLong(tex);
                            textureCount++;
                        }

                        var meshes = Resources.FindObjectsOfTypeAll<Mesh>();
                        long meshMemory = 0;
                        int meshCount = 0;
                        foreach (var mesh in meshes)
                        {
                            meshMemory += Profiler.GetRuntimeMemorySizeLong(mesh);
                            meshCount++;
                        }

                        var materials = Resources.FindObjectsOfTypeAll<Material>();
                        long matMemory = 0;
                        int matCount = 0;
                        foreach (var mat in materials)
                        {
                            matMemory += Profiler.GetRuntimeMemorySizeLong(mat);
                            matCount++;
                        }

                        var audioClips = Resources.FindObjectsOfTypeAll<AudioClip>();
                        long audioMemory = 0;
                        int audioCount = 0;
                        foreach (var clip in audioClips)
                        {
                            audioMemory += Profiler.GetRuntimeMemorySizeLong(clip);
                            audioCount++;
                        }

                        return new Dictionary<string, object>
                    {
                        { "textures", new Dictionary<string, object>
                            { { "count", textureCount }, { "memoryMB", textureMemory / (1024.0 * 1024.0) } }
                        },
                        { "meshes", new Dictionary<string, object>
                            { { "count", meshCount }, { "memoryMB", meshMemory / (1024.0 * 1024.0) } }
                        },
                        { "materials", new Dictionary<string, object>
                            { { "count", matCount }, { "memoryMB", matMemory / (1024.0 * 1024.0) } }
                        },
                        { "audioClips", new Dictionary<string, object>
                            { { "count", audioCount }, { "memoryMB", audioMemory / (1024.0 * 1024.0) } }
                        }
                    };
                    }

                case "frame_timing":
                    {
                        if (!Application.isPlaying)
                        {
                            return new Dictionary<string, object>
                        {
                            { "isPlaying", false },
                            { "message", "Frame timing is only meaningful during Play mode. Current editor frame stats provided." },
                            { "targetFrameRate", Application.targetFrameRate },
                            { "vSyncCount", QualitySettings.vSyncCount },
                            { "qualityLevel", QualitySettings.names[QualitySettings.GetQualityLevel()] }
                        };
                        }

                        return new Dictionary<string, object>
                    {
                        { "isPlaying", true },
                        { "deltaTime", Time.deltaTime },
                        { "smoothDeltaTime", Time.smoothDeltaTime },
                        { "fps", 1f / Time.smoothDeltaTime },
                        { "frameCount", Time.frameCount },
                        { "realtimeSinceStartup", Time.realtimeSinceStartup },
                        { "timeScale", Time.timeScale },
                        { "targetFrameRate", Application.targetFrameRate },
                        { "vSyncCount", QualitySettings.vSyncCount }
                    };
                    }

                case "gc_info":
                    {
                        var gcCount = new int[GC.MaxGeneration + 1];
                        for (int i = 0; i <= GC.MaxGeneration; i++)
                            gcCount[i] = GC.CollectionCount(i);

                        return new Dictionary<string, object>
                    {
                        { "totalMemoryMB", GC.GetTotalMemory(false) / (1024.0 * 1024.0) },
                        { "maxGeneration", GC.MaxGeneration },
                        { "collectionCounts", gcCount },
                        { "monoHeapMB", Profiler.GetMonoHeapSizeLong() / (1024.0 * 1024.0) },
                        { "monoUsedMB", Profiler.GetMonoUsedSizeLong() / (1024.0 * 1024.0) }
                    };
                    }

                default:
                    return new Dictionary<string, object> { { "error", $"Unknown action: {action}" } };
            }
        }
    }
}

#endif
