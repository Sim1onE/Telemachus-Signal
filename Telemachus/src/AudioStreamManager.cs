using System;
using System.Collections.Generic;
using UnityEngine;

namespace Telemachus
{
    /// <summary>
    /// Global manager for Audio Downlink.
    /// Distributes audio samples from the Probe to all interested WebSocket sessions.
    /// Rems responsibility from individual KSPUnifiedStreamService instances.
    /// </summary>
    public class AudioStreamManager : MonoBehaviour
    {
        public static AudioStreamManager Instance { get; private set; }
        
        public static void EnsureInstance()
        {
            if (Instance == null)
            {
                GameObject go = new GameObject("TelemachusAudioStreamManager");
                Instance = go.AddComponent<AudioStreamManager>();
                UnityEngine.Object.DontDestroyOnLoad(go);
                PluginLogger.print("[Telemachus-Audio] Global AudioStreamManager instance created.");
            }
        }

        private AudioDownlinkProbe _probe;
        private HashSet<StreamSessionController> _audioSubscribers = new HashSet<StreamSessionController>();

        void Awake()
        {
            Instance = this;
            DontDestroyOnLoad(gameObject);
        }

        public void Register(StreamSessionController session)
        {
            lock (_audioSubscribers) _audioSubscribers.Add(session);
            EnsureProbe();
        }

        public void Unregister(StreamSessionController session)
        {
            lock (_audioSubscribers) _audioSubscribers.Remove(session);
        }

        private void EnsureProbe()
        {
            if (_probe != null) return;
            AudioListener listener = UnityEngine.Object.FindObjectOfType<AudioListener>();
            if (listener != null) {
                _probe = listener.gameObject.GetComponent<AudioDownlinkProbe>();
                if (_probe == null) _probe = listener.gameObject.AddComponent<AudioDownlinkProbe>();
                _probe.SetGlobalManager(this);
            }
        }

        public void BroadcastAudio(float[] samples)
        {
            lock (_audioSubscribers)
            {
                foreach (var session in _audioSubscribers)
                {
                    session.DispatchAudio(samples);
                }
            }
        }
    }
}
