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
            public Action<float[]> OnAudioBuffer;
            private AudioClip micClip;
            private string deviceName = null;
            private int lastMicPos = 0;
            private bool micActive = false;
            private int micFreq = 22050;
            private volatile bool pttActive = false;

            private float[] resampleBuffer;
            private double micSrcPos = 0;
            private double finalSrcPos = 0;
            
            private int lastSeenPos = -1;
            private float stallTimer = 0;

            private float pttHangTime = 0f;

            void Update()
            {
                // Check PTT key (Standard Control keys for communications)
                if (Input.GetKey(KeyCode.RightControl) || Input.GetKey(KeyCode.LeftControl)) {
                    pttActive = true;
                    pttHangTime = 0.3f; // 300ms hang time ensures the last word is not clipped
                } else {
                    if (pttHangTime > 0) {
                        pttHangTime -= Time.unscaledDeltaTime;
                        pttActive = true;
                    } else {
                        pttActive = false;
                    }
                }

                // Auto-restart if the global device selection changed via Debug Window
                string targetDevice = AudioCaptureManager.SelectedDevice;
                if (!string.IsNullOrEmpty(targetDevice) && targetDevice != deviceName && micActive)
                {
                    PluginLogger.print($"[Downlink] Switching mic to: {targetDevice}");
                    StopMic();
                    StartMic(targetDevice);
                    return;
                }

                // WATCHDOG: Detect if the Mic driver position is stalled (frozen circular buffer)
                if (micActive) {
                    int curr = Microphone.GetPosition(deviceName);
                    if (curr == lastSeenPos) {
                        stallTimer += Time.unscaledDeltaTime;
                        if (stallTimer > 1.5f) {
                            PluginLogger.print("[Downlink] Mic STALL detected. Resetting driver...");
                            StopMic();
                            StartMic(deviceName);
                            stallTimer = 0;
                        }
                    } else {
                        stallTimer = 0;
                        lastSeenPos = curr;
                    }
                }
            }

            void Start()
            {
                AudioCaptureManager.Initialize(); // Ensure manager is ready
                StartMic(AudioCaptureManager.SelectedDevice);
            }

            void StartMic(string target)
            {
                try
                {
                    if (Microphone.devices.Length > 0)
                    {
                        deviceName = string.IsNullOrEmpty(target) ? Microphone.devices[0] : target;
                        // Record a 10s buffer to avoid wrap-around glitcing
                        micClip = Microphone.Start(deviceName, true, 10, 22050);
                        micFreq = micClip.frequency;
                        micActive = true;
                        lastMicPos = 0;
                        PluginLogger.print($"[Downlink] Started mic capture on: {deviceName} ({micFreq}Hz)");
                    }
                    else
                    {
                        PluginLogger.print("[Downlink] No microphone devices found.");
                    }
                }
                catch (Exception e)
                {
                    PluginLogger.print("[Downlink] Mic Init Failed: " + e.Message);
                    micActive = false;
                }
            }

            void StopMic()
            {
                if (micActive)
                {
                    Microphone.End(deviceName);
                    micActive = false;
                }
            }

            void OnAudioFilterRead(float[] data, int channels)
            {
                if (OnAudioBuffer == null) return;

                int gameLen = data.Length / channels;
                float[] gameMono = new float[gameLen];
                if (!pttActive)
                {
                    // Global MUTE. No audio leaves Kerbal unless the pilot holds PTT.
                    if (micActive) {
                        lastMicPos = Microphone.GetPosition(deviceName);
                        micSrcPos = 0;
                    }
                    return;
                }

                // 1. Process Game FX (Downmix to Mono)
                for (int i = 0; i < gameLen; i++)
                {
                    float sum = 0;
                    for (int c = 0; c < channels; c++) sum += data[i * channels + c];
                    gameMono[i] = sum / channels;
                }

                // 2. Mix Pilot Mic (if PTT is active)
                if (micActive && micClip != null && pttActive)
                {
                    int currPos = Microphone.GetPosition(deviceName);
                    float ratio = (float)micFreq / (float)AudioSettings.outputSampleRate;
                    int micLenNeeded = Mathf.CeilToInt(gameLen * ratio);

                    int available = (currPos >= lastMicPos) ? (currPos - lastMicPos) : (micClip.samples - lastMicPos + currPos);

                    if (available >= micLenNeeded)
                    {
                        float[] temp = new float[micLenNeeded];
                        micClip.GetData(temp, lastMicPos);
                        lastMicPos = (lastMicPos + micLenNeeded) % micClip.samples;

                        // Mix into gameMono (Resampled Mic -> Game Rate)
                        double micPos = micSrcPos;
                        for (int i = 0; i < gameLen; i++)
                        {
                            int i0 = (int)micPos;
                            int i1 = Math.Max(0, Math.Min(i0 + 1, temp.Length - 1));
                            float frac = (float)(micPos - i0);
                            float micV = (temp[i0] + (temp[i1] - temp[i0]) * frac) * 3.5f; // Boost Pilot
                            gameMono[i] = Mathf.Clamp(gameMono[i] * 0.7f + micV, -1f, 1f); // Duck game slightly when talking
                            micPos += ratio;
                        }
                        micSrcPos = Math.Max(0, micPos - micLenNeeded);
                    }
                }
                else if (micActive)
                {
                    // Sync Head even when silent
                    lastMicPos = Microphone.GetPosition(deviceName);
                    micSrcPos = 0;
                }

                // 3. Resample Final Mix (GameRate -> 22050Hz for transmission)
                double finalRatio = (double)AudioSettings.outputSampleRate / 22050.0;
                
                // Calculate how many samples we can DEFINITELY fit starting at finalSrcPos
                int targetLen = 0;
                double checkPos = finalSrcPos;
                while (checkPos < gameLen) {
                    targetLen++;
                    checkPos += finalRatio;
                }

                float[] finalSamples = new float[targetLen];
                double currentPos = finalSrcPos;
                for (int i = 0; i < targetLen; i++)
                {
                    int i0 = (int)currentPos;
                    int i1 = Math.Max(0, Math.Min(i0 + 1, gameLen - 1));
                    float frac = (float)(currentPos - i0);
                    
                    // Boundary safety
                    int idx0 = Math.Max(0, Math.Min(i0, gameLen - 1));
                    finalSamples[i] = gameMono[idx0] + (gameMono[i1] - gameMono[idx0]) * frac;
                    currentPos += finalRatio;
                }
                finalSrcPos = Math.Max(0, currentPos - gameLen);

                OnAudioBuffer(finalSamples);
            }

            void OnDestroy()
            {
                StopMic();
            }
        }

        public enum PacketType : byte
        {
            VideoDownlink = 0, VideoUplink = 1,
            AudioDownlink = 2, AudioUplink = 3
        }
        public const int HEADER_SIZE = 34;

        private UpLinkDownLinkRate dataRates;
        private AudioSource audioSource;
        private GameObject audioHost;
        private string cameraName = null;
        private long lastSentFrameId = -1;
        private long lastHeartbeatTick = 0;
        private KSPAudioDownlink audioDownlink;
        private int _downlinkPacketCount = 0;
        private float _lastDownlinkDiag = 0;
        private string _pendingDownlinkMsg = null;
        private bool _needsAudioInit = false;

        private const int AUDIO_SAMPLE_RATE = 22050;

        public KSPUnifiedStreamService(UpLinkDownLinkRate rateTracker)
        {
            this.dataRates = rateTracker;
        }

        protected override void OnOpen()
        {
            base.OnOpen();
            // We'll wait for a "select" message from the client to set cameraName
            MainThreadDispatcher.Enqueue(() =>
            {
                audioHost = new GameObject("RadioProxy_" + ID);
                audioSource = audioHost.AddComponent<AudioSource>();
                audioSource.spatialBlend = 0f;
                UnityEngine.Object.DontDestroyOnLoad(audioHost);

                // Add Audio Downlink Capture
                AudioListener listener = UnityEngine.Object.FindObjectOfType<AudioListener>();
                if (listener != null)
                {
                    audioDownlink = listener.gameObject.AddComponent<KSPAudioDownlink>();
                    audioDownlink.OnAudioBuffer = HandleGameAudio;
                }
            });

            PluginLogger.print($"Unified Stream Session {ID} opened. Awaiting camera selection...");
        }

        protected override void OnClose(CloseEventArgs e)
        {
            MainThreadDispatcher.Enqueue(() =>
            {
                if (audioDownlink != null) UnityEngine.Object.Destroy(audioDownlink);
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
                if (type == (byte)PacketType.AudioUplink) // Voice In
                {
                    // Full 34-byte header support for Uplink Sync
                    if (e.RawData.Length < HEADER_SIZE) return;
                    
                    double creationUT = BitConverter.ToDouble(e.RawData, 1);
                    byte[] pcmData = new byte[e.RawData.Length - HEADER_SIZE];
                    Buffer.BlockCopy(e.RawData, HEADER_SIZE, pcmData, 0, pcmData.Length);
                    
                    HandleIncomingAudio(pcmData, creationUT);
                }
            }
            else if (e.IsText)
            {
                // JSON Protocol for Metadata and Immediate Actions
                try
                {
                    var json = Json.DecodeObject(e.Data) as Dictionary<string, object>;
                    if (json == null) return;

                    if (json.ContainsKey("list"))
                    {
                        SendCameraList();
                    }
                    else
                    {
                        HandleCommand(json);
                    }
                }
                catch (Exception ex)
                {
                    PluginLogger.print("[Stream] JSON Parse Error: " + ex.Message);
                }
            }
        }

        private void HandleCommand(Dictionary<string, object> json)
        {
            if (json.ContainsKey("camera"))
            {
                cameraName = json["camera"].ToString(); // Case-sensitive or insensitive (now handled by GetSensor)
                PluginLogger.print($"[Stream] Client {ID} requested camera: {cameraName}");
                if (CameraCaptureManager.classedInstance != null) CameraCaptureManager.classedInstance.EnsureFlightCamera();
            }

            // Generic command processing (FOV, etc.)
            CameraCapture sensor = GetSensor(cameraName);

            if (sensor != null)
            {
                sensor.ProcessCameraCommand(json);
            }
        }

        private CameraCapture GetSensor(string name)
        {
            if (string.IsNullOrEmpty(name) || CameraCaptureManager.classedInstance == null) return null;

            var cameras = CameraCaptureManager.classedInstance.cameras;
            if (cameras.ContainsKey(name)) return cameras[name];

            var key = cameras.Keys.FirstOrDefault(k => k.Equals(name, StringComparison.OrdinalIgnoreCase));
            if (key != null) return cameras[key];

            return null;
        }

        private void HandleGameAudio(float[] samples)
        {
            // Simple 16-bit PCM conversion
            byte[] pcm = new byte[samples.Length * 2];
            for (int i = 0; i < samples.Length; i++)
            {
                short s = (short)Mathf.Clamp(samples[i] * 32767f, -32768, 32767);
                byte[] bytes = BitConverter.GetBytes(s);
                pcm[i * 2] = bytes[0];
                pcm[i * 2 + 1] = bytes[1];
            }

            byte[] packet = new byte[HEADER_SIZE + pcm.Length];
            FillHeader(packet, (byte)PacketType.AudioDownlink, Planetarium.GetUniversalTime(), 0);
            Buffer.BlockCopy(pcm, 0, packet, HEADER_SIZE, pcm.Length);

            SendAsync(packet, null);

            // Diagnostics (Capture only)
            _downlinkPacketCount++;
            if (Time.unscaledTime - _lastDownlinkDiag > 2.0f) {
                _pendingDownlinkMsg = $"[Radio-Diag] DOWNLINK Output: {_downlinkPacketCount} packets in 2s (Steady rate = ~40-50)";
                _downlinkPacketCount = 0;
                _lastDownlinkDiag = Time.unscaledTime;
            }
        }

        private void HandleIncomingAudio(byte[] pcmData, double creationUT)
        {
            // Direct Link to the High-Fidelity Ring Buffer
            TelemachusAudioController.Instance.PlayVoiceUplink(pcmData, creationUT);
        }

        public void ProcessUpdate()
        {
            TelemachusAudioController.EnsureInstance();

            if (_needsAudioInit && audioDownlink == null) {
                AudioListener listener = UnityEngine.Object.FindObjectOfType<AudioListener>();
                if (listener != null) {
                    audioDownlink = listener.gameObject.AddComponent<KSPAudioDownlink>();
                    audioDownlink.OnAudioBuffer = HandleGameAudio;
                    _needsAudioInit = false;
                    PluginLogger.print("[Downlink v14.4] Active Audio Link established on: " + listener.name);
                }
            }

            if (_pendingDownlinkMsg != null) {
                PluginLogger.print(_pendingDownlinkMsg);
                _pendingDownlinkMsg = null;
            }

            // Always send Heartbeat to keep client clock in sync even when camera is off
            SendHeartbeat();

            if (!string.IsNullOrEmpty(cameraName))
            {
                PushVideoFrame();
            }
        }

        private void PushVideoFrame()
        {
            CameraCapture sensor = GetSensor(cameraName);

            if (sensor == null) return;

            // CRITICAL FIX: Tell the camera it's being watched BEFORE checking if imageBytes is null.
            // Otherwise, it refuses to render the first frame, creating an endless deadlock!
            sensor.lastRequestTick = Environment.TickCount;

            if (sensor.imageBytes == null || sensor.lastFrameId == lastSentFrameId) return;
            lastSentFrameId = sensor.lastFrameId;

            byte[] jpegData = sensor.imageBytes;
            byte[] packet = new byte[HEADER_SIZE + jpegData.Length];

            // Build header
            FillHeader(packet, (byte)PacketType.VideoDownlink, sensor.lastFrameUT, sensor.interpolatedFOV);

            Buffer.BlockCopy(jpegData, 0, packet, HEADER_SIZE, jpegData.Length);

            SendAsync(packet, null);
            dataRates.SendDataToClient(packet.Length);
        }

        private void SendHeartbeat()
        {
            try
            {
                // Throttle heartbeat to ~30Hz (33ms) to avoid flooding the client at high FPS
                long now = Environment.TickCount;
                if (now - lastHeartbeatTick < 33 && now >= lastHeartbeatTick) return;
                lastHeartbeatTick = now;

                Vessel v = FlightGlobals.ActiveVessel;
                if (v == null) return;

                double currentUT = Planetarium.GetUniversalTime();
                double warp = TimeWarp.fetch != null ? TimeWarp.CurrentRate : 1.0;
                double delay = TelemachusSignalManager.GetSignalDelay(v);

                // CRITICAL FIX: MiniJSON crashes on `byte`, must cast to `int`
                int quality = (int)(TelemachusSignalManager.GetSignalQuality(v) * 100);

                var status = new Dictionary<string, object> {
                    { "type", "status" },
                    { "ut", currentUT },
                    { "warp", warp },
                    { "delay", delay },
                    { "quality", quality },
                    { "alt", (double)v.altitude },
                    { "vel", (double)v.obt_speed },
                    { "met", (double)v.missionTime }
                };

                SendAsync(Json.Encode(status), null);
            }
            catch (Exception ex)
            {
                PluginLogger.print("[Stream] SendHeartbeat Crash: " + ex.Message + "\n" + ex.StackTrace);
            }
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
            try
            {
                if (CameraCaptureManager.classedInstance == null) return;

                var cameraList = new List<Dictionary<string, object>>();
                foreach (var c in CameraCaptureManager.classedInstance.cameras.Values)
                {
                    cameraList.Add(new Dictionary<string, object> {
                        { "name", c.cameraManagerName() ?? "Unknown" },
                        { "type", c.cameraType() ?? "Unknown" },
                        // CRITICAL FIX: MiniJSON crashes on `float`, must cast to `double`
                        { "fovMin", (double)c.minFOV },
                        { "fovMax", (double)c.maxFOV },
                        { "currentFov", (double)c.interpolatedFOV }
                    });
                }

                var response = new Dictionary<string, object> {
                    { "type", "cameraList" },
                    { "cameras", cameraList }
                };

                SendAsync(Json.Encode(response), null);
            }
            catch (Exception ex)
            {
                PluginLogger.print("[Stream] SendCameraList Crash: " + ex.Message + "\n" + ex.StackTrace);
            }
        }

    }
}
