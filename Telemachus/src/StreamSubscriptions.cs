using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using Telemachus.CameraSnapshots;

namespace Telemachus
{
    public interface ISubscription
    {
        string StreamType { get; }
        string SubscriptionKey { get; }
        bool ShouldUpdate(double currentUT);
        void Execute(KSPUnifiedStreamService session);
        void UpdateConfig(Dictionary<string, object> json);

        void OnStart(StreamSessionController controller);
        void OnStop(StreamSessionController controller);
    }

    public abstract class BaseSubscription : ISubscription
    {
        public abstract string StreamType { get; }
        public virtual string SubscriptionKey => StreamType;
        public int RateMs { get; set; } = 200;
        public int MinRateMs { get; set; } = 30000; // v22.1: Default 30s heartbeat for stable states
        public bool ChangingOnly { get; set; } = false;

        protected double LastSentUT = -1;
        protected object LastSentData = null;

        public virtual bool IsDirty() => true; // Default to always active if not overridden

        public virtual void OnStart(StreamSessionController controller) { }
        public virtual void OnStop(StreamSessionController controller) { }

        public virtual bool ShouldUpdate(double currentUT)
        {
            if (LastSentUT > 0)
            {
                double elapsedMs = (currentUT - LastSentUT) * 1000.0;

                // v22.1: Dual-Rate Decision Logic
                bool dirty = IsDirty();
                int targetRate = dirty ? RateMs : MinRateMs;

                if (elapsedMs < targetRate) return false;
            }
            return true;
        }

        public abstract void Execute(KSPUnifiedStreamService session);

        public virtual void UpdateConfig(Dictionary<string, object> json)
        {
            if (json.ContainsKey("rate")) RateMs = Convert.ToInt32(json["rate"]);
            if (json.ContainsKey("maxRate")) RateMs = Convert.ToInt32(json["maxRate"]);
            if (json.ContainsKey("minRate")) MinRateMs = Convert.ToInt32(json["minRate"]);
            if (json.ContainsKey("changing")) ChangingOnly = (bool)json["changing"];
        }

        protected Dictionary<string, object> CreateUnifiedPacket(double ut, object data)
        {
            return new Dictionary<string, object> { { "type", StreamType }, { "ut", ut }, { "data", data } };
        }

        protected bool HasChanged(object newData)
        {
            if (!ChangingOnly) return true;
            if (LastSentData == null || newData == null) return true;
            if (newData is Dictionary<string, object> newDict && LastSentData is Dictionary<string, object> oldDict)
            {
                if (newDict.Count != oldDict.Count) return true;
                foreach (var kvp in newDict)
                {
                    if (!oldDict.ContainsKey(kvp.Key)) return true;
                    if (!object.Equals(kvp.Value, oldDict[kvp.Key])) return true;
                }
                return false;
            }
            return !object.Equals(newData, LastSentData);
        }
    }

    public class TickSubscription : BaseSubscription
    {
        public override string StreamType => "tick";

        public override void UpdateConfig(Dictionary<string, object> json)
        {
            base.UpdateConfig(json);
            // v18.15: Clamp rate to a maximum of 1000ms (1Hz minimum frequency)
            if (RateMs > 1000) RateMs = 1000;
        }

        public override void Execute(KSPUnifiedStreamService session)
        {
            Vessel v = FlightGlobals.ActiveVessel;
            if (v == null) return;
            double currentUT = Planetarium.GetUniversalTime();

            // v18.15: Unified "tick" payload. ut is inside data because tick IS the time source.
            var data = new Dictionary<string, object> {
                { "ut", currentUT },
                { "met", (double)v.missionTime },
                { "warp", TimeWarp.fetch != null ? TimeWarp.CurrentRate : 1.0 },
                { "delay", TelemachusSignalManager.GetSignalDelay(v) },
                { "quality", (byte)(TelemachusSignalManager.GetSignalQuality(v) * 100) }
            };

            if (HasChanged(data))
            {
                // Special case for tick: no external ut header, it's all in data
                session.SendUnifiedPacket(new Dictionary<string, object> {
                    { "type", StreamType },
                    { "data", data }
                });
                LastSentUT = currentUT; LastSentData = data;
            }
        }
    }

