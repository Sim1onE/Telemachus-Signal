using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using WebSocketSharp;
using WebSocketSharp.Server;
using Telemachus.CameraSnapshots;

namespace Telemachus
{
    public class KSPUnifiedStreamService : WebSocketBehavior
    {
        private class KSPAudioDownlink : MonoBehaviour
        {
            // v14.27: Restoring critical features to the Multi-session Shared Probe.
            private HashSet<KSPUnifiedStreamService> subscribers = new HashSet<KSPUnifiedStreamService>();
            
            private AudioClip micClip;
            private string deviceName = null;
            private int lastMicPos = 0;
            private bool micActive = false;
            private int micFreq = 22050;
            private volatile bool pttActive = false;

            private int lastSeenPos = -1;
            private float stallTimer = 0;
            private float pttHangTime = 0f;

            private int _cachedOutputSampleRate = 48000;
            private float[] _micRingBuffer = new float[22050 * 5]; 
            private int _micWritePtr = 0;
            private double _micReadPtr = 0;
            private readonly object _micLock = new object();

            private double finalSrcPos = 0;
            private float _lastGameMonoSample = 0f;
            private bool _isResamplerCold = true; 
            private bool _isMicBuffering = true;
            private float _micFadeGain = 0f;
            private float _packetFadeGain = 0f;

            public void Subscribe(KSPUnifiedStreamService session) {
                lock(subscribers) subscribers.Add(session);
            }
            public void Unsubscribe(KSPUnifiedStreamService session) {
                lock(subscribers) subscribers.Remove(session);
            }

            void Update()
            {
                // 1. PTT Logic
                if (Input.GetKey(KeyCode.RightControl) || Input.GetKey(KeyCode.LeftControl))
                {
                    pttActive = true;
                    pttHangTime = 0.3f;
                }
                else
                {
                    if (pttHangTime > 0)
                    {
                        pttHangTime -= Time.unscaledDeltaTime;
                        pttActive = true;
                    }
                    else pttActive = false;
                }

                // 2. v14.27 Restore: Mic Device Hot-Switching
                string targetDevice = AudioCaptureManager.SelectedDevice;
                if (!string.IsNullOrEmpty(targetDevice) && targetDevice != deviceName && micActive)
                {
                    PluginLogger.print($"[Downlink Probe] Switching mic device: {targetDevice}");
                    StopMic();
                    StartMic(targetDevice);
                    return;
                }

                _cachedOutputSampleRate = AudioSettings.outputSampleRate;

                if (micActive)
                {
                    int currPos = Microphone.GetPosition(deviceName);

                    // 3. Stall Detection
                    if (currPos == lastSeenPos)
                    {
                        stallTimer += Time.unscaledDeltaTime;
                        if (stallTimer > 1.5f)
                        {
                            StopMic();
                            StartMic(deviceName);
                            stallTimer = 0;
                        }
                    }
                    else { stallTimer = 0; lastSeenPos = currPos; }

                    // 4. Capture & Buffer Logic
                    if (pttActive && micClip != null)
                    {
                        int available = (currPos >= lastMicPos) ? (currPos - lastMicPos) : (micClip.samples - lastMicPos + currPos);
                        if (available > 0)
                        {
                            float[] temp = new float[available];
                            micClip.GetData(temp, lastMicPos);
                            lastMicPos = (lastMicPos + available) % micClip.samples;

                            lock (_micLock)
                            {
                                for (int i = 0; i < temp.Length; i++)
                                {
                                    _micRingBuffer[_micWritePtr] = temp[i];
                                    _micWritePtr = (_micWritePtr + 1) % _micRingBuffer.Length;
                                }
                            }
                        }
                    }
                    // 5. v14.27 Restore: Stale Buffer Flush (Consume silently while !pttActive)
                    else if (!pttActive)
                    {
                        lastMicPos = currPos; 
                        lock (_micLock) { _micWritePtr = 0; _micReadPtr = 0; }
                    }
                }
            }

            void Start()
            {
                AudioCaptureManager.Initialize();
                StartMic(AudioCaptureManager.SelectedDevice);
            }

            void StartMic(string target)
            {
                try
                {
                    if (Microphone.devices.Length > 0)
                    {
                        deviceName = string.IsNullOrEmpty(target) ? Microphone.devices[0] : target;
                        micClip = Microphone.Start(deviceName, true, 10, 22050);
                        micFreq = micClip.frequency;
                        micActive = true;
                        lastMicPos = Microphone.GetPosition(deviceName);
                        PluginLogger.print($"[Downlink Probe] Started capture: {deviceName} ({micFreq}Hz)");
                    }
                }
                catch (Exception e) { PluginLogger.print("[Downlink Probe] Mic Start Failure: " + e.Message); }
            }

