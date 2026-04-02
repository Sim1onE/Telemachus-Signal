// Binary Types for BLOBs only (Large payloads that need low overhead)
const PacketType = {
    VIDEO_DOWNLINK: 0,
    VIDEO_UPLINK: 1,
    AUDIO_DOWNLINK: 2,
    AUDIO_UPLINK: 3
};

const StreamConstants = {
    HEADER_SIZE: 34
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
    clear() { this.queue = []; }
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
        const creationUT = this.signalLink.getEstimatedFlightUT();
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
                    // 1. JSON String (Delayed Flight Command)
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
                    view.setUint8(33, 100); // 100% Signal (Uplink is assumed clear)

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
        };

        this.ws.onmessage = (e) => {
            if (typeof e.data === 'string') {
                const msg = JSON.parse(e.data);
                if (msg.type === 'status') {
                    this.lastPacketUT = msg.ut;
                    this.lastPacketWarp = msg.warp;
                    this.lastPacketReceivedAt = performance.now();
                    this.latestNetworkDelay = msg.delay;
                    if (this.listeners.has('status')) this.listeners.get('status').forEach(cb => cb(msg));
                } else if (msg.type === 'cameraList') {
                    if (this.listeners.has('cameraList')) this.listeners.get('cameraList').forEach(cb => cb(msg, msg.cameras));
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

            if (this.listeners.has(type)) {
                this.listeners.get(type).forEach(cb => cb({ ut: kspUT, warp: kspWarp, delay: kspDelay, fov: kspFOV, quality: kspSignal }, e.data));
            }
        };

        this.ws.onclose = () => {
            this.isRunning = false;
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