    public class TelemetrySubscription : BaseSubscription
    {
        public override string StreamType => "telemetry";
        private HashSet<string> keys = new HashSet<string>();
        public override void UpdateConfig(Dictionary<string, object> json)
        {
            base.UpdateConfig(json);
            if (json.ContainsKey("keys"))
            {
                var newKeys = (json["keys"] as System.Collections.IEnumerable).Cast<object>().Select(x => x.ToString().Trim());
                keys.UnionWith(newKeys);
            }
            // v18.11: Restore 'rm' support
            if (json.ContainsKey("rm"))
            {
                var delKeys = (json["rm"] as System.Collections.IEnumerable).Cast<object>().Select(x => x.ToString().Trim());
                keys.ExceptWith(delKeys);
            }
            if (json.ContainsKey("clear") && (bool)json["clear"]) keys.Clear();
        }
        public override void Execute(KSPUnifiedStreamService session)
        {
            if (keys.Count == 0) return;
            double currentUT = Planetarium.GetUniversalTime();
            var results = new Dictionary<string, object>();
            foreach (var key in keys.ToList())
            {
                try { results[key] = session.ProcessAPI(key); } catch { results[key] = null; }
            }
            if (HasChanged(results))
            {
                session.SendUnifiedPacket(CreateUnifiedPacket(currentUT, results));
                LastSentUT = currentUT; LastSentData = results;
            }
        }
    }

    public class SoundtrackSubscription : BaseSubscription
    {
        public override string StreamType => "soundtrack";
        public SoundtrackSubscription() { ChangingOnly = true; }

        // v18.11: Send current state as soon as started
        public override void OnStart(StreamSessionController controller)
        {
            Execute(controller.Socket);
        }

        public override void Execute(KSPUnifiedStreamService session)
        {
            if (MusicHandler.Instance == null) return;
            var status = MusicHandler.Instance.GetCurrentStatus();
            double currentUT = Planetarium.GetUniversalTime();
            var data = new Dictionary<string, object> {
                { "name", status.name }, { "isPlaying", status.isPlaying }, { "time", status.time }, { "duration", status.duration }
            };
            var compareData = new { status.name, status.isPlaying };
            if (HasChanged(compareData))
            {
                session.SendUnifiedPacket(CreateUnifiedPacket(currentUT, data));
                LastSentUT = currentUT; LastSentData = compareData;
            }
        }
    }

    public class AudioSubscription : ISubscription
    {
        public string StreamType => "audio";
        public string SubscriptionKey => StreamType;
        public bool ShouldUpdate(double currentUT) => false;
        public void UpdateConfig(Dictionary<string, object> json) { }
        public void Execute(KSPUnifiedStreamService session) { }

        // v18.11 Restore: Monotonic UT logic for Audio
        private ulong _fmodAudioBlockCount = 0;
        private double _lastAudioCaptureUt = -1.0;
        private int _downlinkPacketCount = 0;
        private float _lastDiagTime = 0;

        public void OnStart(StreamSessionController controller)
        {
            AudioStreamManager.EnsureInstance();
            AudioStreamManager.Instance?.Register(controller);
        }

        public void OnStop(StreamSessionController controller)
        {
            AudioStreamManager.Instance?.Unregister(controller);
        }