            void StopMic()
            {
                if (micActive) { Microphone.End(deviceName); micActive = false; }
            }

            void OnAudioFilterRead(float[] data, int channels)
            {
                int safeSampleRate = _cachedOutputSampleRate > 0 ? _cachedOutputSampleRate : 48000;
                int gameLen = data.Length / channels;
                float[] gameMono = new float[gameLen];

                float targetPacketGain = pttActive ? 1.0f : 0.0f;
                _packetFadeGain += (targetPacketGain - _packetFadeGain) * 0.004f;

                if (!pttActive && _packetFadeGain < 0.001f) 
                {
                    _isResamplerCold = true;
                    return;
                }

                for (int i = 0; i < gameLen; i++)
                {
                    float sum = 0;
                    for (int c = 0; c < channels; c++) sum += data[i * channels + c];
                    gameMono[i] = (sum / channels) * 1.35f;
                }

                if (micActive)
                {
                    float ratio = (float)micFreq / (float)safeSampleRate;
                    lock (_micLock)
                    {
                        int available = (_micWritePtr - (int)_micReadPtr + _micRingBuffer.Length) % _micRingBuffer.Length;
                        bool hasEnoughCushion = available > (micFreq * 0.05f);
                        if (hasEnoughCushion) _isMicBuffering = false;
                        if (available < 50) _isMicBuffering = true;

                        float targetMicGain = (pttActive && !_isMicBuffering) ? 1.0f : 0.0f;

                        for (int i = 0; i < gameLen; i++)
                        {
                            _micFadeGain += (targetMicGain - _micFadeGain) * 0.002f;
                            float micV = 0f;
                            if (_micFadeGain > 0.001f)
                            {
                                int i0 = (int)_micReadPtr;
                                int i1 = (i0 + 1) % _micRingBuffer.Length;
                                float frac = (float)(_micReadPtr - (int)_micReadPtr);
                                micV = (_micRingBuffer[i0] + (_micRingBuffer[i1] - _micRingBuffer[i0]) * frac) * 5.0f;
                                if (!_isMicBuffering) _micReadPtr = (_micReadPtr + ratio) % _micRingBuffer.Length;
                            }
                            float currentDucking = (_micFadeGain > 0.001f) ? 0.6f : 1.0f;
                            gameMono[i] = Mathf.Clamp(gameMono[i] * currentDucking + (micV * _micFadeGain), -1.2f, 1.2f); 
                        }
                    }
                }

                if (_isResamplerCold) { finalSrcPos = 0; _lastGameMonoSample = gameMono[0]; _isResamplerCold = false; }

                double finalRatio = (double)safeSampleRate / 22050.0;
                int targetLen = 0;
                double checkPos = finalSrcPos;
                while (checkPos < gameLen - 1) { targetLen++; checkPos += finalRatio; }

                float[] finalSamples = new float[targetLen];
                double currentPos = finalSrcPos;
                for (int i = 0; i < targetLen; i++)
                {
                    int i0 = (int)Math.Floor(currentPos);
                    int i1 = (i0 + 1) >= gameLen ? i0 : (i0 + 1);
                    float frac = (float)(currentPos - i0);
                    float s0 = i0 < 0 ? _lastGameMonoSample : gameMono[i0];
                    float s1 = gameMono[i1];
                    finalSamples[i] = (s0 + (s1 - s0) * frac) * _packetFadeGain;
                    currentPos += finalRatio;
                }

                finalSrcPos = currentPos - gameLen;
                if (gameLen > 0) _lastGameMonoSample = gameMono[gameLen - 1];

                lock(subscribers) { foreach(var sub in subscribers) sub.HandleGameAudio(finalSamples); }
            }
            void OnDestroy() { StopMic(); }
        }

        public enum PacketType : byte
        {
            VideoDownlink = 0, VideoUplink = 1, AudioDownlink = 2, AudioUplink = 3
        }
        public const int HEADER_SIZE = 34;

        private UpLinkDownLinkRate dataRates;
        private AudioSource audioSource;
        private GameObject audioHost;
        private string cameraName = null;
        private long lastSentFrameId = -1;
        private long lastHeartbeatTick = 0;
        private KSPAudioDownlink _sharedProbe;
        private int _downlinkPacketCount = 0;
        private float _lastDownlinkDiag = 0;
        private string _pendingDownlinkMsg = null;

