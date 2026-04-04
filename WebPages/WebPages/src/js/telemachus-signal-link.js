// Binary Types for BLOBs only (Large payloads that need low overhead)
const PacketType = {
    VIDEO_DOWNLINK: 0,
    VIDEO_UPLINK: 1,
    AUDIO_DOWNLINK: 2,
    AUDIO_UPLINK: 3
};

const StreamConstants = {
    HEADER_SIZE: 35 // v16.01: Matches server 35 bytes
};

class DownlinkSynchronizer {
    constructor() { this.queue = []; }
    pushPacket(ut, warp, delay, fov, quality, payload) {
        this.queue.push({ ut, warp, delay, fov, quality, payload });
        this.queue.sort((a, b) => a.ut - b.ut);
    }
    popReady(masterTimecode) {
        let readyPackets = [];
        while (this.queue.length > 0 && this.queue[0].ut <= masterTimecode) {
            const p = this.queue.shift(); // The packet is now GONE from the queue forever.
            
            // ANTI-LOOP BARRIER: Never play the same (or older) UT twice in one session.
            if (this.lastPoppedUT !== undefined && p.ut <= this.lastPoppedUT) {
                continue; 
            }
            
            this.lastPoppedUT = p.ut;
            readyPackets.push(p);
        }
        return readyPackets;
    }
    clear() { 
        this.queue = []; 
        this.lastPoppedUT = undefined; // v15.04: Reset epoch barrier on clean
    }
}

/**
 * Polymorphic Uplink Synchronizer. 
 * Can queue either Binary (Blobs) or Strings (JSON) for delayed transmission.
 */
class UplinkSynchronizer {
    constructor(signalLink) {
        this.signalLink = signalLink;
        this.queue = [];
        this.startQueueProcessing();
    }

    // binaryType (Number) or null if string
    queuePacket(type, payload) {
        let creationUT = this.signalLink.getEstimatedFlightUT();
        
        // v14.13 Fix: If KSP physics stalled, `getEstimatedFlightUT` can snap backwards during sync.
        // If an audio packet timestamp snaps backwards, it gets filtered/sorted out of order!
        // We rigidly enforce a strictly monotonic progression for all queued packets.
        if (this._lastCreationUT !== undefined && creationUT <= this._lastCreationUT) {
            creationUT = this._lastCreationUT + 0.000001;
        }
        this._lastCreationUT = creationUT;

        this.queue.push({ type, creationUT, payload });
    }

    startQueueProcessing() {
        setInterval(() => {
            if (!this.signalLink.ws || this.signalLink.ws.readyState !== WebSocket.OPEN) return;

            const currentUT = this.signalLink.getEstimatedFlightUT();
            const instantDelay = this.signalLink.latestNetworkDelay;

            let toSend = [];
            let i = 0;
            while (i < this.queue.length) {
                const packet = this.queue[i];
                if (currentUT >= packet.creationUT + instantDelay) {
                    toSend.push(packet);
                    this.queue.splice(i, 1);
                } else {
                    i++;
                }
            }

            // Guaranteed Chronological Transmission (v14.12)
            toSend.sort((a,b) => a.creationUT - b.creationUT);

            toSend.forEach(packet => {
                if (typeof packet.payload === 'string') {
                    // JSON String (Uplink Command) - Sent individually to prevent key collisions (v16.14)
                    this.signalLink.ws.send(packet.payload);
                } else {
                    // 2. Binary Buffer (Delayed Audio)
                    const finalBuffer = new Uint8Array(StreamConstants.HEADER_SIZE + packet.payload.length);
                    const view = new DataView(finalBuffer.buffer);
                    
                    // Fill 34-byte Header
                    view.setUint8(0, packet.type);
                    view.setFloat64(1, packet.creationUT, true);
                    view.setFloat64(9, this.signalLink.lastPacketWarp || 1.0, true);
                    view.setFloat64(17, instantDelay, true);
                    view.setFloat64(25, 0, true); // No FOV for audio
                    view.setUint8(33, this.signalLink.latestQuality || 100); 
                    view.setUint8(34, 0); // v16.01: CameraID (0 for audio/system)

                    finalBuffer.set(packet.payload, StreamConstants.HEADER_SIZE);
                    this.signalLink.ws.send(finalBuffer.buffer);
                }
            });
        }, 33);
    }
}