        public void ProcessAudio(float[] samples, KSPUnifiedStreamService session)
        {
            _fmodAudioBlockCount++;
            double currentUt = Planetarium.GetUniversalTime();
            if (_lastAudioCaptureUt < 0) _lastAudioCaptureUt = currentUt;

            double blockDuration = (double)samples.Length / 22050.0;
            _lastAudioCaptureUt += blockDuration;
            if (currentUt > _lastAudioCaptureUt) _lastAudioCaptureUt = currentUt;

            // v18.11: Ensure strictly increasing UT for jitter buffer stability
            double uniqueUt = _lastAudioCaptureUt + (_fmodAudioBlockCount % 100 * 0.00000001);

            byte[] pcm = new byte[samples.Length * 2];
            for (int i = 0; i < samples.Length; i++)
            {
                short s = (short)Mathf.Clamp(samples[i] * 32767f, -32768, 32767);
                pcm[i * 2] = (byte)(s & 0xFF); pcm[i * 2 + 1] = (byte)((s >> 8) & 0xFF);
            }

            byte[] packet = new byte[TelemachusProtocol.HEADER_SIZE + pcm.Length];
            TelemachusProtocol.FillHeader(packet, (byte)PacketType.AudioDownlink, uniqueUt, 0, 0);
            Buffer.BlockCopy(pcm, 0, packet, TelemachusProtocol.HEADER_SIZE, pcm.Length);
            session.SendBinary(packet);

            // v18.11 Restore: Audio Diagnostic Log
            _downlinkPacketCount++;
            if (Time.unscaledTime - _lastDiagTime > 2.0f)
            {
                PluginLogger.print($"[Radio-Diag] DOWNLINK ({session.ID}): {_downlinkPacketCount} pkts/2s");
                _downlinkPacketCount = 0; _lastDiagTime = Time.unscaledTime;
            }
        }
    }

    public class CameraSubscription : BaseSubscription
    {
        public override string StreamType => "camera";
        public string CameraName { get; private set; }
        public byte CameraID { get; private set; }
        private long lastSentFrameId = -1;

        // v18.11 Restore: Multi-camera logic via unique keys
        public override string SubscriptionKey => "camera_" + CameraID;

        public override void OnStart(StreamSessionController controller)
        {
            if (CameraCaptureManager.classedInstance != null)
                CameraCaptureManager.classedInstance.EnsureFlightCamera();
        }

        public override void UpdateConfig(Dictionary<string, object> json)
        {
            base.UpdateConfig(json);
            if (json.ContainsKey("name")) CameraName = json["name"].ToString();
            if (json.ContainsKey("id")) CameraID = (byte)Convert.ToInt32(json["id"]);
        }
        public override void Execute(KSPUnifiedStreamService session)
        {
            if (string.IsNullOrEmpty(CameraName)) return;
            var sensor = GetSensor(CameraName);
            if (sensor == null) return;
            sensor.lastRequestTick = Environment.TickCount;
            if (sensor.imageBytes == null || sensor.lastFrameId == lastSentFrameId) return;
            byte[] jpeg = sensor.imageBytes;
            byte[] packet = new byte[TelemachusProtocol.HEADER_SIZE + jpeg.Length];
            TelemachusProtocol.FillHeader(packet, (byte)PacketType.VideoDownlink, sensor.lastFrameUT, sensor.interpolatedFOV, CameraID);
            Buffer.BlockCopy(jpeg, 0, packet, TelemachusProtocol.HEADER_SIZE, jpeg.Length);
            session.SendBinary(packet);
            lastSentFrameId = sensor.lastFrameId; LastSentUT = Planetarium.GetUniversalTime();
        }
        public void ForwardCommand(Dictionary<string, object> json)
        {
            var sensor = GetSensor(CameraName);
            if (sensor != null) sensor.ProcessCameraCommand(json);
        }
        private CameraCapture GetSensor(string name)
        {
            if (CameraCaptureManager.classedInstance == null) return null;
            var cameras = CameraCaptureManager.classedInstance.cameras;
            if (cameras.ContainsKey(name)) return cameras[name];
            var key = cameras.Keys.FirstOrDefault(k => k.Equals(name, StringComparison.OrdinalIgnoreCase));
            return key != null ? cameras[key] : null;
        }
    }

    public class OrbitSubscription : BaseSubscription
    {
        public override string StreamType => "orbit";
        public int Resolution { get; set; } = 256;
        private bool sentMetadata = false;

        public OrbitSubscription()
        {
            RateMs = 1000;
            MinRateMs = 20000; // v22.1: 20s heartbeat for stable orbits
        }

