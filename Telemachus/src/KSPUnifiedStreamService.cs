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
        public enum PacketType : byte { 
            VideoDownlink = 0, VideoUplink = 1, 
            AudioDownlink = 2, AudioUplink = 3
        }
        public const int HEADER_SIZE = 34;

        private UpLinkDownLinkRate dataRates;
        private AudioSource audioSource;
        private GameObject audioHost;
        private string cameraName = null;
        private long lastSentFrameId = -1;

        private const int AUDIO_SAMPLE_RATE = 22050;

        public KSPUnifiedStreamService(UpLinkDownLinkRate rateTracker)
        {
            this.dataRates = rateTracker;
        }

        protected override void OnOpen()
        {
            base.OnOpen();
            // We'll wait for a "select" message from the client to set cameraName
            MainThreadDispatcher.Enqueue(() => {
                audioHost = new GameObject("RadioProxy_" + ID);
                audioSource = audioHost.AddComponent<AudioSource>();
                audioSource.spatialBlend = 0f;
                UnityEngine.Object.DontDestroyOnLoad(audioHost);
            });
            
            PluginLogger.print($"Unified Stream Session {ID} opened. Awaiting camera selection...");
        }

        protected override void OnClose(CloseEventArgs e)
        {
            MainThreadDispatcher.Enqueue(() => {
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
                    byte[] pcmData = new byte[e.RawData.Length - 1];
                    Buffer.BlockCopy(e.RawData, 1, pcmData, 0, pcmData.Length);
                    HandleIncomingAudio(pcmData);
                }
            }
            else if (e.IsText)
            {
                // JSON Protocol for Metadata and Immediate Actions
                try {
                    var json = Json.DecodeObject(e.Data) as Dictionary<string, object>;
                    if (json == null) return;

                    if (json.ContainsKey("list")) {
                        SendCameraList();
                    } else {
                        HandleCommand(json);
                    }
                } catch (Exception ex) {
                    PluginLogger.print("[Stream] JSON Parse Error: " + ex.Message);
                }
            }
        }

        private void HandleCommand(Dictionary<string, object> json)
        {
            if (json.ContainsKey("camera")) {
                cameraName = json["camera"].ToString(); // Case-sensitive or insensitive (now handled by GetSensor)
                PluginLogger.print($"[Stream] Client {ID} requested camera: {cameraName}");
                if (CameraCaptureManager.classedInstance != null) CameraCaptureManager.classedInstance.EnsureFlightCamera();
            }
            
            // Generic command processing (FOV, etc.)
            CameraCapture sensor = GetSensor(cameraName);
            
            if (sensor != null) {
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

        private void HandleIncomingAudio(byte[] pcmData)
        {
            float quality = (float)TelemachusSignalManager.GetSignalQuality(FlightGlobals.ActiveVessel);

            MainThreadDispatcher.Enqueue(() => {
                if (audioSource != null) {
                    PlayAudioChunk(pcmData, quality);
                }
            });
        }

        public void ProcessUpdate()
        {
            // Always send Heartbeat to keep client clock in sync even when camera is off
            SendHeartbeat();

            if (!string.IsNullOrEmpty(cameraName)) {
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
            try {
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
            } catch (Exception ex) {
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
            try {
                if (CameraCaptureManager.classedInstance == null) return;
                
                var cameraList = new List<Dictionary<string, object>>();
                foreach (var c in CameraCaptureManager.classedInstance.cameras.Values) {
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
            } catch (Exception ex) {
                PluginLogger.print("[Stream] SendCameraList Crash: " + ex.Message + "\n" + ex.StackTrace);
            }
        }

        private void PlayAudioChunk(byte[] data, float quality)
        {
            float[] samples = new float[data.Length / 2];
            for (int i = 0; i < samples.Length; i++) {
                samples[i] = BitConverter.ToInt16(data, i * 2) / 32768f;
                if (quality < 0.95f) samples[i] += (UnityEngine.Random.value * 2f - 1f) * (1.0f - quality) * 0.15f;
            }
            AudioClip clip = AudioClip.Create("Radio", samples.Length, 1, AUDIO_SAMPLE_RATE, false);
            clip.SetData(samples, 0);
            audioSource.PlayOneShot(clip);
        }
    }
}