class TelemachusSignalLink {
    constructor(streamUrl, datalink) {
        this.streamUrl = streamUrl;
        this.datalink = datalink;
        this.ws = null;
        this.isRunning = false;
        this.lastPacketUT = 0;
        this.lastPacketWarp = 1;
        this.lastPacketReceivedAt = 0;
        this.latestNetworkDelay = 0;
        this.latestQuality = 100;
        this.listeners = new Map();
        this.uplink = new UplinkSynchronizer(this);
    }

    getEstimatedFlightUT() {
        if (!this.lastPacketReceivedAt) return 0;
        const now = performance.now();
        const elapsedS = (now - this.lastPacketReceivedAt) / 1000.0;
        return this.lastPacketUT + (elapsedS * this.lastPacketWarp);
    }

    on(typeOrName, callback) {
        if (!this.listeners.has(typeOrName)) this.listeners.set(typeOrName, []);
        this.listeners.get(typeOrName).push(callback);
    }

    connect() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.ws = new WebSocket(this.streamUrl);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            console.log("[SignalLink] Unified Data Stream Hub Active");
            this.requestCameraList();
            if (this.listeners.has('open')) this.listeners.get('open').forEach(cb => cb());
        };

        this.ws.onmessage = (e) => {
            if (typeof e.data === 'string') {
                const msg = JSON.parse(e.data);
                if (msg.type === 'status') {
                    this.lastPacketUT = msg.ut;
                    this.lastPacketWarp = msg.warp;
                    this.lastPacketReceivedAt = performance.now();
                    this.latestNetworkDelay = msg.delay;
                    this.latestQuality = msg.quality !== undefined ? msg.quality : 100;
                }
                
                // Generic dispatch for all JSON types (v16.21)
                if (msg.type && this.listeners.has(msg.type)) {
                    this.listeners.get(msg.type).forEach(cb => cb(msg));
                }
                return;
            }

            const view = new DataView(e.data);
            const type = view.getUint8(0);
            const kspUT = view.getFloat64(1, true);
            const kspWarp = view.getFloat64(9, true);
            const kspDelay = view.getFloat64(17, true);
            const kspFOV = view.getFloat64(25, true);
            const kspSignal = view.getUint8(33);
            const kspCameraID = view.getUint8(34); // v16.01: Camera Identifier

            this.latestQuality = kspSignal;

            if (this.listeners.has(type)) {
                this.listeners.get(type).forEach(cb => cb({ 
                    ut: kspUT, 
                    warp: kspWarp, 
                    delay: kspDelay, 
                    fov: kspFOV, 
                    quality: kspSignal,
                    id: kspCameraID 
                }, e.data));
            }
        };

        this.ws.onclose = () => {
            this.isRunning = false;
            
            // v16.96: Dispatch disconnection event
            if (this.listeners.has('close')) this.listeners.get('close').forEach(cb => cb());

            // v15.05 Reset internal flight clock state on disconnect
            this.lastPacketUT = 0;
            this.lastPacketReceivedAt = 0;
            this.latestNetworkDelay = 0;
            this.lastPacketWarp = 1;

            setTimeout(() => this.connect(), 2000);
        };
    }

    // Sends specific JSON commands immediately (Ignoring delay logic)
    sendSystemCommand(cmdObject) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(cmdObject));
        }
    }

    // Delays binary payloads (Audio)
    queueUplink(type, payloadUint8Array) {
        this.uplink.queuePacket(type, payloadUint8Array);
    }

    // Delays JSON commands through the string-synchronizer
    queueCommand(cmdObject) {
        this.uplink.queuePacket(null, JSON.stringify(cmdObject));
    }

    requestCameraList() {
        this.sendSystemCommand({ list: true });
    }
}

if (typeof window !== 'undefined') {
    window.PacketType = PacketType;
    window.StreamConstants = StreamConstants;
    window.DownlinkSynchronizer = DownlinkSynchronizer;
    window.UplinkSynchronizer = UplinkSynchronizer;
    window.TelemachusSignalLink = TelemachusSignalLink;
}