        private double _lastSma = -1;
        private double _lastEcc = -1;
        private double _lastInc = -1;
        private int _lastNodeCount = -1;
        private double _lastNodesChecksum = -1;
        private string _lastMainBody = "";
        private string _lastTargetName = "";
        private double _lastDelay = -1;
        private double _lastQuality = -1;
        private bool _forceFullUpdate = false;

        public override bool IsDirty()
        {
            Vessel v = FlightGlobals.ActiveVessel;
            if (v == null) return false;

            // 1. Structural Change (SOI Jump)
            if (v.mainBody.name != _lastMainBody) return true;

            // 2. Maneuver Node Integrity
            int nodeCount = v.patchedConicSolver?.maneuverNodes.Count ?? 0;
            if (nodeCount != _lastNodeCount) return true;
            if (nodeCount > 0)
            {
                double checksum = v.patchedConicSolver.maneuverNodes.Sum(n => n.DeltaV.magnitude + n.UT);
                // v22.5: Relaxed threshold to 0.0001 to ignore KSP solver noise
                if (Math.Abs(checksum - _lastNodesChecksum) > 0.0001) return true;
            }

            // 3. Target Change
            var target = FlightGlobals.fetch.VesselTarget;
            string targetName = target?.GetName() ?? "";
            if (targetName != _lastTargetName) return true;

            // 4. Physical Drift (SMA/ECC change)
            double smaDiff = Math.Abs(v.orbit.semiMajorAxis - _lastSma);
            bool dDrift = smaDiff > 100.0 && smaDiff > (Math.Abs(_lastSma) * 0.0005);
            if (!dDrift) dDrift = Math.Abs(v.orbit.eccentricity - _lastEcc) > 0.0001;
            if (dDrift) return true;

            // 5. Signal State Change (v22.6: Immediate sync on delay/quality transition)
            double currentDelay = TelemachusSignalManager.GetSignalDelay(v) ?? 0;
            double currentQuality = TelemachusSignalManager.GetSignalQuality(v);
            if (Math.Abs(currentDelay - _lastDelay) >= 0.1) return true;
            if (Math.Abs(currentQuality - _lastQuality) >= 0.1) return true;

            return _forceFullUpdate;
        }

        public override void UpdateConfig(Dictionary<string, object> json)
        {
            base.UpdateConfig(json);
            if (json.ContainsKey("resolution"))
            {
                try { Resolution = Convert.ToInt32(json["resolution"]); }
                catch { Resolution = 256; }
            }
        }

