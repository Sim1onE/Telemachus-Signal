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
        private UpLinkDownLinkRate dataRates;
        private AudioSource audioSource;
        private GameObject audioHost;
        private string cameraName = null;
        private long lastSentFrameId = -1;

        private Queue<AudioChunk> uplinkAudioBuffer = new Queue<AudioChunk>();
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
                if (e.RawData.Length > 0 && e.RawData[0] == 1) // Audio
                {
                    byte[] pcmData = new byte[e.RawData.Length - 1];
                    Buffer.BlockCopy(e.RawData, 1, pcmData, 0, pcmData.Length);
                    HandleIncomingAudio(pcmData);
                }
            }
            else if (e.IsText)
            {
                // Simple JSON Command pattern
                try {
                    var json = Json.DecodeObject(e.Data) as Dictionary<string, object>;
                    if (json != null) {
                        if (json.ContainsKey("camera")) {
                            cameraName = json["camera"].ToString().ToLower();
                            PluginLogger.print($"[Stream] Client {ID} selected camera: {cameraName}");
                            if (CameraCaptureManager.classedInstance != null) CameraCaptureManager.classedInstance.EnsureFlightCamera();
                        }
                        
                        // Generic command processing (FOV, Pitch, Yaw, ViewMode, etc.)
                        CameraCapture sensor = null;
                        if (!string.IsNullOrEmpty(cameraName) && CameraCaptureManager.classedInstance.cameras.ContainsKey(cameraName)) {
                            sensor = CameraCaptureManager.classedInstance.cameras[cameraName];
                        }
                        
                        if (sensor != null) {
                            sensor.ProcessCameraCommand(json);
                        } else {
                            PluginLogger.print($"[Stream] WARNING: Received command but no sensor found for '{cameraName}'");
                        }
                    }
                } catch (Exception ex) {
                    PluginLogger.print("Error parsing WS command: " + ex.Message);
                }
            }
        }

        private void HandleIncomingAudio(byte[] pcmData)
        {
            double delay = TelemachusSignalManager.GetSignalDelay(FlightGlobals.ActiveVessel);
            double quality = TelemachusSignalManager.GetSignalQuality(FlightGlobals.ActiveVessel);

            lock (uplinkAudioBuffer)
            {
                uplinkAudioBuffer.Enqueue(new AudioChunk {
                    Data = pcmData, PlayAt = (float)(UnityEngine.Time.unscaledTime + delay), Quality = (float)quality
                });
            }
        }

        public void ProcessUpdate()
        {
            if (audioSource != null) {
                lock (uplinkAudioBuffer) {
                    while (uplinkAudioBuffer.Count > 0 && UnityEngine.Time.unscaledTime >= uplinkAudioBuffer.Peek().PlayAt) {
                        PlayAudioChunk(uplinkAudioBuffer.Dequeue());
                    }
                }
            }

            if (!string.IsNullOrEmpty(cameraName)) {
                PushVideoFrame();
            }
        }

        private void PushVideoFrame()
        {
            if (CameraCaptureManager.classedInstance == null) return;
            
            CameraCapture sensor = null;
            
            // Try Case-Insensitive search to be ultra-safe
            if (CameraCaptureManager.classedInstance.cameras.ContainsKey(cameraName)) {
                sensor = CameraCaptureManager.classedInstance.cameras[cameraName];
            } else {
                // Fallback: search ignoring case
                var key = CameraCaptureManager.classedInstance.cameras.Keys.FirstOrDefault(k => k.Equals(cameraName, StringComparison.OrdinalIgnoreCase));
                if (key != null) sensor = CameraCaptureManager.classedInstance.cameras[key];
            }

            if (sensor == null) return;

            // Wake up the sensor! We must update the tick BEFORE checking for imageBytes
            // otherwise the sensor will never start rendering if it was idle.
            sensor.lastRequestTick = Environment.TickCount;

            if (sensor.imageBytes == null) return;

            if (sensor.lastFrameId == lastSentFrameId) return;
            lastSentFrameId = sensor.lastFrameId;

            byte[] jpegData = sensor.imageBytes;
            byte[] packet = new byte[34 + jpegData.Length];
            packet[0] = 0; // Video Type
            
            // Critical Fix: Use the time when the frame WAS RENDERED, not when it is SENT
            double ut = sensor.lastFrameUT; 
            double warp = TimeWarp.fetch != null ? TimeWarp.CurrentRate : 1.0;
            double delay = TelemachusSignalManager.GetSignalDelay(FlightGlobals.ActiveVessel);
            double fov = sensor.interpolatedFOV;
            byte quality = (byte)(TelemachusSignalManager.GetSignalQuality(FlightGlobals.ActiveVessel) * 100);

            Buffer.BlockCopy(BitConverter.GetBytes(ut), 0, packet, 1, 8);
            Buffer.BlockCopy(BitConverter.GetBytes(warp), 0, packet, 9, 8);
            Buffer.BlockCopy(BitConverter.GetBytes(delay), 0, packet, 17, 8);
            Buffer.BlockCopy(BitConverter.GetBytes(fov), 0, packet, 25, 8);
            packet[33] = quality;

            Buffer.BlockCopy(jpegData, 0, packet, 34, jpegData.Length);

            SendAsync(packet, null);
            dataRates.SendDataToClient(packet.Length);
        }

        private void PlayAudioChunk(AudioChunk chunk)
        {
            float[] samples = new float[chunk.Data.Length / 2];
            for (int i = 0; i < samples.Length; i++) {
                samples[i] = BitConverter.ToInt16(chunk.Data, i * 2) / 32768f;
                if (chunk.Quality < 0.95f) samples[i] += (UnityEngine.Random.value * 2f - 1f) * (1.0f - chunk.Quality) * 0.15f;
            }
            AudioClip clip = AudioClip.Create("Radio", samples.Length, 1, AUDIO_SAMPLE_RATE, false);
            clip.SetData(samples, 0);
            audioSource.PlayOneShot(clip);
        }

        private struct AudioChunk { public byte[] Data; public float PlayAt; public float Quality; }
    }
}
