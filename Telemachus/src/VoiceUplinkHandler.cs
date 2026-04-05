using System;
using UnityEngine;

namespace Telemachus
{
    /// <summary>
    /// Handles Audio Uplink (voice from Houston) for a specific session.
    /// Simplified to delegate all work to the central TelemachusAudioController.
    /// </summary>
    public class VoiceUplinkHandler
    {
        private string sessionID;

        public VoiceUplinkHandler(string id)
        {
            this.sessionID = id;
            // Ensure central audio hardware is initialized on session start
            MainThreadDispatcher.Enqueue(() =>
            {
                TelemachusAudioController.EnsureInstance();
            });
        }

        public void HandleIncomingAudio(byte[] pcmData, double creationUT)
        {
            // v18.51: Second safety to prevent races on the first packet
            TelemachusAudioController.EnsureInstance();
            if (TelemachusAudioController.Instance != null)
            {
                TelemachusAudioController.Instance.PlayVoiceUplink(pcmData, creationUT);
            }
        }

        public void Destroy()
        {
            // Session specific cleanup if needed, but the central instance persists
        }
    }
}