        public override void Execute(KSPUnifiedStreamService session)
        {
            Vessel v = FlightGlobals.ActiveVessel;
            if (v == null) return;

            // v21.8: Automatic Metadata Push (One-time manifest)
            if (!sentMetadata)
            {
                SendMetadataManifest(session);
                sentMetadata = true;
            }

            double currentUT = Planetarium.GetUniversalTime();

            // v22.4: Simplified Dirty State (Fewer sensors, more reliability)
            // We focus on the EFFECT (Orbit change) rather than the CAUSE (Acceleration)

            // 1. Structural Change (SOI Jump)
            bool dSOI = v.mainBody.name != _lastMainBody;

            // 2. Maneuver Node Edits (Capture planning activity)
            int nodeCount = v.patchedConicSolver?.maneuverNodes.Count ?? 0;
            bool dNodes = nodeCount != _lastNodeCount;
            double checksum = 0;
            if (nodeCount > 0)
            {
                checksum = v.patchedConicSolver.maneuverNodes.Sum(n => n.DeltaV.magnitude + n.UT);
                if (!dNodes && Math.Abs(checksum - _lastNodesChecksum) > 0.0001) dNodes = true;
            }

            // 3. Target Updates
            var target = FlightGlobals.fetch.VesselTarget;
            string targetName = target?.GetName() ?? "";
            bool dTarget = targetName != _lastTargetName;

            // 4. Physical Drift (SMA/ECC change)
            double smaDiff = Math.Abs(v.orbit.semiMajorAxis - _lastSma);
            bool dDrift = smaDiff > (Math.Abs(_lastSma) * 0.0005);
            if (!dDrift) dDrift = Math.Abs(v.orbit.eccentricity - _lastEcc) > 0.0001;

            var orbitData = new Dictionary<string, object>();
            orbitData["meridianOffset"] = GetMeridianAngle();

            // 1. Vessel Data
            Vector3d vesselPos = v.orbit.getRelativePositionAtUT(currentUT);
            var vesselData = new Dictionary<string, object> {
                { "position", new Dictionary<string, double> { { "x", vesselPos.x }, { "y", vesselPos.y }, { "z", vesselPos.z } } },
                { "body", v.mainBody.name },
                { "patches", GetOrbitGroups(v.orbit, currentUT, v) }
            };

            // Track state for next dirty check (Always update when sending Full)
            _lastSma = v.orbit.semiMajorAxis;
            _lastEcc = v.orbit.eccentricity;
            _lastInc = v.orbit.inclination;
            _lastMainBody = v.mainBody.name;
            _lastDelay = TelemachusSignalManager.GetSignalDelay(v) ?? 0;
            _lastQuality = TelemachusSignalManager.GetSignalQuality(v);

            orbitData["vessel"] = vesselData;

            // 2. Target Data
            if (target != null)
            {
                Vector3d targetPos = target.GetOrbit().getRelativePositionAtUT(currentUT);
                var targetData = new Dictionary<string, object> {
                    { "name", target.GetName() },
                    { "position", new Dictionary<string, double> { { "x", targetPos.x }, { "y", targetPos.y }, { "z", targetPos.z } } },
                    { "body", target.GetOrbit().referenceBody.name },
                    { "patches", GetOrbitGroups(target.GetOrbit(), currentUT, v) }
                };
                orbitData["target"] = targetData;
                _lastTargetName = target.GetName();
            }
            else
            {
                orbitData["target"] = null;
                _lastTargetName = "";
            }

            // 3. Maneuver Nodes
            if (v.patchedConicSolver != null && v.patchedConicSolver.maneuverNodes.Count > 0)
            {
                var maneuvers = new List<object>();
                // checksum already calculated at top
                foreach (var node in v.patchedConicSolver.maneuverNodes)
                {
                    var nodeData = new Dictionary<string, object> {
                        { "ut", node.UT },
                        { "deltaV", new Dictionary<string, double> { { "x", node.DeltaV.x }, { "y", node.DeltaV.y }, { "z", node.DeltaV.z } } },
                        { "patches", GetOrbitGroups(node.nextPatch, node.UT, v) }
                    };
                    maneuvers.Add(nodeData);
                }
                orbitData["maneuvers"] = maneuvers;
                _lastNodeCount = v.patchedConicSolver.maneuverNodes.Count;
                _lastNodesChecksum = checksum;
            }
            else
            {
                orbitData["maneuvers"] = new List<object>();
                _lastNodeCount = 0; _lastNodesChecksum = 0;
            }

            // v22.1 Zero-Legacy Policy: No planet lists, no rotations here.
            // Client uses metadata to calculate all celestial orbits/rotations.

            var packet = CreateUnifiedPacket(currentUT, orbitData);
            session.SendUnifiedPacket(packet);

            LastSentUT = currentUT;
            LastSentData = orbitData;
            _forceFullUpdate = false;
        }

        private double GetMeridianAngle()
        {
            Vector3d inertialX = Planetarium.right;
            Vector3d worldX = Vector3d.right;
            Vector3d projInertialX = new Vector3d(inertialX.x, 0, inertialX.z).normalized;
            double angle = Vector3d.Angle(worldX, projInertialX);
            if (Vector3d.Cross(worldX, projInertialX).y < 0) angle = 360.0 - angle;
            return angle;
        }

