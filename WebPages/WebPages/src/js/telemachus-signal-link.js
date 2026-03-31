// Packet Type Enum to strictly track data types without magic numbers
const PacketType = {
    VIDEO_DOWNLINK: 0,
    AUDIO_UPLINK: 1,
    AUDIO_DOWNLINK: 2,
    COMMAND_UPLINK: 3
};

const StreamConstants = {
    HEADER_SIZE: 34
};

/**
 * Reusable buffer that holds chronological data (Video frames, Audio PCM).
 * The DownlinkSynchronizer does not care about what data is inside it.
 * It simply answers the question: "Which packets are older than the delayed timecode?"
 */
class DownlinkSynchronizer {
    constructor() {
        this.queue = [];
    }

    pushPacket(ut, warp, delay, fov, quality, payload) {
        this.queue.push({ ut, warp, delay, fov, quality, payload });
        
        // Ensure chronological order in case of weird network packet arrival
        this.queue.sort((a, b) => a.ut - b.ut);
    }

    // Dynamic Catch-Up Method
    // Returns any packet that is "due" to be played given the current signal delay.
    popReady(masterTimecode) {
        let readyPackets = [];
        
        // Extract all packets older than or equal to the current master timecode.
        // If the signal delay just dropped instantly, masterTimecode jumps forward,
        // and this loop will return dozens of packets at once.
        while (this.queue.length > 0 && this.queue[0].ut <= masterTimecode) {
            readyPackets.push(this.queue.shift());
        }
        return readyPackets;
    }

    clear() {
        this.queue = [];
    }
}

/**
 * Ensures Commands and Outgoing Audio are artificially delayed by the client Browser
 * before they reach KSP, protecting KSP memory from overflow.
 */
class UplinkSynchronizer {
    constructor(signalLink) {
        this.signalLink = signalLink;
        this.queue = [];
        this.startQueueProcessing();
    }

    queuePacket(type, payloadAsBytes) {
        let dispatchUT = 0;
        if (this.signalLink.datalink && this.signalLink.datalink.get) {
            // Read the real-world time inside the simulation
            const currentUT = this.signalLink.datalink.get('t.universalTime') || (Date.now() / 1000);
            
            // Read instantaneous delay from recent packets
            const currentDelay = this.signalLink.latestNetworkDelay;
            
            // Calculate when this should be physically fired to the socket
            dispatchUT = currentUT + currentDelay;
        }

        this.queue.push({
            type: type,
            dispatchUT: dispatchUT,
            payload: payloadAsBytes
        });
    }

    startQueueProcessing() {
        setInterval(() => {
            if (!this.signalLink.ws || this.signalLink.ws.readyState !== WebSocket.OPEN) return;
            
            let currentUT = 0;
            if (this.signalLink.datalink && this.signalLink.datalink.get) {
                currentUT = this.signalLink.datalink.get('t.universalTime');
            }
            if (!currentUT) return;

            // Transmit all packets whose artificial wait time has passed
            let i = this.queue.length;
            while (i--) {
                const packet = this.queue[i];
                if (currentUT >= packet.dispatchUT) {
                    
                    // The payload is binary, prepend the Type enum
                    const finalBuffer = new Uint8Array(1 + packet.payload.length);
                    finalBuffer[0] = packet.type;
                    finalBuffer.set(packet.payload, 1);
                    
                    this.signalLink.ws.send(finalBuffer.buffer);
                    this.queue.splice(i, 1);
                }
            }
        }, 33); // ~30 times a second checking
    }
}

/**
 * The Central Hub connecting to the Unified KSP WebSocket.
 * Broadcasts events, does not render anything on its own.
 */
class TelemachusSignalLink {
    constructor(streamUrl, datalink) {
        this.streamUrl = streamUrl;
        this.datalink = datalink; // Used to fetch polling UT (t.universalTime)
        
        this.ws = null;
        this.isRunning = false;
        
        // This variable is the instantaneous Reality Clock for signal
        this.latestNetworkDelay = 0;

        this.listeners = new Map();
        
        // Local transmission Queue
        this.uplink = new UplinkSynchronizer(this);
    }

    on(packetType, callback) {
        if (!this.listeners.has(packetType)) {
            this.listeners.set(packetType, []);
        }
        this.listeners.get(packetType).push(callback);
    }

    connect() {
        if (this.isRunning) return;
        this.isRunning = true;
        
        this.ws = new WebSocket(this.streamUrl);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
             console.log("[SignalLink] Unified Data Stream Hub Active");
        };

        this.ws.onmessage = (e) => {
            if (typeof e.data === 'string') return; // Ignore legacy text streams

            const view = new DataView(e.data);
            const type = view.getUint8(0);

            // Decode 34-byte Unified Header
            const kspUT = view.getFloat64(1, true);
            const kspWarp = view.getFloat64(9, true);
            const kspDelay = view.getFloat64(17, true);
            const kspFOV = view.getFloat64(25, true);
            const kspSignal = view.getUint8(33);

            // VERY IMPORTANT: Instant Delay monitoring. We do NOT buffer this value.
            this.latestNetworkDelay = kspDelay;

            // Route to Consumers (e.g. CameraReceiver, AudioReceiver) via Composition
            if (this.listeners.has(type)) {
                // Pass structured metadata and raw buffer payload
                const callbacks = this.listeners.get(type);
                for (let cb of callbacks) {
                    cb({ ut: kspUT, warp: kspWarp, delay: kspDelay, fov: kspFOV, quality: kspSignal }, e.data);
                }
            }
        };

        this.ws.onclose = () => {
            console.warn("[SignalLink] WebSocket Closed. Reconnecting Subsystem...");
            this.isRunning = false;
            setTimeout(() => this.connect(), 2000);
        };
    }

    disconnect() {
         this.isRunning = false;
         if (this.ws) {
             this.ws.close();
             this.ws = null;
         }
    }

    // Sends specific JSON commands immediately (Ignoring delay logic, typical for Subscriptions)
    sendSystemCommand(cmdObject) {
         if (this.ws && this.ws.readyState === WebSocket.OPEN) {
             this.ws.send(JSON.stringify(cmdObject));
         }
    }

    // Delays binary payloads (Phase 2+)
    queueUplink(type, payloadUint8Array) {
         this.uplink.queuePacket(type, payloadUint8Array);
    }
}

// Ensure modules attach to the window in vanilla JS
if (typeof window !== 'undefined') {
    window.PacketType = PacketType;
    window.StreamConstants = StreamConstants;
    window.DownlinkSynchronizer = DownlinkSynchronizer;
    window.UplinkSynchronizer = UplinkSynchronizer;
    window.TelemachusSignalLink = TelemachusSignalLink;
}
