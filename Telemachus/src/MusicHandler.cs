using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

namespace Telemachus
{
    public class MusicHandler : DataLinkHandler
    {
        public static MusicHandler Instance { get; private set; }
        private string _lastReportedName = "";
        
        private MusicStatus _cachedStatus;
        private int _lastUpdateFrame = -1;

        // v16.110: Known tracks that we have MP3s for.
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

                var masters = UnityEngine.Object.FindObjectsOfType<AudioSource>();
                AudioSource bestCandidate = null;
                bool foundWhitelisted = false;

                // v16.111: Discovery-Friendly Detection
                foreach (var source in masters)
                {
                    if (source.clip == null || source.spatialBlend > 0.1f) continue;

                    string rawName = source.clip.name;
                    string cleanName = rawName.Replace(".mp3", "").Replace(".wav", "").Replace(".ogg", "");
                    
                    bool isWhitelisted = SoundtrackWhitelist.Contains(cleanName);

                    // If whitelisted and playing, it's our absolute top priority
                    if (isWhitelisted && source.isPlaying)
                    {
                        bestCandidate = source;
                        foundWhitelisted = true;
                        break;
                    }

                    // If not found yet, look for any playing "long" 2D track (High discovery probability)
                    if (bestCandidate == null && source.isPlaying && source.clip.length > 20f && !source.loop)
                    {
                        bestCandidate = source;
                    }
                }

                // Fallback: If nothing is "playing", check for paused whitelisted tracks (to keep the UI stable)
                if (bestCandidate == null)
                {
                    foreach (var source in masters)
                    {
                        if (source.clip != null && source.spatialBlend < 0.1f)
                        {
                            string cleanName = source.clip.name.Replace(".mp3", "").Replace(".wav", "").Replace(".ogg", "");
                            if (SoundtrackWhitelist.Contains(cleanName))
                            {
                                bestCandidate = source;
                                foundWhitelisted = true;
                                break;
                            }
                        }
                    }
                }

                if (bestCandidate != null)
                {
                    status.name = bestCandidate.clip.name;
                    status.time = bestCandidate.time;
                    status.duration = bestCandidate.clip.length;
                    status.isPlaying = bestCandidate.isPlaying;
                }

                if (status.name != _lastReportedName && status.name != "None")
                {
                    if (foundWhitelisted)
                        PluginLogger.print(string.Format("[MusicSync] Active Soundtrack: {0}", status.name));
                    else
                        PluginLogger.print(string.Format("[MusicSync] DISCOVERY: Detected unknown 2D track: {0}. Add this to your MP3 folder to sync!", status.name));
                    
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
