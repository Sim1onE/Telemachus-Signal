using System;
using System.Collections.Generic;
using UnityEngine;

namespace Telemachus
{
    /// <summary>
    /// MonoBehaviour that captures game audio and microphone input for the downlink.
    /// Attached to the AudioListener in the scene.
    /// Now simplified to a single "Source" that notifies the AudioStreamManager.
    /// </summary>
    public class AudioDownlinkProbe : MonoBehaviour
    {
        private AudioStreamManager _globalManager;
        
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

        public void SetGlobalManager(AudioStreamManager manager) {
            _globalManager = manager;
        }

        void Update()
        {
            // 1. PTT Logic
            if (Input.GetKey(KeyCode.RightControl) || Input.GetKey(KeyCode.LeftControl))
            {
                if (!pttActive) PluginLogger.print("[Radio-PTT] Downlink OPEN (Pilot Speaking)");
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
                else 
                {
                    if (pttActive) PluginLogger.print("[Radio-PTT] Downlink CLOSED (Silence)");
                    pttActive = false;
                }
            }

            // 2. Mic Device Hot-Switching
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
                if (currPos == lastSeenPos)
                {
                    stallTimer += Time.unscaledDeltaTime;
                    if (stallTimer > 1.5f) { StopMic(); StartMic(deviceName); stallTimer = 0; }
                }
                else { stallTimer = 0; lastSeenPos = currPos; }

                if (pttActive && micClip != null)
                {
                    int available = (currPos >= lastMicPos) ? (currPos - lastMicPos) : (micClip.samples - lastMicPos + currPos);
                    if (available > 0)
                    {
                        float[] temp = new float[available];
                        micClip.GetData(temp, lastMicPos);
                        lastMicPos = (lastMicPos + available) % micClip.samples;
                        lock (_micLock) {
                            for (int i = 0; i < temp.Length; i++) {
                                _micRingBuffer[_micWritePtr] = temp[i];
                                _micWritePtr = (_micWritePtr + 1) % _micRingBuffer.Length;
                            }
                        }
                    }
                }
                else if (!pttActive) { lastMicPos = currPos; lock (_micLock) { _micWritePtr = 0; _micReadPtr = 0; } }
            }
        }

        void Start() { AudioCaptureManager.Initialize(); StartMic(AudioCaptureManager.SelectedDevice); }

        void StartMic(string target)
        {
            try {
                if (Microphone.devices.Length > 0) {
                    deviceName = string.IsNullOrEmpty(target) ? Microphone.devices[0] : target;
                    micClip = Microphone.Start(deviceName, true, 10, 22050);
                    micFreq = micClip.frequency;
                    micActive = true;
                    lastMicPos = Microphone.GetPosition(deviceName);
                    PluginLogger.print($"[Downlink Probe] Started capture: {deviceName} ({micFreq}Hz)");
                }
            } catch (Exception e) { PluginLogger.print("[Downlink Probe] Mic Start Failure: " + e.Message); }
        }

        void StopMic() { if (micActive) { Microphone.End(deviceName); micActive = false; } }

        void OnAudioFilterRead(float[] data, int channels)
        {
            int safeSampleRate = _cachedOutputSampleRate > 0 ? _cachedOutputSampleRate : 48000;
            int gameLen = data.Length / channels;
            float[] gameMono = new float[gameLen];

            float targetPacketGain = pttActive ? 1.0f : 0.0f;
            _packetFadeGain += (targetPacketGain - _packetFadeGain) * 0.2f;

            if (!pttActive && _packetFadeGain < 0.001f) { _isResamplerCold = true; return; }

            for (int i = 0; i < gameLen; i++) {
                float sum = 0;
                for (int c = 0; c < channels; c++) sum += data[i * channels + c];
                gameMono[i] = (sum / channels) * 1.35f;
            }

            if (micActive) {
                float ratio = (float)micFreq / (float)safeSampleRate;
                lock (_micLock) {
                    int available = (_micWritePtr - (int)_micReadPtr + _micRingBuffer.Length) % _micRingBuffer.Length;
                    bool hasEnoughCushion = available > (micFreq * 0.05f);
                    if (hasEnoughCushion) _isMicBuffering = false;
                    if (available < 50) _isMicBuffering = true;
                    float targetMicGain = (pttActive && !_isMicBuffering) ? 1.0f : 0.0f;
                    for (int i = 0; i < gameLen; i++) {
                        _micFadeGain += (targetMicGain - _micFadeGain) * 0.15f;
                        float micV = 0f;
                        if (_micFadeGain > 0.001f) {
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
            int targetLen = 0; double checkPos = finalSrcPos;
            while (checkPos < gameLen - 1) { targetLen++; checkPos += finalRatio; }

            float[] finalSamples = new float[targetLen];
            double currentPos = finalSrcPos;
            for (int i = 0; i < targetLen; i++) {
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

            if (_globalManager != null) _globalManager.BroadcastAudio(finalSamples);
        }
        void OnDestroy() { StopMic(); }
    }
}
