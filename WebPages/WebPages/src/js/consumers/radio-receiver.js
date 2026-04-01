/**
 * Isolated Component (Composition Pattern)
 * This class handles the playback of incoming KSP game audio.
 * It uses the standardized DownlinkSynchronizer to maintain the 'signal delay' effect.
 */
class RadioReceiver {
    constructor(signalLink, audioCtx) {
        this.signalLink = signalLink;
        this.audioCtx = audioCtx;
        this.sync = new DownlinkSynchronizer();
        this.isRunning = false;

        // Sub to Type 2 (Audio Downlink)
        this.signalLink.on(PacketType.AUDIO_DOWNLINK, this.handleIncomingAudio.bind(this));
    }

    start() {
        this.isRunning = true;
        this.playbackLoop();
    }

    stop() {
        this.isRunning = false;
        this.sync.clear();
    }

    handleIncomingAudio(metadata, rawData) {
        if (!this.isRunning) return;

        // Skip 34-byte header
        const pcmBytes = new Int16Array(rawData.slice(StreamConstants.HEADER_SIZE));
        
        // Convert Int16 to Float32 for Web Audio API
        const floatSamples = new Float32Array(pcmBytes.length);
        for (let i = 0; i < pcmBytes.length; i++) {
            floatSamples[i] = pcmBytes[i] / 32768.0;
        }

        // Queue in synchronizer
        this.sync.pushPacket(
            metadata.ut, metadata.warp, metadata.delay, 
            0, metadata.quality, 
            { samples: floatSamples }
        );
    }

    playbackLoop() {
        if (!this.isRunning) return;

        const flightTimeNow = this.signalLink.getEstimatedFlightUT();
        
        if (flightTimeNow > 0 && this.sync.queue.length > 0) {
            const currentDelay = this.signalLink.latestNetworkDelay;
            const delayedTimecode = flightTimeNow - currentDelay;

            const readyPackets = this.sync.popReady(delayedTimecode);
            
            if (readyPackets.length > 0) {
                this.playPackets(readyPackets);
            }
        }

        requestAnimationFrame(() => this.playbackLoop());
    }

    async playPackets(packets) {
        if (!this.audioCtx) return;
        if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();

        // Stitch together multiple packets if they arrived at once
        let totalLength = 0;
        packets.forEach(p => totalLength += p.payload.samples.length);
        
        if (totalLength === 0) return;

        const buffer = this.audioCtx.createBuffer(1, totalLength, 22050);
        const channelData = buffer.getChannelData(0);
        
        let offset = 0;
        packets.forEach(p => {
            channelData.set(p.payload.samples, offset);
            offset += p.payload.samples.length;
        });

        const source = this.audioCtx.createBufferSource();
        source.buffer = buffer;
        
        // Simple gain node for basic volume control
        const gainNode = this.audioCtx.createGain();
        
        // Signal quality effect: Add noise if signal is low
        // (The server already adds noise, but we can do further UI feedback if needed)
        gainNode.gain.value = 0.8; 

        source.connect(gainNode);
        gainNode.connect(this.audioCtx.destination);
        source.start();
    }
}

if (typeof window !== 'undefined') {
    window.RadioReceiver = RadioReceiver;
}
