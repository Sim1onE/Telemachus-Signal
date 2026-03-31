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

        public static TelemachusAudioController Instance
        {
            get
            {
                if (_instance == null)
                {
                    var go = new GameObject("TelemachusAudioController");
                    _instance = go.AddComponent<TelemachusAudioController>();
                    DontDestroyOnLoad(go);
                }
                return _instance;
            }
        }

        void Awake()
        {
            _audioSource = gameObject.AddComponent<AudioSource>();
            _audioSource.spatialBlend = 0; // 2D Sound (in-ear headphones for the Kerbal)
            _audioSource.loop = false;
        }

        public void PlayVoiceUplink(byte[] pcmData)
        {
            if (pcmData == null || pcmData.Length == 0) return;

            // Convert Int16 PCM to Float
            float[] samples = new float[pcmData.Length / 2];
            for (int i = 0; i < samples.Length; i++)
            {
                short s = BitConverter.ToInt16(pcmData, i * 2);
                samples[i] = s / 32768.0f;
            }

            // Apply Signal Degradation (Crackle/Noise)
            double quality = TelemachusSignalManager.GetSignalQuality(FlightGlobals.ActiveVessel);
            if (quality < 1.0)
            {
                ApplyRadioEffects(samples, quality);
            }

            // Create temporary clip and play
            AudioClip clip = AudioClip.Create("VoiceUplink", samples.Length, 1, _sampleRate, false);
            clip.SetData(samples, 0);
            
            // We use PlayOneShot to allow overlapping chunks without cutting off
            _audioSource.PlayOneShot(clip);
        }

        private void ApplyRadioEffects(float[] samples, double quality)
        {
            // Simple bitcrushing or noise based on quality
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