        public KSPUnifiedStreamService(UpLinkDownLinkRate rateTracker) { this.dataRates = rateTracker; }

        protected override void OnOpen()
        {
            base.OnOpen();
            MainThreadDispatcher.Enqueue(() =>
            {
                audioHost = new GameObject("RadioProxy_" + ID);
                audioSource = audioHost.AddComponent<AudioSource>();
                audioSource.spatialBlend = 0f;
                UnityEngine.Object.DontDestroyOnLoad(audioHost);
            });
            PluginLogger.print($"[Downlink] Unified Session {ID} Active.");
        }

        protected override void OnClose(CloseEventArgs e)
        {
            MainThreadDispatcher.Enqueue(() =>
            {
                if (_sharedProbe != null) _sharedProbe.Unsubscribe(this);
                if (audioHost != null) UnityEngine.Object.Destroy(audioHost);
            });
            base.OnClose(e);
        }

        protected override void OnMessage(MessageEventArgs e)
        {
            if (e.IsBinary)
            {
                dataRates.RecieveDataFromClient(e.RawData.Length);
                if (e.RawData.Length == 0) return;
                byte type = e.RawData[0];
                if (type == (byte)PacketType.AudioUplink) 
                {
                    if (e.RawData.Length < HEADER_SIZE) return;
                    double creationUT = BitConverter.ToDouble(e.RawData, 1);
                    byte[] pcmData = new byte[e.RawData.Length - HEADER_SIZE];
                    Buffer.BlockCopy(e.RawData, HEADER_SIZE, pcmData, 0, pcmData.Length);
                    HandleIncomingAudio(pcmData, creationUT);
                }
            }
            else if (e.IsText)
            {
                try {
                    var json = Json.DecodeObject(e.Data) as Dictionary<string, object>;
                    if (json != null) {
                        if (json.ContainsKey("list")) SendCameraList();
                        else HandleCommand(json);
                    }
                } catch { }
            }
        }

        private void HandleCommand(Dictionary<string, object> json)
        {
            if (json.ContainsKey("camera")) {
                cameraName = json["camera"].ToString();
                if (CameraCaptureManager.classedInstance != null) CameraCaptureManager.classedInstance.EnsureFlightCamera();
            }
            CameraCapture sensor = GetSensor(cameraName);
            if (sensor != null) sensor.ProcessCameraCommand(json);
        }

        private CameraCapture GetSensor(string name)
        {
            if (string.IsNullOrEmpty(name) || CameraCaptureManager.classedInstance == null) return null;
            var cameras = CameraCaptureManager.classedInstance.cameras;
            if (cameras.ContainsKey(name)) return cameras[name];
            var key = cameras.Keys.FirstOrDefault(k => k.Equals(name, StringComparison.OrdinalIgnoreCase));
            return key != null ? cameras[key] : null;
        }

        private ulong _fmodAudioBlockCount = 0;
        private double _lastAudioCaptureUt = -1.0;

        public void HandleGameAudio(float[] samples)
        {
            _fmodAudioBlockCount++;
            double currentUt = Planetarium.GetUniversalTime();
            if (_lastAudioCaptureUt < 0) _lastAudioCaptureUt = currentUt;
            
            double blockDuration = (double)samples.Length / 22050.0;
            _lastAudioCaptureUt += blockDuration;
            if (currentUt > _lastAudioCaptureUt) _lastAudioCaptureUt = currentUt;

            double uniqueUt = _lastAudioCaptureUt + (_fmodAudioBlockCount % 100 * 0.00000001);

            byte[] pcm = new byte[samples.Length * 2];
            for (int i = 0; i < samples.Length; i++)
            {
                short s = (short)Mathf.Clamp(samples[i] * 32767f, -32768, 32767);
                pcm[i * 2] = (byte)(s & 0xFF);
                pcm[i * 2 + 1] = (byte)((s >> 8) & 0xFF);
            }

            byte[] packet = new byte[HEADER_SIZE + pcm.Length];
            FillHeader(packet, (byte)PacketType.AudioDownlink, uniqueUt, 0);
            Buffer.BlockCopy(pcm, 0, packet, HEADER_SIZE, pcm.Length);
            SendAsync(packet, null);

            _downlinkPacketCount++;
            if (Time.unscaledTime - _lastDownlinkDiag > 2.0f) {
                _pendingDownlinkMsg = $"[Radio-Diag] DOWNLINK: {_downlinkPacketCount} pkts/2s";
                _downlinkPacketCount = 0; _lastDownlinkDiag = Time.unscaledTime;
            }
        }

