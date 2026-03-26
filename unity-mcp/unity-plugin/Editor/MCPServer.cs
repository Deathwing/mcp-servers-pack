// UnityMCP — TCP server running inside the Unity Editor.
// Receives tool calls from the MCP server and executes them on the main thread.

#if UNITY_EDITOR

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

using UnityEditor;

using UnityEngine;

namespace UnityMCP
{
    [InitializeOnLoad]
    public static class MCPServer
    {
        private const string Tag = "[UnityMCP]";
        private const int DefaultPort = 52719;

        private static TcpListener _listener;
        private static CancellationTokenSource _cts;
        private static readonly ConcurrentQueue<Action> _mainThreadQueue = new();
        private static readonly List<TcpClient> _clients = new();
        private static bool _running;
        public static int ActivePort { get; private set; }

        static MCPServer()
        {
            Start();
            EditorApplication.update += ProcessMainThreadQueue;
            AssemblyReloadEvents.beforeAssemblyReload += Stop;
            AssemblyReloadEvents.afterAssemblyReload += OnAssemblyReload;
        }

        private static void OnAssemblyReload()
        {
            ToolRegistry.Reload();
            // Notify connected TS server that tools may have changed
            NotifyToolsChanged();
        }

        private static void NotifyToolsChanged()
        {
            lock (_clients)
            {
                foreach (var client in _clients)
                {
                    try
                    {
                        if (!client.Connected) continue;
                        var msg = MiniJSON.Serialize(new Dictionary<string, object>
                        {
                            { "type", "tools_changed" }
                        }) + "\n";
                        var bytes = Encoding.UTF8.GetBytes(msg);
                        client.GetStream().Write(bytes, 0, bytes.Length);
                    }
                    catch { }
                }
            }
        }

        // Shared temp-file path so the TypeScript bridge can discover the active port.
        // The filename includes an 8-char MD5 hash of the project path so multiple
        // simultaneous Unity instances each get their own file.
        private static string PortFilePath
        {
            get
            {
                var projectPath = System.IO.Path.GetDirectoryName(UnityEngine.Application.dataPath);
                using var md5 = System.Security.Cryptography.MD5.Create();
                var hashBytes = md5.ComputeHash(System.Text.Encoding.UTF8.GetBytes(projectPath ?? string.Empty));
                var hash = BitConverter.ToString(hashBytes, 0, 4).Replace("-", "").ToLowerInvariant();
                return System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"unity-mcp.{hash}.port");
            }
        }

        public static void Start()
        {
            if (_running) return;

            int startPort = DefaultPort;
            var envPort = Environment.GetEnvironmentVariable("UNITY_MCP_PORT");
            if (!string.IsNullOrEmpty(envPort) && int.TryParse(envPort, out int p))
                startPort = p;

            // Try up to 10 consecutive ports in case the preferred one is reserved.
            const int maxAttempts = 10;
            for (int attempt = 0; attempt < maxAttempts; attempt++)
            {
                int port = startPort + attempt;
                try
                {
                    _cts = new CancellationTokenSource();
                    _listener = new TcpListener(IPAddress.Loopback, port);
                    _listener.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
                    _listener.Start();
                    _running = true;
                    ActivePort = port;

                    // Write the active port so the TypeScript bridge can discover it.
                    try { System.IO.File.WriteAllText(PortFilePath, port.ToString()); } catch { }

                    if (port != startPort)
                        Debug.LogWarning($"{Tag} Port {startPort} unavailable, using {port} instead.");
                    Debug.Log($"{Tag} Listening on 127.0.0.1:{port}");
                    _ = AcceptClientsAsync(_cts.Token);
                    return;
                }
                catch (SocketException ex) when (attempt < maxAttempts - 1)
                {
                    Debug.LogWarning($"{Tag} Port {port} failed ({ex.Message}), trying next…");
                    _listener = null;
                }
                catch (Exception ex)
                {
                    Debug.LogError($"{Tag} Failed to start on port {port}: {ex.Message}");
                    return;
                }
            }
        }

        public static void Stop()
        {
            if (!_running) return;
            _running = false;

            _cts?.Cancel();
            _listener?.Stop();

            lock (_clients)
            {
                foreach (var c in _clients)
                {
                    try { c.Close(); } catch { }
                }
                _clients.Clear();
            }

            try { System.IO.File.Delete(PortFilePath); } catch { }

            Debug.Log($"{Tag} Stopped");
        }

