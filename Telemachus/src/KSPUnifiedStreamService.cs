using System;
using WebSocketSharp;
using WebSocketSharp.Server;

namespace Telemachus
{
    /// <summary>
    /// Pure WebSocket Shell for Telemachus Signal.
    /// Delegates all logic to StreamSessionController.
    /// </summary>
    public class KSPUnifiedStreamService : WebSocketBehavior
    {
        private KSPAPIBase api;
        private UpLinkDownLinkRate dataRates;
        private StreamSessionController _controller;

        public KSPUnifiedStreamService(KSPAPIBase apiInstance, UpLinkDownLinkRate rateTracker) { 
            this.api = apiInstance;
            this.dataRates = rateTracker; 
        }

        protected override void OnOpen()
        {
            base.OnOpen();
            // v18.13: Ensure Unity objects (VoiceHandler, etc) are created on Main Thread
            MainThreadDispatcher.Enqueue(() => {
                _controller = new StreamSessionController(this, dataRates);
                PluginLogger.print($"[Downlink] Unified Session {ID} Active (MT-Safe).");
            });
        }

        protected override void OnClose(CloseEventArgs e)
        {
            MainThreadDispatcher.Enqueue(() => {
                if (_controller != null)
                {
                    _controller.Destroy();
                    _controller = null;
                    PluginLogger.print($"[Downlink] Unified Session {ID} Terminated (MT-Safe).");
                }
            });
            base.OnClose(e);
        }

        protected override void OnMessage(MessageEventArgs e)
        {
            // Update metrics immediately on background thread
            if (e.IsBinary) dataRates.RecieveDataFromClient(e.RawData.Length);
            else if (e.IsText) dataRates.RecieveDataFromClient(e.Data.Length);

            // v18.13: Ensure that all operation handlers (sub, list, command) run 
            // safely on the main Unity thread, preventing crashes during session interactions.
            MainThreadDispatcher.Enqueue(() => {
                _controller?.ProcessMessage(e);
            });
        }

        /// <summary>
        /// Generic helper to send JSON packets over the socket.
        /// </summary>
        public void SendUnifiedPacket(System.Collections.Generic.Dictionary<string, object> packet)
        {
            string msg = Json.Encode(packet);
            SendAsync(msg, null);
            dataRates.SendDataToClient(msg.Length);
        }

        /// <summary>
        /// Generic helper to send binary packets over the socket.
        /// </summary>
        public void SendBinary(byte[] data)
        {
            SendAsync(data, null);
            dataRates.SendDataToClient(data.Length);
        }

        /// <summary>
        /// Proxied API call for subscriptions.
        /// </summary>
        public object ProcessAPI(string key) => api.ProcessAPIString(key);

        /// <summary>
        /// Main heartbeat loop called from the plugin update.
        /// </summary>
        public void ProcessUpdate()
        {
            _controller?.Update();
        }
    }
}
