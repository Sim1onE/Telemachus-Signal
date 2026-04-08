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

const SignalConstants = {
    DATALINK_SAMPLE_RATE: 200,
    CORRUPTION_THRESHOLD: 20, // % Quality under which corruption starts
    LOSS_MODIFIER: 2.0,       // Scaling factor for packet loss (v16.43: Higher = worse penalty)
    JITTER_BUFFER: 0.1        // v16.38: 100ms safety margin for network jitter
};

class DownlinkSynchronizer {
    constructor() { this.queue = []; }
    pushPacket(msg) {
        this.queue.push(msg);
        this.queue.sort((a, b) => a.ut - b.ut);
    }
    popReady(masterTimecode) {
        let readyPackets = [];
        while (this.queue.length > 0 && this.queue[0].ut <= masterTimecode) {
            const p = this.queue.shift(); // The packet is now GONE from the queue forever.

            // ANTI-LOOP BARRIER: Never play older UT twice in one session.
            // v16.32 Fix: Changed from <= to < to allow multiple packet types (telemetry, orbit) 
            // from the same game tick to be released together.
            if (this.lastPoppedUT !== undefined && p.ut < this.lastPoppedUT) {
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
        // v16.43: Discard uplink if not synchronized
        if (!this.signalLink._isClockSync) return;

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
            toSend.sort((a, b) => a.creationUT - b.creationUT);

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
        this.datalinkSync = new DownlinkSynchronizer();
        this.lastDatalinkData = {
            "referenceBodies": {} // v21.8.4: Pre-initialize for formatter stability
        };

        // v16.35: Smoothing & Interpolation props
        this._lastStatusMET = 0;
        this._lastStatusUT = 0; // Local reference for LaunchTime calc
        this._lastReturnedFlightUT = 0; // v16.43: Monotonicity tracker
        this._isClockSync = false;      // v16.43: Initial sync guard

        this.startDatalinkReleaseLoop();
        this.startSmoothingLoop();
    }

    static detectStreamUrl() {
        // v16.37: WebSocket stream is always at the root on this server
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        return `${protocol}//${host}/stream`;
    }

    getEstimatedFlightUT() {
        if (!this.lastPacketReceivedAt) return 0;
        const now = performance.now();
        const elapsedS = (now - this.lastPacketReceivedAt) / 1000.0;
        let estUT = this.lastPacketUT + (elapsedS * this.lastPacketWarp);

        // v16.43 Monotonicity: Clock must NEVER snap backwards
        if (estUT < this._lastReturnedFlightUT) {
            estUT = this._lastReturnedFlightUT + 0.0001;
        }
        this._lastReturnedFlightUT = estUT;
        return estUT;
    }

    getEstimatedDelayedUT() {
        // v16.43: Include Jitter Buffer in presentation target
        return this.getEstimatedFlightUT() - this.latestNetworkDelay - SignalConstants.JITTER_BUFFER;
    }

    getEstimatedDelayedMET() {
        if (this._lastStatusMET === 0 || this.lastPacketUT === 0) return 0;

        // MET = UT - LaunchTime
        // LaunchTime is estimated as (status.ut - status.met)
        const launchTime = this._lastStatusUT - this._lastStatusMET;
        const delayedUT = this.getEstimatedDelayedUT();

        return delayedUT - launchTime;
    }

    on(typeOrName, callback) {
        if (!this.listeners.has(typeOrName)) this.listeners.set(typeOrName, []);
        this.listeners.get(typeOrName).push(callback);
    }

    off(typeOrName, callback) {
        if (!this.listeners.has(typeOrName)) return;
        const list = this.listeners.get(typeOrName);
        const idx = list.indexOf(callback);
        if (idx !== -1) list.splice(idx, 1);
    }

    sendRequest(action, target, payload, callback) {
        const id = Math.random().toString(36).substr(2, 9);
        payload.id = id;

        const responseType = target + "_response";
        const handler = (msg) => {
            if (msg.id === id || (msg.data && msg.data.id === id)) {
                this.off(responseType, handler);
                callback(msg.data);
            }
        };

        this.on(responseType, handler);
        this.send(action, target, payload);
    }

    connect() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.ws = new WebSocket(this.streamUrl);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            console.log("[SignalLink] Unified Data Stream Hub Active");
            if (this.listeners.has('open')) this.listeners.get('open').forEach(cb => cb());
        };

        this.ws.onmessage = (e) => {
            if (typeof e.data === 'string') {
                const msg = JSON.parse(e.data);
                const type = msg.type;

                // v18.15: Special handling for 'tick' (Master Clock)
                if (type === 'tick' && msg.data) {
                    const d = msg.data;
                    this.lastPacketUT = d.ut;
                    this.lastPacketWarp = (d.warp !== undefined) ? d.warp : 1; // v21.8.160: Strict Warp Reset
                    this.lastPacketReceivedAt = performance.now();
                    this.latestNetworkDelay = d.delay;
                    this.latestQuality = d.quality;
                    this._lastStatusUT = d.ut;
                    this._lastStatusMET = d.met;
                    this._isClockSync = true;
                }
                else if (msg.ut !== undefined) {
                    // Standard header for all other types: { type, ut, data }
                    this.lastPacketUT = msg.ut;
                    this.lastPacketReceivedAt = performance.now();
                }

                const dataPayload = msg.data || msg;

                // Generic dispatch for all JSON types (v16.21)
                if (type && this.listeners.has(type)) {
                    this.listeners.get(type).forEach(cb => cb({
                        type: type,
                        ut: msg.ut || this.lastPacketUT,
                        data: dataPayload
                    }, msg));
                }

                // v16.30: Datalink specific sync insertion (v18.18: telemetry unificata a datalink)
                if (type === 'datalink' || type === 'telemetry' || type === 'orbit') {
                    this.datalinkSync.pushPacket({
                        type: type,
                        ut: msg.ut,
                        warp: this.lastPacketWarp,
                        delay: this.latestNetworkDelay,
                        fov: 0,
                        quality: this.latestQuality,
                        payload: dataPayload
                    });
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
                    type: type,
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

    // Generic send for hierarchical actions with specific targets (v21.5)
    send(action, target = "", payload = {}) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const msg = { action };
            if (target) msg.target = target;
            if (payload && Object.keys(payload).length > 0) msg.payload = payload;
            this.ws.send(JSON.stringify(msg));
        }
    }

    // Sends specific JSON commands immediately (Ignoring delay logic)
    sendSystemCommand(cmdObject) {
        // Obsolete: redirection to new 'send'
        if (cmdObject.action) {
            this.send(cmdObject.action, cmdObject.target || "", cmdObject.payload || {});
        } else if (cmdObject.op) {
            console.warn("[SignalLink] Legacy 'op' detected.");
        }
    }

    // Delays binary payloads (Audio)
    queueUplink(type, payloadUint8Array) {
        this.uplink.queuePacket(type, payloadUint8Array);
    }

    // Delays JSON commands through the string-synchronizer
    queueCommand(action, target = "", payload = {}) {
        const msg = { action };
        if (target) msg.target = target;
        if (payload && Object.keys(payload).length > 0) msg.payload = payload;
        this.uplink.queuePacket(null, JSON.stringify(msg));
    }

    requestCameraList() {
        this.send("resource/list", "cameras");
    }

    subscribeTick(options = {}) {
        this.send("stream/subscribe", "tick", options);
    }

    unsubscribeTick() {
        this.send("stream/unsubscribe", "tick");
    }

    // Deprecated alias for subscribeTick
    subscribeStatus(options) { this.subscribeTick(options); }

    subscribeSoundtrack(options = {}) {
        this.send("stream/subscribe", "soundtrack", options);
    }

    unsubscribeSoundtrack() {
        this.send("stream/unsubscribe", "soundtrack");
    }

    subscribeTelemetry(keys, options = {}) {
        this.send("stream/subscribe", "telemetry", {
            keys: Array.isArray(keys) ? keys : [keys],
            ...options
        });
    }

    // v18.11: Multi-camera subscription
    subscribeCamera(id, name, options = {}) {
        this.send("stream/subscribe", "camera", {
            id: id,
            name: name,
            ...options
        });
    }

    unsubscribeCamera(id) {
        this.send("stream/unsubscribe", "camera", { id: id });
    }

    subscribeAudio() {
        this.send("stream/subscribe", "audio");
    }

    unsubscribeAudio() {
        this.send("stream/unsubscribe", "audio");
    }

    subscribeOrbit(options = {}) {
        this.send("stream/subscribe", "orbit", options);
    }

    unsubscribeOrbit() {
        this.send("stream/unsubscribe", "orbit");
    }

    // v18.14: Generic subscribe for backward compatibility
    subscribe(keys, options = {}) {
        this.subscribeTelemetry(keys, options);
    }

    unsubscribe(keys) {
        this.send("stream/unsubscribe", "telemetry", { rm: Array.isArray(keys) ? keys : [keys] });
    }

    startDatalinkReleaseLoop() {
        setInterval(() => {
            const flightUT = this.getEstimatedFlightUT();

            // v16.32 Fix: Subtract the simulated network delay to find our target presentation UT
            const delayedUT = flightUT - this.latestNetworkDelay;
            const ready = this.datalinkSync.popReady(delayedUT);

            ready.forEach(packet => {
                // 1. Packet Loss Simulation (v16.43 FIX: Corrected formula)
                const lossChance = (100 - packet.quality) * SignalConstants.LOSS_MODIFIER;
                if (Math.random() * 100 < lossChance) {
                    return; // Packet lost in transmission
                }

                // 2. Data Corruption Simulation (at very low quality)
                let data = { ...packet.payload };
                if (packet.quality < SignalConstants.CORRUPTION_THRESHOLD) {
                    Object.keys(data).forEach(key => {
                        if (Math.random() < 0.3) {
                            data[key] = null;
                        }
                    });
                }

                // v16.32: Update the generic data store
                Object.assign(this.lastDatalinkData, data);

                // 3. Dispatch delayed and degraded event
                if (this.listeners.has('datalink_update')) {
                    this.listeners.get('datalink_update').forEach(cb => cb({
                        type: packet.type,
                        ut: packet.ut,
                        quality: packet.quality,
                        data: data // v18.14: Standardized to .data
                    }));
                }
            });
        }, 50); // Release check at 20Hz
    }

    startSmoothingLoop() {
        const tick = () => {
            if (this.isRunning && this.listeners.has('smooth_tick')) {
                const data = {
                    ut: this.getEstimatedDelayedUT(),
                    met: this.getEstimatedDelayedMET(),
                    quality: this.latestQuality
                };

                this.listeners.get('smooth_tick').forEach(cb => cb({
                    type: 'tick',
                    ut: data.ut,
                    data: data // v18.17: Nested for uniformity with real JSON messages
                }));
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }
}

if (typeof window !== 'undefined') {
    window.PacketType = PacketType;
    window.StreamConstants = StreamConstants;
    window.DownlinkSynchronizer = DownlinkSynchronizer;
    window.UplinkSynchronizer = UplinkSynchronizer;
    window.TelemachusSignalLink = TelemachusSignalLink;
}