        private static async Task AcceptClientsAsync(CancellationToken ct)
        {
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    var client = await _listener.AcceptTcpClientAsync();
                    lock (_clients) _clients.Add(client);
                    Debug.Log($"{Tag} Client connected");
                    _ = HandleClientAsync(client, ct);
                }
                catch (ObjectDisposedException) { break; }
                catch (SocketException) when (ct.IsCancellationRequested) { break; }
                catch (Exception ex)
                {
                    Debug.LogError($"{Tag} Accept error: {ex.Message}");
                }
            }
        }

        private static async Task HandleClientAsync(TcpClient client, CancellationToken ct)
        {
            var stream = client.GetStream();
            var reader = new StreamReader(stream, Encoding.UTF8);

            try
            {
                while (!ct.IsCancellationRequested && client.Connected)
                {
                    var line = await reader.ReadLineAsync();
                    if (line == null) break;

                    var trimmed = line.Trim();
                    if (string.IsNullOrEmpty(trimmed)) continue;

                    try
                    {
                        _ = ProcessRequestAsync(trimmed, stream, ct);
                    }
                    catch (Exception ex)
                    {
                        Debug.LogError($"{Tag} Parse error: {ex.Message}\nLine: {trimmed.Substring(0, Math.Min(200, trimmed.Length))}");
                    }
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                Debug.Log($"{Tag} Client disconnected: {ex.Message}");
            }
            finally
            {
                lock (_clients) _clients.Remove(client);
                try { client.Close(); } catch { }
            }
        }

        private static async Task ProcessRequestAsync(string json, NetworkStream stream, CancellationToken ct)
        {
            var dict = MiniJSON.Deserialize(json) as Dictionary<string, object>;
            if (dict == null) return;

            var id = dict.ContainsKey("id") ? dict["id"]?.ToString() : null;
            if (string.IsNullOrEmpty(id)) return;

            var type = dict.ContainsKey("type") ? dict["type"]?.ToString() : "";
            var tool = dict.ContainsKey("tool") ? dict["tool"]?.ToString() : "";
            var prms = dict.ContainsKey("params") ? dict["params"] as Dictionary<string, object> : new Dictionary<string, object>();

            if (type == "ping")
            {
                await WriteLineAsync(stream, MiniJSON.Serialize(new Dictionary<string, object>
                {
                    { "id", id },
                    { "type", "pong" }
                }), ct);
                return;
            }

            if (type == "_get_tools_metadata")
            {
                var metadata = ToolRegistry.GetToolsMetadata();
                await WriteLineAsync(stream, MiniJSON.Serialize(new Dictionary<string, object>
                {
                    { "id", id },
                    { "result", metadata }
                }), ct);
                return;
            }

            if (type == "list_tools")
            {
                var tools = ToolRegistry.GetToolNames();
                await WriteLineAsync(stream, MiniJSON.Serialize(new Dictionary<string, object>
                {
                    { "id", id },
                    { "result", tools }
                }), ct);
                return;
            }

            if (type == "list_resources")
            {
                var tcs = new TaskCompletionSource<object>();
                _mainThreadQueue.Enqueue(() =>
                {
                    try { tcs.TrySetResult(ResourceRegistry.ListResources()); }
                    catch (Exception ex) { tcs.TrySetException(ex); }
                });
                try
                {
                    var result = await WaitWithTimeout(tcs.Task, ct);
                    await WriteLineAsync(stream, MiniJSON.Serialize(new Dictionary<string, object>
                    {
                        { "id", id },
                        { "result", result }
                    }), ct);
                }
                catch (Exception ex)
                {
                    await WriteLineAsync(stream, MiniJSON.Serialize(new Dictionary<string, object>
                    {
                        { "id", id },
                        { "error", ex.Message }
                    }), ct);
                }
                return;
            }

            if (type == "read_resource")
            {
                var uri = dict.ContainsKey("uri") ? dict["uri"]?.ToString() : "";
                var tcs = new TaskCompletionSource<object>();
                _mainThreadQueue.Enqueue(() =>
                {
                    try { tcs.TrySetResult(ResourceRegistry.ReadResource(uri)); }
                    catch (Exception ex) { tcs.TrySetException(ex); }
                });
                try
                {
                    var result = await WaitWithTimeout(tcs.Task, ct);
                    await WriteLineAsync(stream, MiniJSON.Serialize(new Dictionary<string, object>
                    {
                        { "id", id },
                        { "result", result }
                    }), ct);
                }
                catch (Exception ex)
                {
                    await WriteLineAsync(stream, MiniJSON.Serialize(new Dictionary<string, object>
                    {
                        { "id", id },
                        { "error", ex.Message }
                    }), ct);
                }
                return;
            }

            if (type == "tool_call" && !string.IsNullOrEmpty(tool))
            {
                var tcs = new TaskCompletionSource<object>();

                _mainThreadQueue.Enqueue(() =>
                {
                    try
                    {
                        var result = ToolRegistry.Execute(tool, prms);
                        tcs.TrySetResult(result);
                    }
                    catch (Exception ex)
                    {
                        tcs.TrySetException(ex);
                    }
                });

                try
                {
                    var result = await WaitWithTimeout(tcs.Task, ct);
                    await WriteLineAsync(stream, MiniJSON.Serialize(new Dictionary<string, object>
                    {
                        { "id", id },
                        { "result", result }
                    }), ct);
                }
                catch (Exception ex)
                {
                    await WriteLineAsync(stream, MiniJSON.Serialize(new Dictionary<string, object>
                    {
                        { "id", id },
                        { "error", ex.Message }
                    }), ct);
                }
                return;
            }

            await WriteLineAsync(stream, MiniJSON.Serialize(new Dictionary<string, object>
            {
                { "id", id },
                { "error", $"Unknown request type: {type}" }
            }), ct);
        }

        private static async Task WriteLineAsync(NetworkStream stream, string json, CancellationToken ct)
        {
            var bytes = Encoding.UTF8.GetBytes(json + "\n");
            await stream.WriteAsync(bytes, 0, bytes.Length, ct);
            await stream.FlushAsync(ct);
        }

        private static async Task<T> WaitWithTimeout<T>(Task<T> task, CancellationToken ct, int timeoutMs = 30000)
        {
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            var delay = Task.Delay(timeoutMs, timeoutCts.Token);
            var completed = await Task.WhenAny(task, delay);
            if (completed == delay)
                throw new TimeoutException($"Main-thread execution timed out after {timeoutMs / 1000}s");
            timeoutCts.Cancel(); // cancel the delay
            return await task;
        }

        private static void ProcessMainThreadQueue()
        {
            while (_mainThreadQueue.TryDequeue(out var action))
            {
                try
                {
                    action();
                }
                catch (Exception ex)
                {
                    Debug.LogError($"{Tag} Main thread error: {ex}");
                }
            }
        }
    }
}

#endif
