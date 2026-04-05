using System;
using System.Collections.Generic;
using System.Linq;
using Telemachus.CameraSnapshots;

namespace Telemachus
{
    /// <summary>
    /// Handles 'sub' and 'unsub' operations.
    /// Supports multi-camera via identifier-based keys.
    /// </summary>
    public class SubscriptionOpHandler : IStreamOpHandler
    {
        public string[] OpCodes => new[] { "sub", "subscribe", "unsub", "unsubscribe" };

        public void Handle(Dictionary<string, object> json, StreamSessionController controller)
        {
            string op = json["op"].ToString();
            if (!json.ContainsKey("stream")) return;
            string stream = json["stream"].ToString();

            // v18.11 Multi-camera Key Logic
            string key = stream;
            if (stream == "camera" && json.ContainsKey("id"))
            {
                // v18.21: Robust numeric parsing via Convert.ToInt32 (handles double/long/int from JSON)
                try
                {
                    key = "camera_" + Convert.ToInt32(json["id"]);
                }
                catch
                {
                    key = "camera_" + json["id"].ToString();
                }
            }

            // Unsubscribe logic (keyed)
            if (op == "unsub" || op == "unsubscribe")
            {
                controller.RemoveSubscriptionByKey(key);
                return;
            }

            // Subscribe logic (keyed)
            ISubscription sub = controller.GetSubscriptionByKey(key);
            if (sub == null)
            {
                sub = CreateSubscription(stream);
                if (sub != null)
                {
                    // Important: Update config BEFORE OnStart so IDs/Keys are set
                    sub.UpdateConfig(json);
                    controller.AddSubscription(sub);
                    sub.OnStart(controller);
                }
            }
            else
            {
                sub.UpdateConfig(json);
            }
        }

        private ISubscription CreateSubscription(string stream)
        {
            switch (stream)
            {
                case "tick": return new TickSubscription();
                case "telemetry":
                case "datalink": return new TelemetrySubscription();
                case "soundtrack": return new SoundtrackSubscription();
                case "camera": return new CameraSubscription();
                case "audio": return new AudioSubscription();
                default: return null;
            }
        }
    }

    /// <summary>
    /// Handles 'list' operations (resource enumeration).
    /// </summary>
    public class ResourceListOpHandler : IStreamOpHandler
    {
        public string[] OpCodes => new[] { "list" };

        public void Handle(Dictionary<string, object> json, StreamSessionController controller)
        {
            if (!json.ContainsKey("resource")) return;
            string resource = json["resource"].ToString();

            if (resource == "cameras")
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
    /// Handles 'command' operations (interactive sensor control).
    /// </summary>
    public class CommandOpHandler : IStreamOpHandler
    {
        public string[] OpCodes => new[] { "command" };

        public void Handle(Dictionary<string, object> json, StreamSessionController controller)
        {
            if (json.ContainsKey("target"))
            {
                string target = json["target"].ToString();
                if (target == "camera")
                {
                    string key = "camera_" + (json.ContainsKey("id") ? json["id"].ToString() : "0");
                    var sub = controller.GetSubscriptionByKey(key) as CameraSubscription;
                    if (sub != null) sub.ForwardCommand(json);
                }
            }
        }
    }
}
