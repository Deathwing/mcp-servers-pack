// MCPToolAttribute — Attribute-based tool registration for UnityMCP.
// Decorate static methods with [MCPTool] and [MCPParam] to auto-register
// them as MCP tools with full metadata (name, description, JSON Schema).

using System;

namespace UnityMCP
{
    /// <summary>
    /// Marks a static method as an MCP tool.
    /// The method must have signature: static object MethodName(Dictionary&lt;string, object&gt; args)
    /// </summary>
    [AttributeUsage(AttributeTargets.Method)]
    public sealed class MCPToolAttribute : Attribute
    {
        public string Name { get; }
        public string Description { get; set; } = "";

        public MCPToolAttribute(string name) => Name = name;
    }

    /// <summary>
    /// Describes a parameter for an MCP tool. Apply multiple times for multiple parameters.
    /// The generated JSON Schema maps directly to the MCP inputSchema.
    /// </summary>
    [AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
    public sealed class MCPParamAttribute : Attribute
    {
        public string Name { get; }
        public string Description { get; set; } = "";
        public bool Required { get; set; }

        /// <summary>JSON Schema type: "string", "number", "boolean", "array", "object".</summary>
        public string Type { get; set; } = "string";

        /// <summary>If set, turns the parameter into a string enum with these allowed values.</summary>
        public string[] EnumValues { get; set; }

        /// <summary>For Type="array": the JSON Schema type of each item ("string", "number", etc.).</summary>
        public string ItemType { get; set; }

        /// <summary>
        /// Raw JSON Schema override. When set, replaces the auto-generated schema for this parameter.
        /// Useful for complex types like arrays of objects.
        /// </summary>
        public string JsonSchema { get; set; }

        public MCPParamAttribute(string name) => Name = name;
    }
}
