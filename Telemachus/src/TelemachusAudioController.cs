using System;
using System.Collections.Generic;
using UnityEngine;

namespace Telemachus
{
    /// <summary>
    /// Handles real-time audio playback for Voice Comms (Houston to Pilot).
    /// </summary>
    public class TelemachusAudioController : MonoBehaviour
    {
        private static TelemachusAudioController _instance;
        private AudioSource _audioSource;
        private int _sampleRate = 22050;

        private float[] ringBuffer;
        private int writePtr = 0;
        private double readPtr = 0;
        private bool isBuffering = true;
        private float currentGain = 0f; // Smooth fade-in/out to prevent pops
        
        // Anti-Stutter & Flush state
        private int stagnantSamples = 0;
        private readonly object _bufferLock = new object();

        // Sequence Reordering (Uplink Sync)
        private SortedList<double, float[]> _uplinkQueue = new SortedList<double, float[]>();
        private double _lastPushedUT = -1;
        private readonly object _queueLock = new object();

        // --- DIAGNOSTICS (v13.0) ---
        private float _lastDiagTick = 0f;
        private int _packetsSinceLastDiag = 0;
        private long _lastArrivalTick = 0;
        private float _jitterSum = 0;
        private int _jitterCount = 0;
        private string _pendingDiagMsg = null;

        // --- ADAPTIVE SYNC (v14.5) ---
        private float _adaptiveRatio = 1.0f;
        private const float ADAPTIVE_P = 0.20f; // Buffer recovery aggressiveness (20%)
        private const float MAX_ADAPTIVE_PITCH = 1.05f;
        private const float MIN_ADAPTIVE_PITCH = 0.95f;
        private const float TARGET_RESERVOIR_S = 0.200f; // 200ms center (Optimized for local/stable loopback)
        private const int NO_AUDIO_THRESHOLD_SAMPLES = 220; // 10ms minimum safe buffer
        private bool _wasJustTouched = false;
        private float _cachedQuality = 1.0f;
        private double _cachedUT = 0;
        private float _cachedUnscaledTime = 0;

        private readonly int RADIO_RATE = 22050;
        private const int BUFFER_SECONDS = 5;

        public static TelemachusAudioController Instance
        {
            get { return _instance; }
        }

        public static void EnsureInstance()
        {
            if (_instance == null)
            {
                var go = new GameObject("TelemachusAudioController");
                _instance = go.AddComponent<TelemachusAudioController>();
                DontDestroyOnLoad(go);
                PluginLogger.print("[Radio-Diag v14.4] Audio Controller Instance created on Main Thread.");
            }
        }

        void Update()
        {
            // Cache Unity/KSP state on Main Thread for Background Thread use
            _cachedUT = Planetarium.GetUniversalTime();
            _cachedUnscaledTime = Time.unscaledTime;

            if (FlightGlobals.ActiveVessel != null) {
                _cachedQuality = (float)TelemachusSignalManager.GetSignalQuality(FlightGlobals.ActiveVessel);
            } else {
                _cachedQuality = 1.0f;
            }

            if (_wasJustTouched && !_audioSource.isPlaying) {
                _audioSource.Play();
                _wasJustTouched = false;
            }

            // Flush thread-unsafe logs to main thread
            if (_pendingDiagMsg != null) {
                PluginLogger.print(_pendingDiagMsg);
                _pendingDiagMsg = null;
            }
        }

        void Awake()
        {
            _audioSource = gameObject.AddComponent<AudioSource>();
            _audioSource.spatialBlend = 0; // 2D Sound
            
            // Bypass the Listener to prevent Echo Loop
            _audioSource.bypassListenerEffects = true;
            _audioSource.loop = true;
            
            // We need AudioSource to be playing *something* for OnAudioFilterRead to trigger
            int rate = AudioSettings.outputSampleRate;
            _audioSource.clip = AudioClip.Create("RadioSilence", rate, 1, rate, false);
            _audioSource.clip.SetData(new float[rate], 0);
            _audioSource.Play();
            
            ringBuffer = new float[RADIO_RATE * BUFFER_SECONDS];
        }

