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

        public static void Start()
        {
            if (_running) return;

            int port = DefaultPort;
            var envPort = Environment.GetEnvironmentVariable("UNITY_MCP_PORT");
            if (!string.IsNullOrEmpty(envPort) && int.TryParse(envPort, out int p))
                port = p;

            try
            {
                _cts = new CancellationTokenSource();
                _listener = new TcpListener(IPAddress.Loopback, port);
                _listener.Start();
                _running = true;
                ActivePort = port;
                Debug.Log($"{Tag} Listening on 127.0.0.1:{port}");
                _ = AcceptClientsAsync(_cts.Token);
            }
            catch (Exception ex)
            {
                Debug.LogError($"{Tag} Failed to start on port {port}: {ex.Message}");
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
