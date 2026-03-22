// AnimationTools — Animator/Animation inspection and control.

#if UNITY_EDITOR

using System;
using System.Collections.Generic;
using System.Linq;

using UnityEditor;
using UnityEditor.Animations;

using UnityEngine;

namespace UnityMCP
{
    internal static class AnimationTools
    {
        [MCPTool("manage_animation", Description = "Inspect Animator controllers, parameters, states, and animation clips")]
        [MCPParam("action", Required = true, EnumValues = new[] { "get_animator_info", "get_parameters", "set_parameter", "get_clips", "get_states", "get_clip_info" }, Description = "Action to perform")]
        [MCPParam("name", Description = "GameObject name or path")]
        [MCPParam("instanceId", Type = "number", Description = "Instance ID of the GameObject")]
        [MCPParam("parameterName", Description = "Animator parameter name")]
        [MCPParam("parameterValue", Description = "Parameter value to set (auto-converted to correct type)")]
        [MCPParam("assetPath", Description = "AnimatorController or AnimationClip asset path")]
        [MCPParam("layerIndex", Type = "number", Description = "Animator layer index (default: 0)")]
        internal static object ManageAnimation(Dictionary<string, object> args)
        {
            var action = ToolRegistry.GetString(args, "action");

            switch (action)
            {
                case "get_animator_info":
                    {
                        var go = ToolRegistry.FindGameObject(args);
                        if (go == null) return new Dictionary<string, object> { { "error", "GameObject not found" } };

                        var animator = go.GetComponent<Animator>();
                        if (animator == null)
                            return new Dictionary<string, object> { { "error", "No Animator component found" } };

                        var controller = animator.runtimeAnimatorController as AnimatorController;
                        var layers = new List<Dictionary<string, object>>();

                        if (controller != null)
                        {
                            for (int i = 0; i < controller.layers.Length; i++)
                            {
                                var layer = controller.layers[i];
                                layers.Add(new Dictionary<string, object>
                            {
                                { "index", i },
                                { "name", layer.name },
                                { "weight", layer.defaultWeight },
                                { "blendingMode", layer.blendingMode.ToString() },
                                { "stateCount", layer.stateMachine.states.Length }
                            });
                            }
                        }

                        return new Dictionary<string, object>
                    {
                        { "gameObject", go.name },
                        { "hasAnimator", true },
                        { "controllerName", controller?.name },
                        { "controllerPath", controller != null ? AssetDatabase.GetAssetPath(controller) : null },
                        { "layerCount", layers.Count },
                        { "layers", layers },
                        { "applyRootMotion", animator.applyRootMotion },
                        { "updateMode", animator.updateMode.ToString() },
                        { "cullingMode", animator.cullingMode.ToString() }
                    };
                    }

                case "get_parameters":
                    {
                        var go = ToolRegistry.FindGameObject(args);
                        if (go == null) return new Dictionary<string, object> { { "error", "GameObject not found" } };

                        var animator = go.GetComponent<Animator>();
                        if (animator == null)
                            return new Dictionary<string, object> { { "error", "No Animator component found" } };

                        var controller = animator.runtimeAnimatorController as AnimatorController;
                        if (controller == null)
                            return new Dictionary<string, object> { { "error", "No AnimatorController assigned" } };

                        var parameters = controller.parameters.Select(p => new Dictionary<string, object>
                    {
                        { "name", p.name },
                        { "type", p.type.ToString() },
                        { "defaultFloat", p.defaultFloat },
                        { "defaultInt", p.defaultInt },
                        { "defaultBool", p.defaultBool }
                    }).ToList();

                        return new Dictionary<string, object> { { "parameters", parameters }, { "count", parameters.Count } };
                    }

                case "set_parameter":
                    {
                        var go = ToolRegistry.FindGameObject(args);
                        if (go == null) return new Dictionary<string, object> { { "error", "GameObject not found" } };

                        var animator = go.GetComponent<Animator>();
                        if (animator == null)
                            return new Dictionary<string, object> { { "error", "No Animator component found" } };

                        var paramName = ToolRegistry.GetString(args, "parameterName");
                        if (string.IsNullOrEmpty(paramName))
                            return new Dictionary<string, object> { { "error", "parameterName is required" } };

                        var controller = animator.runtimeAnimatorController as AnimatorController;
                        if (controller == null)
                            return new Dictionary<string, object> { { "error", "No AnimatorController assigned" } };

                        var param = controller.parameters.FirstOrDefault(p => p.name == paramName);
                        if (param == null)
                            return new Dictionary<string, object> { { "error", $"Parameter '{paramName}' not found" } };

                        // Can only set runtime parameters when in Play mode
                        if (!Application.isPlaying)
                            return new Dictionary<string, object> { { "error", "Can only set parameters at runtime (Play mode)" } };

                        var valueStr = ToolRegistry.GetString(args, "parameterValue");
                        switch (param.type)
                        {
                            case AnimatorControllerParameterType.Float:
                                animator.SetFloat(paramName, float.Parse(valueStr));
                                break;
                            case AnimatorControllerParameterType.Int:
                                animator.SetInteger(paramName, int.Parse(valueStr));
                                break;
                            case AnimatorControllerParameterType.Bool:
                                animator.SetBool(paramName, bool.Parse(valueStr));
                                break;
                            case AnimatorControllerParameterType.Trigger:
                                animator.SetTrigger(paramName);
                                break;
                        }

                        return new Dictionary<string, object>
                    {
                        { "set", true },
                        { "parameter", paramName },
                        { "type", param.type.ToString() }
                    };
                    }

                case "get_clips":
                    {
                        var go = ToolRegistry.FindGameObject(args);
                        if (go == null) return new Dictionary<string, object> { { "error", "GameObject not found" } };

                        var animator = go.GetComponent<Animator>();
                        if (animator == null)
                            return new Dictionary<string, object> { { "error", "No Animator component found" } };

                        var clips = animator.runtimeAnimatorController?.animationClips;
                        if (clips == null)
                            return new Dictionary<string, object> { { "clips", new List<object>() }, { "count", 0 } };

                        var clipList = clips.Select(c => new Dictionary<string, object>
                    {
                        { "name", c.name },
                        { "length", c.length },
                        { "frameRate", c.frameRate },
                        { "wrapMode", c.wrapMode.ToString() },
                        { "isLooping", c.isLooping },
                        { "isHumanMotion", c.isHumanMotion },
                        { "legacy", c.legacy }
                    }).ToList();

                        return new Dictionary<string, object> { { "clips", clipList }, { "count", clipList.Count } };
                    }

                case "get_states":
                    {
                        var layerIndex = ToolRegistry.GetInt(args, "layerIndex", 0);
                        AnimatorController controller = null;

                        // Try from GameObject first
                        var go = ToolRegistry.FindGameObject(args);
                        if (go != null)
                        {
                            var animator = go.GetComponent<Animator>();
                            controller = animator?.runtimeAnimatorController as AnimatorController;
                        }

                        // Or from asset path
                        if (controller == null)
                        {
                            var assetPath = ToolRegistry.GetString(args, "assetPath");
                            if (!string.IsNullOrEmpty(assetPath))
                                controller = AssetDatabase.LoadAssetAtPath<AnimatorController>(assetPath);
                        }

                        if (controller == null)
                            return new Dictionary<string, object> { { "error", "No AnimatorController found" } };

                        if (layerIndex >= controller.layers.Length)
                            return new Dictionary<string, object> { { "error", $"Layer index {layerIndex} out of range (0-{controller.layers.Length - 1})" } };

                        var sm = controller.layers[layerIndex].stateMachine;
                        var states = sm.states.Select(s => new Dictionary<string, object>
                    {
                        { "name", s.state.name },
                        { "speed", s.state.speed },
                        { "motion", s.state.motion?.name },
                        { "tag", s.state.tag },
                        { "transitionCount", s.state.transitions.Length }
                    }).ToList();

                        return new Dictionary<string, object>
                    {
                        { "layer", controller.layers[layerIndex].name },
                        { "states", states },
                        { "count", states.Count },
                        { "defaultState", sm.defaultState?.name }
                    };
                    }

                case "get_clip_info":
                    {
                        var assetPath = ToolRegistry.GetString(args, "assetPath");
                        if (string.IsNullOrEmpty(assetPath))
                            return new Dictionary<string, object> { { "error", "assetPath is required" } };

                        var clip = AssetDatabase.LoadAssetAtPath<AnimationClip>(assetPath);
                        if (clip == null)
                            return new Dictionary<string, object> { { "error", $"AnimationClip not found at '{assetPath}'" } };

                        var bindings = AnimationUtility.GetCurveBindings(clip).Select(b => new Dictionary<string, object>
                    {
                        { "path", b.path },
                        { "property", b.propertyName },
                        { "type", b.type.Name }
                    }).ToList();

                        var events = AnimationUtility.GetAnimationEvents(clip).Select(e => new Dictionary<string, object>
                    {
                        { "functionName", e.functionName },
                        { "time", e.time },
                        { "parameter", e.stringParameter }
                    }).ToList();

                        return new Dictionary<string, object>
                    {
                        { "name", clip.name },
                        { "length", clip.length },
                        { "frameRate", clip.frameRate },
                        { "frameCount", (int)(clip.length * clip.frameRate) },
                        { "wrapMode", clip.wrapMode.ToString() },
                        { "isLooping", clip.isLooping },
                        { "bindings", bindings },
                        { "events", events }
                    };
                    }

                default:
                    return new Dictionary<string, object> { { "error", $"Unknown action: {action}" } };
            }
        }
    }
}

#endif
