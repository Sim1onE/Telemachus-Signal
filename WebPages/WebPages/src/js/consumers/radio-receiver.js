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
        
        // --- DIAGNOSTICS (v13.0) ---
        this._sentPackets = 0;
        this._lastLogTime = Date.now();
        this._packetCount = 0;
        this._creationUT = 0;
        
        // --- RING BUFFER STATE ---
        // We buffer at the NATIVE RADIO RATE (22050Hz) to save memory
        const radioRate = 22050;
        const bufferSize = radioRate * 5; // 5 seconds of reservoir
        this.ringBuffer = new Float32Array(bufferSize);

        this.writePtr = 0;
        this.readPtr = 0; // This will now be a FLOAT for sub-sample resampling 
        this.processor = null; 
        this.isBuffering = true; // Wait for a cushion before playing
        
        // Anti-Stutter & Flush state
        this.lastWritePtr = -1;
        this.stagnantSamples = 0;

        // Sub to Type 2 (Audio Downlink)
        this.signalLink.on(PacketType.AUDIO_DOWNLINK, this.handleIncomingAudio.bind(this));
    }

    async start() {
        if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
        
        this.isRunning = true;
        
        // Setup the continuous playback processor
        // We use ScriptProcessor for maximum compatibility with the current structure
        this.processor = this.audioCtx.createScriptProcessor(4096, 0, 1);
        this.processor.onaudioprocess = (e) => {
            const output = e.outputBuffer.getChannelData(0);
            if (!this.isRunning) {
                output.fill(0);
                return;
            }

            const radioRate = 22050;
            const hardwareRate = this.audioCtx.sampleRate;
            const ratio = radioRate / hardwareRate; // e.g. 22050 / 48000 = 0.459
            
            const bufSize = this.ringBuffer.length;

            // Check if writer stalled (Transmission ended)
            if (this.writePtr === this.lastWritePtr) {
                this.stagnantSamples += output.length;
            } else {
                this.lastWritePtr = this.writePtr;
                this.stagnantSamples = 0;
            }

            // Smooth Pre-Buffering OR Flush Force
            let dist = (this.writePtr >= this.readPtr) ? (this.writePtr - this.readPtr) : (bufSize - this.readPtr + this.writePtr);
            if (this.isBuffering) {
                const hasEnoughCushion = dist > radioRate * 0.2;
                const forceFlush = this.stagnantSamples > hardwareRate * 0.1 && dist > 5;
                
                if (hasEnoughCushion || forceFlush) {
                    this.isBuffering = false;
                }
            }

            for (let i = 0; i < output.length; i++) {
                dist = (this.writePtr >= this.readPtr) ? (this.writePtr - this.readPtr) : (bufSize - this.readPtr + this.writePtr);
                
                // If we've run dry, stop and build cushion again
                if (dist < 2) {
                    this.isBuffering = true;
                    output[i] = 0;
                } else if (this.isBuffering) {
                    output[i] = 0; // Still cushioning
                } else {
                    const i0 = Math.floor(this.readPtr);
                    const i1 = (i0 + 1) % bufSize;
                    const frac = this.readPtr - i0;

                    const s0 = this.ringBuffer[i0];
                    const s1 = this.ringBuffer[i1];
                    
                    output[i] = s0 + (s1 - s0) * frac;
                    this.readPtr = (this.readPtr + ratio) % bufSize;
                }
            }
        };

        this.processor.connect(this.audioCtx.destination);
        this.playbackLoop();
    }

    stop() {
        this.isRunning = false;
        this.sync.clear();
        if (this.processor) {
            this.processor.disconnect();
            this.processor = null;
        }
        this.ringBuffer.fill(0);
        this.readPtr = 0;
        this.writePtr = 0;
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
                // Push ready samples into the Ring Buffer
                readyPackets.forEach(p => {
                    if (!p.payload || !p.payload.samples) return;
                    
                    const samples = p.payload.samples;
                    for (let i = 0; i < samples.length; i++) {
                        this.ringBuffer[this.writePtr] = samples[i];
                        this.writePtr = (this.writePtr + 1) % this.ringBuffer.length;
                    }

                    // Diagnostics Update
                    this._packetCount++;
                    this._creationUT = p.ut;
                    const now = Date.now();
                    if (now - this._lastLogTime > 2000) {
                        const avail = (this.writePtr - this.readPtr + this.ringBuffer.length) % this.ringBuffer.length;
                        const availMs = (avail / 22050) * 1000;
                        console.log(`[Radio-Diag] DOWNLINK Receiver: Buffering=${this.isBuffering} Reservoir=${availMs.toFixed(1)}ms Packets=${this._packetCount}`);
                        this._packetCount = 0;
                        this._lastLogTime = now;
                    }
                });

                // CATCH-UP LOGIC:
                // If the write head is too far ahead of the read head,
                // we snap the read head forward to maintain a 250ms safety buffer.
                const radioRate = 22050;
                const bufferSize = this.ringBuffer.length;
                const dist = (this.writePtr >= this.readPtr) ? (this.writePtr - this.readPtr) : (bufferSize - this.readPtr + this.writePtr);
                
                // If latency > ~650ms, snap back to 250ms
                if (dist > radioRate / 1.5) { 
                    this.readPtr = (this.writePtr - Math.floor(radioRate * 0.25) + bufferSize) % bufferSize;
                    this.isBuffering = false;
                }
            }
        }

        requestAnimationFrame(() => this.playbackLoop());
    }
}

if (typeof window !== 'undefined') {
    window.RadioReceiver = RadioReceiver;
}
