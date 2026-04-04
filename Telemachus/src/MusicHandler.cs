using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

namespace Telemachus
{
    public class MusicHandler : DataLinkHandler
    {
        public static MusicHandler Instance { get; private set; }
        private AudioSource _lastBestSource = null;
        private string _lastReportedName = "";
        
        private MusicStatus _cachedStatus;
        private int _lastUpdateFrame = -1;

        private static readonly HashSet<string> SoundtrackWhitelist = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Arcadia", "Bathed in the Light", "Brittle Rille", "Dreamy Flashback",
            "Frost Waltz (Alternate)", "Frost Waltz", "Frozen Star", "Groove Grove",
            "Impact Lento", "Sneaky Adventure", "Wizardtorium"
        };

        public MusicHandler(FormatterProvider formatters) : base(formatters)
        {
            Instance = this;
        }

        public struct MusicStatus
        {
            public string name;
            public float time;
            public float duration;
            public bool isPlaying;
        }

        public MusicStatus GetCurrentStatus()
        {
            if (Time.frameCount == _lastUpdateFrame) return _cachedStatus;

            _cachedStatus = MainThreadDispatcher.Run(() =>
            {
                MusicStatus status = new MusicStatus
                {
                    name = "None",
                    time = 0,
                    duration = 0,
                    isPlaying = false
                };

                // v16.95: Persistent soundtrack detection even when paused
                var masters = UnityEngine.Object.FindObjectsOfType<AudioSource>();
                AudioSource candidate = null;

                // Priority 1: Check if any whitelist track is currently PLAYING
                foreach (var source in masters)
                {
                    if (source.isPlaying && source.clip != null && source.spatialBlend == 0)
                    {
                        string cleanName = source.clip.name.Replace(".mp3", "").Replace(".wav", "").Replace(".ogg", "");
                        if (SoundtrackWhitelist.Contains(cleanName))
                        {
                            candidate = source;
                            break;
                        }
                    }
                }

                // Priority 2: If none is playing, check if any whitelist track is merely LOADED/PAUSED
                if (candidate == null)
                {
                    foreach (var source in masters)
                    {
                        if (source.clip != null && source.spatialBlend == 0)
                        {
                            string cleanName = source.clip.name.Replace(".mp3", "").Replace(".wav", "").Replace(".ogg", "");
                            if (SoundtrackWhitelist.Contains(cleanName))
                            {
                                candidate = source;
                                break;
                            }
                        }
                    }
                }

                if (candidate != null)
                {
                    status.name = candidate.clip.name;
                    status.time = candidate.time;
                    status.duration = candidate.clip.length;
                    status.isPlaying = candidate.isPlaying;
                }

                if (status.name != _lastReportedName)
                {
                    PluginLogger.print(string.Format("[MusicSync] Soundtrack state: {0} (Playing: {1})", status.name, status.isPlaying));
                    _lastReportedName = status.name;
                }

                return status;
            });

            _lastUpdateFrame = Time.frameCount;
            return _cachedStatus;
        }

        [TelemetryAPI("a.music.name", "Current soundtrack name")]
        public object GetMusicName(DataSources dataSources)
        {
            return GetCurrentStatus().name;
        }

        [TelemetryAPI("a.music.time", "Current time in seconds")]
        public object GetMusicTime(DataSources dataSources)
        {
            return GetCurrentStatus().time;
        }

        [TelemetryAPI("a.music.duration", "Total duration in seconds")]
        public object GetMusicDuration(DataSources dataSources)
        {
            return GetCurrentStatus().duration;
        }

        [TelemetryAPI("a.music.playing", "Whether music is playing")]
        public object GetMusicPlaying(DataSources dataSources)
        {
            return GetCurrentStatus().isPlaying ? 1 : 0;
        }
    }
}