        private void HandleIncomingAudio(byte[] pcmData, double creationUT) {
            TelemachusAudioController.Instance.PlayVoiceUplink(pcmData, creationUT);
        }

        public void ProcessUpdate()
        {
            TelemachusAudioController.EnsureInstance();
            if (_sharedProbe == null) {
                AudioListener listener = UnityEngine.Object.FindObjectOfType<AudioListener>();
                if (listener != null) {
                    _sharedProbe = listener.gameObject.GetComponent<KSPAudioDownlink>();
                    if (_sharedProbe == null) _sharedProbe = listener.gameObject.AddComponent<KSPAudioDownlink>();
                    _sharedProbe.Subscribe(this);
                }
            }
            if (_pendingDownlinkMsg != null) { PluginLogger.print(_pendingDownlinkMsg); _pendingDownlinkMsg = null; }
            SendHeartbeat();
            if (!string.IsNullOrEmpty(cameraName)) PushVideoFrame();
        }

        private void PushVideoFrame()
        {
            CameraCapture sensor = GetSensor(cameraName);
            if (sensor == null) return;
            sensor.lastRequestTick = Environment.TickCount;
            if (sensor.imageBytes == null || sensor.lastFrameId == lastSentFrameId) return;
            lastSentFrameId = sensor.lastFrameId;
            byte[] jpegData = sensor.imageBytes;
            byte[] packet = new byte[HEADER_SIZE + jpegData.Length];
            FillHeader(packet, (byte)PacketType.VideoDownlink, sensor.lastFrameUT, sensor.interpolatedFOV);
            Buffer.BlockCopy(jpegData, 0, packet, HEADER_SIZE, jpegData.Length);
            SendAsync(packet, null);
            dataRates.SendDataToClient(packet.Length);
        }

        private void SendHeartbeat()
        {
            try {
                long now = Environment.TickCount;
                if (now - lastHeartbeatTick < 33 && now >= lastHeartbeatTick) return;
                lastHeartbeatTick = now;
                Vessel v = FlightGlobals.ActiveVessel;
                if (v == null) return;
                double currentUT = Planetarium.GetUniversalTime();
                double warp = TimeWarp.fetch != null ? TimeWarp.CurrentRate : 1.0;
                double delay = TelemachusSignalManager.GetSignalDelay(v);
                int quality = (int)(TelemachusSignalManager.GetSignalQuality(v) * 100);
                var status = new Dictionary<string, object> {
                    { "type", "status" }, { "ut", currentUT }, { "warp", warp }, { "delay", delay },
                    { "quality", quality }, { "alt", (double)v.altitude }, { "vel", (double)v.obt_speed }, { "met", (double)v.missionTime }
                };
                SendAsync(Json.Encode(status), null);
            } catch { }
        }

        private void FillHeader(byte[] packet, byte type, double ut, double fov)
        {
            packet[0] = type;
            double warp = TimeWarp.fetch != null ? TimeWarp.CurrentRate : 1.0;
            double delay = TelemachusSignalManager.GetSignalDelay(FlightGlobals.ActiveVessel);
            byte quality = (byte)(TelemachusSignalManager.GetSignalQuality(FlightGlobals.ActiveVessel) * 100);
            Buffer.BlockCopy(BitConverter.GetBytes(ut), 0, packet, 1, 8);
            Buffer.BlockCopy(BitConverter.GetBytes(warp), 0, packet, 9, 8);
            Buffer.BlockCopy(BitConverter.GetBytes(delay), 0, packet, 17, 8);
            Buffer.BlockCopy(BitConverter.GetBytes(fov), 0, packet, 25, 8);
            packet[33] = quality;
        }

        private void SendCameraList()
        {
            try {
                if (CameraCaptureManager.classedInstance == null) return;
                var cameraList = new List<Dictionary<string, object>>();
                foreach (var c in CameraCaptureManager.classedInstance.cameras.Values) {
                    cameraList.Add(new Dictionary<string, object> {
                        { "name", c.cameraManagerName() ?? "Unknown" }, { "type", c.cameraType() ?? "Unknown" },
                        { "fovMin", (double)c.minFOV }, { "fovMax", (double)c.maxFOV }, { "currentFov", (double)c.interpolatedFOV }
                    });
                }
                var response = new Dictionary<string, object> { { "type", "cameraList" }, { "cameras", cameraList } };
                SendAsync(Json.Encode(response), null);
            } catch { }
        }
    }
}
