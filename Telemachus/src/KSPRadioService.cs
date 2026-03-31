using System;
using System.Collections.Generic;
using WebSocketSharp;
using WebSocketSharp.Server;
using UnityEngine;
using Telemachus.CameraSnapshots;

namespace Telemachus
{
    public class KSPRadioService : WebSocketBehavior
    {
        private UpLinkDownLinkRate dataRates;

        public KSPRadioService(UpLinkDownLinkRate rateTracker)
        {
            this.dataRates = rateTracker;
        }

        protected override void OnMessage(MessageEventArgs e)
        {
            if (e.IsBinary)
            {
                // Audio Uplink: Riceviamo audio dal browser e lo mandiamo alle casse del Kerbal
                // Il pacchetto è PCM 22050Hz 16-bit Mono (senza header stavolta, solo audio puro)
                byte[] pcmData = e.RawData;
                
                // Usiamo il Dispatcher per gestire l'audio sul thread principale di Unity
                MainThreadDispatcher.Enqueue(() => {
                    TelemachusAudioController.Instance.PlayVoiceUplink(pcmData);
                });

                dataRates.RecieveDataFromClient(pcmData.Length);
            }
        }

        protected override void OnOpen()
        {
            PluginLogger.print("[Radio] Channel opened with Houston.");
        }

        protected override void OnClose(CloseEventArgs e)
        {
            PluginLogger.print("[Radio] Channel closed.");
        }
    }
}
