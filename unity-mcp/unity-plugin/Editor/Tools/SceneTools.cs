// SceneTools — manage_scene tool implementation.

#if UNITY_EDITOR

using System.Collections.Generic;
using System.Linq;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace UnityMCP
{
    internal static class SceneTools
    {
        [MCPTool("manage_scene", Description = "Query, load, save, or create scenes in the Unity project")]
        [MCPParam("action", Required = true, EnumValues = new[] { "get_hierarchy", "get_open_scenes", "load", "save", "create" }, Description = "Action to perform")]
        [MCPParam("scenePath", Description = "Scene asset path (for load/save/create)")]
        [MCPParam("rootOnly", Type = "boolean", Description = "Only return root objects in hierarchy")]
        internal static object ManageScene(Dictionary<string, object> args)
        {
            var action = ToolRegistry.GetString(args, "action");

            switch (action)
            {
                case "get_hierarchy":
                {
                    var rootOnly = ToolRegistry.GetBool(args, "rootOnly", false);
                    var scene = SceneManager.GetActiveScene();
                    var roots = scene.GetRootGameObjects();
                    var hierarchy = new List<object>();

                    foreach (var root in roots)
                        hierarchy.Add(GameObjectToDict(root, !rootOnly, 0));

                    return new Dictionary<string, object>
                    {
                        { "scene", scene.name },
                        { "path", scene.path },
                        { "rootCount", roots.Length },
                        { "objects", hierarchy }
                    };
                }

                case "get_open_scenes":
                {
                    var scenes = new List<object>();
                    for (int i = 0; i < SceneManager.sceneCount; i++)
                    {
                        var s = SceneManager.GetSceneAt(i);
                        scenes.Add(new Dictionary<string, object>
                        {
                            { "name", s.name },
                            { "path", s.path },
                            { "isLoaded", s.isLoaded },
                            { "isDirty", s.isDirty },
                            { "rootCount", s.rootCount }
                        });
                    }
                    return scenes;
                }

                case "load":
                {
                    var path = ToolRegistry.GetString(args, "scenePath");
                    if (string.IsNullOrEmpty(path))
                        return new Dictionary<string, object> { { "error", "scenePath is required" } };
                    EditorSceneManager.OpenScene(path);
                    return new Dictionary<string, object> { { "loaded", path } };
                }

                case "save":
                {
                    EditorSceneManager.SaveOpenScenes();
                    return new Dictionary<string, object> { { "saved", true } };
                }

                case "create":
                {
                    var path = ToolRegistry.GetString(args, "scenePath");
                    if (string.IsNullOrEmpty(path))
                        return new Dictionary<string, object> { { "error", "scenePath is required" } };
                    var scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects);
                    EditorSceneManager.SaveScene(scene, path);
                    return new Dictionary<string, object> { { "created", path } };
                }

                default:
                    return new Dictionary<string, object> { { "error", $"Unknown action: {action}" } };
            }
        }

        private static Dictionary<string, object> GameObjectToDict(GameObject go, bool includeChildren, int depth)
        {
            var dict = new Dictionary<string, object>
            {
                { "name", go.name },
                { "instanceId", go.GetInstanceID() },
                { "active", go.activeSelf },
                { "tag", go.tag },
                { "layer", LayerMask.LayerToName(go.layer) },
                { "components", go.GetComponents<Component>().Where(c => c != null).Select(c => c.GetType().Name).ToList() }
            };

            if (includeChildren && depth < 10)
            {
                var children = new List<object>();
                for (int i = 0; i < go.transform.childCount; i++)
                    children.Add(GameObjectToDict(go.transform.GetChild(i).gameObject, true, depth + 1));
                if (children.Count > 0)
                    dict["children"] = children;
            }

            return dict;
        }
    }
}

#endif
