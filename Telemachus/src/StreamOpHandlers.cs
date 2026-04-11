using System;
using System.Collections.Generic;
using System.Linq;
using Telemachus.CameraSnapshots;

namespace Telemachus
{
    /// <summary>
    /// v21.5: Handles 'stream/subscribe' and 'stream/unsubscribe' operations.
    /// Simplified to Action/Target structure.
    /// </summary>
    public class SubscriptionOpHandler : IStreamOpHandler
    {
        public string[] Actions => new[] { "stream/subscribe", "stream/unsubscribe" };

        public void Handle(string action, string target, Dictionary<string, object> payload, StreamSessionController controller)
        {
            if (string.IsNullOrEmpty(target)) return;

            // v18.11 Multi-camera ID logic (Unified target construction)
            string subKey = target;
            if (target == "camera" && payload.ContainsKey("id"))
            {
                try { subKey = "camera_" + Convert.ToInt32(payload["id"]); }
                catch { subKey = "camera_" + payload["id"].ToString(); }
            }

            // Route based on action
            if (action == "stream/unsubscribe")
            {
                controller.RemoveSubscriptionByKey(subKey);
            }
            else if (action == "stream/subscribe")
            {
                ISubscription sub = controller.GetSubscriptionByKey(subKey);
                if (sub == null)
                {
                    sub = CreateSubscription(target);
                    if (sub != null)
                    {
                        sub.UpdateConfig(payload);
                        controller.AddSubscription(sub);
                        sub.OnStart(controller);
                    }
                }
                else
                {
                    sub.UpdateConfig(payload);
                }
            }
        }

        private ISubscription CreateSubscription(string target)
        {
            switch (target)
            {
                case "tick": return new TickSubscription();
                case "telemetry": return new TelemetrySubscription();
                case "soundtrack": return new SoundtrackSubscription();
                case "camera": return new CameraSubscription();
                case "audio": return new AudioSubscription();
                case "orbit": return new OrbitSubscription();
                default: return null;
            }
        }
    }

    /// <summary>
    /// v21.5: Handles 'resource/list' operations.
    /// </summary>
    public class ResourceListOpHandler : IStreamOpHandler
    {
        public string[] Actions => new[] { "resource/list" };

        public void Handle(string action, string target, Dictionary<string, object> payload, StreamSessionController controller)
        {
            if (target == "cameras")
            {
                if (CameraCaptureManager.classedInstance == null) return;
                var list = CameraCaptureManager.classedInstance.cameras.Values.Select(c => new Dictionary<string, object> {
                    { "name", c.cameraManagerName() }, { "type", c.cameraType() },
                    { "fovMin", (double)c.minFOV }, { "fovMax", (double)c.maxFOV }, { "currentFov", (double)c.interpolatedFOV }
                }).ToList();
                controller.SendUnified(new Dictionary<string, object> { { "type", "cameraList" }, { "data", list } });
            }
        }
    }

    /// <summary>
    /// v21.5: Handles 'command' operations.
    /// </summary>
    public class CommandOpHandler : IStreamOpHandler
    {
        public string[] Actions => new[] { "command" };

        public void Handle(string action, string target, Dictionary<string, object> payload, StreamSessionController controller)
        {
            if (target == "camera")
            {
                string subKey = "camera_" + (payload.ContainsKey("id") ? payload["id"].ToString() : "0");
                var sub = controller.GetSubscriptionByKey(subKey) as CameraSubscription;
                if (sub != null && payload.ContainsKey("values"))
                {
                    var values = payload["values"] as Dictionary<string, object>;
                    if (values != null) sub.ForwardCommand(values);
                }
            }
            else if (target == "telemetry")
            {
                // v21.8: 'telemetry' target in 'command' action is exclusively for COMMANDS (SET actions)
                // legacy GET telemetry must use 'stream/subscribe' with target 'telemetry'.
                var values = payload.ContainsKey("values") ? payload["values"] as Dictionary<string, object> : null;
                if (values != null)
                {
                    foreach (var kvp in values)
                    {
                        try 
                        {
                            // v23.4: Structured Command Protocol { "cmd": [arg1, arg2] }
                            // Reconstruct legacy bracket syntax from structured JSON value
                            string apiString = kvp.Key;
                            if (kvp.Value is System.Collections.IList args)
                            {
                                var argList = new List<string>();
                                foreach (var arg in args) argList.Add(arg.ToString());
                                apiString += "[" + string.Join(",", argList.ToArray()) + "]";
                            }
                            else
                            {
                                apiString += "[]"; 
                            }

                            // v24.1: Execute command; discarding return value (asynchronous Zero-Legacy model)
                            controller.Socket.ProcessAPI(apiString); 
                        }
                        catch (Exception ex) 
                        { 
                            PluginLogger.print($"[CommandOp] Error processing command {kvp.Key}: {ex.Message}");
                        }
                    }
                }
            }
        }
    }
}