        private void SendMetadataManifest(KSPUnifiedStreamService session)
        {
            var bodies = FlightGlobals.Bodies;
            var manifest = new Dictionary<string, object>();

            foreach (var body in bodies)
            {
                var bodyData = new Dictionary<string, object>
                {
                    { "name", body.name },
                    { "id", body.flightGlobalsIndex },
                    { "parent", body.orbit != null ? body.orbit.referenceBody.name : null },
                    { "radius", (double)body.Radius },
                    { "sma", body.orbit != null ? (double)body.orbit.semiMajorAxis : 0 },
                    { "ecc", body.orbit != null ? (double)body.orbit.eccentricity : 0 },
                    { "inc", body.orbit != null ? (double)body.orbit.inclination : 0 },
                    { "argPe", body.orbit != null ? (double)body.orbit.argumentOfPeriapsis : 0 },
                    { "lan", body.orbit != null ? (double)body.orbit.LAN : 0 },
                    { "period", body.orbit != null ? (double)body.orbit.period : 0 },
                    { "m0", body.orbit != null ? (double)body.orbit.meanAnomalyAtEpoch : 0 },
                    { "epoch", body.orbit != null ? (double)body.orbit.epoch : 0 },
                    { "initialRotation", (double)body.initialRotation },
                    { "rotates", (bool)body.rotates },
                    { "rotationPeriod", (double)body.rotationPeriod },
                    { "rotationalSpeed", body.rotationPeriod > 0 ? (360.0 / body.rotationPeriod) : 0 }
                };
                manifest[body.name] = bodyData;
            }

            // v22.1: Global Planetarium Metadata
            double meridianSpeed = 360.0 / 21600.0; // Kerbin Default
            if (FlightGlobals.GetHomeBody() != null) meridianSpeed = 360.0 / FlightGlobals.GetHomeBody().rotationPeriod;

            session.SendUnifiedPacket(new Dictionary<string, object>
            {
                { "type", "orbit_metadata" },
                { "ut", Planetarium.GetUniversalTime() },
                { "data", new Dictionary<string, object> {
                    { "bodies", manifest },
                    { "initialMeridianOffset", GetMeridianAngle() },
                    { "meridianRotationSpeed", meridianSpeed }
                }}
            });
        }

        private List<Dictionary<string, object>> GetOrbitGroups(Orbit startOrbit, double startUT, Vessel v)
        {
            var groups = new List<Dictionary<string, object>>();
            var patches = OrbitPatches.getPatchesForOrbit(startOrbit);
            CelestialBody rootBody = v.mainBody;

            foreach (var patch in patches)
            {
                double pStart = Math.Max(patch.StartUT, startUT);
                double pEnd = patch.EndUT;

                if (double.IsInfinity(pEnd) || pEnd < pStart)
                {
                    pEnd = pStart + patch.period;
                }

                var points = new List<object>();
                double step = (pEnd - pStart) / Resolution;

                for (int i = 0; i <= Resolution; i++)
                {
                    double ut = pStart + (step * i);

                    // 1. Relative position in patch frame (Mandatory for all points)
                    Vector3d pos = patch.getRelativePositionAtUT(ut);
                    points.Add(new Dictionary<string, double> { { "x", pos.x }, { "y", pos.y }, { "z", pos.z } });
                }

                groups.Add(new Dictionary<string, object> {
                    { "patch", patches.IndexOf(patch) },
                    { "referenceBody", patch.referenceBody.name },
                    { "startUT", pStart },
                    { "endUT", pEnd },
                    { "sma", patch.semiMajorAxis },
                    { "ecc", patch.eccentricity },
                    { "inc", patch.inclination },
                    { "argPe", patch.argumentOfPeriapsis },
                    { "lan", patch.LAN },
                    { "period", patch.period },
                    { "m0", patch.meanAnomalyAtEpoch },
                    { "epoch", patch.epoch },
                    { "points", points }
                });
            }

            return groups;
        }

        private Vector3d GetBodyRelativePosition(CelestialBody body, double ut, CelestialBody relativeTo)
        {
            if (body == relativeTo) return Vector3d.zero;
            Vector3d pos = Vector3d.zero;
            CelestialBody current = body;
            while (current != null && current != relativeTo && current.orbit != null)
            {
                pos += current.orbit.getPositionAtUT(ut);
                current = current.orbit.referenceBody;
            }
            return pos;
        }
    }
}