        public void PlayVoiceUplink(byte[] pcmData, double creationUT)
        {
            if (pcmData == null || pcmData.Length == 0) return;

            long nowMs = DateTime.Now.Ticks / TimeSpan.TicksPerMillisecond;
            if (_lastArrivalTick > 0) {
                float gap = (float)(nowMs - _lastArrivalTick);
                _jitterSum += gap;
                _jitterCount++;
            }
            _lastArrivalTick = nowMs;
            _packetsSinceLastDiag++;

            // --- PROTEZIONE OUT-OF-ORDER (Sequence Reordering) ---
            lock (_queueLock) {
                if (creationUT <= _lastPushedUT) return; 
                _lastPushedUT = creationUT;
            }

            // Convert to float samples
            float[] samples = new float[pcmData.Length / 2];
            for (int i = 0; i < samples.Length; i++)
            {
                short s = BitConverter.ToInt16(pcmData, i * 2);
                samples[i] = s / 32768.0f;
            }

            // Apply Volume Boost (x3.5)
            for (int i = 0; i < samples.Length; i++) {
                samples[i] = Mathf.Clamp(samples[i] * 3.5f, -1f, 1f);
            }

            if (_cachedQuality < 1.0f)
            {
                ApplyRadioEffects(samples, _cachedQuality);
            }

            // WRITE DIRECTLY TO RING BUFFER (Fast Path)
            lock (_bufferLock) 
            {
                for (int i = 0; i < samples.Length; i++) {
                    ringBuffer[writePtr] = samples[i];
                    writePtr = (writePtr + 1) % ringBuffer.Length;
                }
                
                // Catch-up Snap (Only if drifting by > 2 seconds)
                int bufSize = ringBuffer.Length;
                int avail = (writePtr - (int)readPtr + bufSize) % bufSize;
                if (avail > RADIO_RATE * 2.0f && avail < bufSize - RADIO_RATE) {
                    readPtr = (writePtr - (int)(RADIO_RATE * 0.15f) + bufSize) % bufSize;
                }
            }

            _wasJustTouched = true;

            // Diagnostic Tracking (Thread Safe Collection)
            if (_cachedUnscaledTime - _lastDiagTick > 2.0f && _packetsSinceLastDiag > 0) {
                int bufSize = ringBuffer.Length;
                int avail = (writePtr - (int)readPtr + bufSize) % bufSize;
                float availMs = (float)avail / (float)RADIO_RATE * 1000f;
                float drift = (float)(_cachedUT - creationUT);
                float avgJitter = _jitterCount > 0 ? (_jitterSum / _jitterCount) : 0;

                // Queue for Main-Thread Update() to print safely
                _pendingDiagMsg = $"[Radio-Diag v14.5] UPLINK: Sync={_adaptiveRatio:F3}x Reservoir={availMs:F1}ms Drift={drift:F2}s AvgJitter={avgJitter:F1}ms Packets={_packetsSinceLastDiag}";
                
                _lastDiagTick = _cachedUnscaledTime;
                _packetsSinceLastDiag = 0;
                _jitterSum = 0;
                _jitterCount = 0;
            }
        }

        void OnAudioFilterRead(float[] data, int channels)
        {
            if (ringBuffer == null) return;
            
            int hardwareRate = AudioSettings.outputSampleRate;
            double ratio = (double)RADIO_RATE / hardwareRate;
            int bufSize = ringBuffer.Length;

            lock (_bufferLock)
            {
                // Robust Available Data Calculation
                int available = (writePtr - (int)readPtr + bufSize) % bufSize;
                if (available > bufSize - 5000) available = 0;

                // --- ADAPTIVE RE-SAMPLING (v14.0) ---
                // We keep the buffer at TARGET_RESERVOIR_S (150ms) by subtly pitch-shifting.
                // No more Stop/Start gaps!
                float currentReservoirS = (float)available / (float)RADIO_RATE;
                float errorS = currentReservoirS - TARGET_RESERVOIR_S;

                _adaptiveRatio = Mathf.Clamp(1.0f + (errorS * ADAPTIVE_P), MIN_ADAPTIVE_PITCH, MAX_ADAPTIVE_PITCH);

                if (available < NO_AUDIO_THRESHOLD_SAMPLES) isBuffering = true;
                else if (available > RADIO_RATE * TARGET_RESERVOIR_S) isBuffering = false;

                int frames = data.Length / channels;
                for (int i = 0; i < frames; i++)
                {
                    float targetGain = isBuffering ? 0f : 1f;
                    currentGain = Mathf.MoveTowards(currentGain, targetGain, 0.02f); // Gentle gain ramp

                    float sampleValue = 0f;
                    if (!isBuffering) {
                        int i0 = (int)readPtr;
                        int i1 = (i0 + 1) % bufSize;
                        float frac = (float)(readPtr - i0);

                        float s0 = ringBuffer[i0];
                        float s1 = ringBuffer[i1];
                        sampleValue = s0 + (s1 - s0) * frac;
                        
                        // Apply Adaptive Speed
                        readPtr = (readPtr + (ratio * _adaptiveRatio)) % bufSize;
                    }

                    for (int c = 0; c < channels; c++) {
                        data[i * channels + c] += sampleValue * currentGain; 
                    }
                }
            }
        }

        private void ApplyRadioEffects(float[] samples, double quality)
        {
            float noiseLevel = (float)(1.0 - quality) * 0.15f;
            for (int i = 0; i < samples.Length; i++)
            {
                samples[i] += (UnityEngine.Random.value * 2f - 1f) * noiseLevel;
                // Simple clamp
                if (samples[i] > 1f) samples[i] = 1f;
                if (samples[i] < -1f) samples[i] = -1f;
            }
        }
    }
}
