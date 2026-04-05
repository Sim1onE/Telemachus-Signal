using System;
using System.Collections.Generic;
using System.Linq;
using WebSocketSharp;

namespace Telemachus
{
    /// <summary>
    /// Interface for JSON operation handlers (sub, list, command, etc.).
    /// </summary>
    public interface IStreamOpHandler
    {
        string[] Actions { get; }
        void Handle(string action, string target, Dictionary<string, object> payload, StreamSessionController controller);
    }

    /// <summary>
    /// The actual logic controller for a WebSocket session.
    /// Decoupled from the WebSocketBehavior itself.
    /// </summary>
    public class StreamSessionController
    {
        private List<ISubscription> _activeSubscriptions = new List<ISubscription>();
        private Dictionary<string, IStreamOpHandler> _opHandlers = new Dictionary<string, IStreamOpHandler>();

        private KSPUnifiedStreamService _socket;
        private UpLinkDownLinkRate _dataRates;
        private VoiceUplinkHandler _uplinkHandler;

        public KSPUnifiedStreamService Socket => _socket;

        public StreamSessionController(KSPUnifiedStreamService socket, UpLinkDownLinkRate rates)
        {
            this._socket = socket;
            this._dataRates = rates;
            this._uplinkHandler = new VoiceUplinkHandler(socket.ID);

            // Register default handlers
            RegisterHandler(new SubscriptionOpHandler());
            RegisterHandler(new ResourceListOpHandler());
            RegisterHandler(new CommandOpHandler());
        }

        public void RegisterHandler(IStreamOpHandler handler) {
            foreach(var action in handler.Actions) {
                _opHandlers[action] = handler;
            }
        }

        public void ProcessMessage(MessageEventArgs e)
        {
            if (e.IsBinary)
            {
                HandleBinary(e.RawData);
            }
            else if (e.IsText)
            {
                HandleText(e.Data);
            }
        }

        private void HandleBinary(byte[] raw)
        {
            if (raw.Length < TelemachusProtocol.HEADER_SIZE) return;
            byte type = raw[0];
            if (type == (byte)PacketType.AudioUplink)
            {
                double ut = BitConverter.ToDouble(raw, 1);
                byte[] pcm = new byte[raw.Length - TelemachusProtocol.HEADER_SIZE];
                Buffer.BlockCopy(raw, TelemachusProtocol.HEADER_SIZE, pcm, 0, pcm.Length);
                _uplinkHandler.HandleIncomingAudio(pcm, ut);
            }
        }

        private void HandleText(string text)
        {
            try
            {
                var json = Json.DecodeObject(text) as Dictionary<string, object>;
                if (json != null && json.ContainsKey("action"))
                {
                    string action = json["action"].ToString();
                    string target = json.ContainsKey("target") ? json["target"].ToString() : "";
                    var payload = json.ContainsKey("payload") ? json["payload"] as Dictionary<string, object> : new Dictionary<string, object>();
                    
                    if (_opHandlers.ContainsKey(action)) 
                    {
                        _opHandlers[action].Handle(action, target, payload, this);
                    }
                }
            }
            catch { }
        }

        public void Update()
        {
            TelemachusAudioController.EnsureInstance();
            double ut = Planetarium.GetUniversalTime();
            foreach (var sub in _activeSubscriptions.ToArray())
            {
                if (sub.ShouldUpdate(ut)) sub.Execute(_socket);
            }
        }

        public void DispatchAudio(float[] samples)
        {
            var audioSub = GetSubscription("audio") as AudioSubscription;
            if (audioSub != null) audioSub.ProcessAudio(samples, _socket);
        }

        public void Destroy()
        {
            foreach (var sub in _activeSubscriptions.ToArray())
            {
                sub.OnStop(this);
            }
            _uplinkHandler?.Destroy();
            _activeSubscriptions.Clear();
        }

        // Helpers for handlers
        public void AddSubscription(ISubscription sub) => _activeSubscriptions.Add(sub);

        public void RemoveSubscriptionByKey(string key)
        {
            var target = _activeSubscriptions.FirstOrDefault(s => s.SubscriptionKey == key);
            if (target != null)
            {
                target.OnStop(this);
                _activeSubscriptions.Remove(target);
            }
        }

        public void RemoveSubscription(string type)
        {
            var targets = _activeSubscriptions.Where(s => s.StreamType == type).ToList();
            foreach (var sub in targets)
            {
                sub.OnStop(this);
                _activeSubscriptions.Remove(sub);
            }
        }

        public ISubscription GetSubscription(string type) => _activeSubscriptions.FirstOrDefault(s => s.StreamType == type);
        public ISubscription GetSubscriptionByKey(string key) => _activeSubscriptions.FirstOrDefault(s => s.SubscriptionKey == key);

        public void SendUnified(Dictionary<string, object> packet) => _socket.SendUnifiedPacket(packet);
        public void SendBinary(byte[] data) => _socket.SendBinary(data);
        public object ProcessAPI(string key) => _socket.ProcessAPI(key);
    }
}
