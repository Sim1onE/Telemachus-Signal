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
        this.isMuted = true; // Default to muted for Autoplay safety
        
        // --- RING BUFFER STATE ---
        this.workletInitted = false;
        this.micProcessor = null;
        this.reservoirStatusMs = 0;
        this.isBuffering = true;

        this.playbackInterval = null;
        this.signalLink.on(PacketType.AUDIO_DOWNLINK, this.handleIncomingAudio.bind(this));
        
        // v14.31: Mobile-Enhanced Autoplay Fix.
        const resume = async () => {
            if (this.audioCtx.state === 'suspended') {
                await this.audioCtx.resume();
                // Play a micro-sound to 'wake up' the audio hardware on iOS
                const osc = this.audioCtx.createOscillator();
                const gain = this.audioCtx.createGain();
                gain.gain.value = 0.001; 
                osc.connect(gain);
                gain.connect(this.audioCtx.destination);
                osc.start(0);
                osc.stop(this.audioCtx.currentTime + 0.01);
            }
            ['click', 'keydown', 'touchstart', 'touchend', 'mousedown'].forEach(e => 
                document.removeEventListener(e, resume));
        };
        ['click', 'keydown', 'touchstart', 'touchend', 'mousedown'].forEach(e => 
            document.addEventListener(e, resume));

        console.log("[Radio-v14.31] Receiver Initialized (Mobile-Ready)");
    }

    async start() {
        if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
        
        this.isRunning = true;
        
        // --- v14.17: AUDIO WORKLET IMPLEMENTATION (Zero Jitter Downlink) ---
        if (!this.workletInitted) {
            await this.audioCtx.audioWorklet.addModule('../js/consumers/radio-receiver-worklet.js');
            this.workletInitted = true;
        }

        this.processor = new AudioWorkletNode(this.audioCtx, 'radio-downstream-worklet');
        this.processor.connect(this.audioCtx.destination);

        this.processor.port.onmessage = (e) => {
            if (e.data.type === 'telemetry') {
                this.reservoirStatusMs = e.data.reservoirMs;
                this.isBuffering = e.data.isBuffering;
                this._adaptiveRatio = e.data.ratio;
            } else if (e.data.type === 'click-detected') {
                console.warn(`[Radio-Diag v14.19] ⚠️ DOWNLINK CLICK DETECTED! Phase Jump: ${e.data.delta.toFixed(2)}V`);
            }
        };

        // v14.19: Use high-frequency interval instead of requestAnimationFrame
        // to decouple audio from rendering frame rate/lag.
        if (this.playbackInterval) clearInterval(this.playbackInterval);
        this.playbackInterval = setInterval(() => this.playbackLoop(), 20);
    }

    setMuted(isMuted) {
        this.isMuted = isMuted;
        if (this.processor) {
            this.processor.port.postMessage({
                type: 'set-mute',
                payload: isMuted
            });
        }
        
        // v14.32: Play feedback sound when unmuting (also helps wake up Mobile Audio)
        if (!isMuted) {
            this.playActivationSound();
        }
    }

    playActivationSound() {
        if (!this.audioCtx) return;
        const now = this.audioCtx.currentTime;
        
        // Professional NASA 'Quindar' tone (Intro style)
        // 250ms at 2525Hz
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(2525, now);
        
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.2, now + 0.005);
        gain.gain.setValueAtTime(0.2, now + 0.150);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.200);
        
        osc.connect(gain);
        gain.connect(this.audioCtx.destination);
        
        osc.start(now);
        osc.stop(now + 0.25);
    }

    stop() {
        this.isRunning = false;
        if (this.playbackInterval) {
            clearInterval(this.playbackInterval);
            this.playbackInterval = null;
        }
        this.sync.clear();
        if (this.processor) {
            this.processor.disconnect();
            this.processor = null;
        }
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
                // Push ready samples into the Worklet Ring Buffer
                readyPackets.forEach(p => {
                    if (!p.payload || !p.payload.samples) return;
                    this.processor.port.postMessage({
                        type: 'push-samples',
                        payload: p.payload.samples
                    });

                    // Diagnostics Update
                    this._packetCount++;
                    this._creationUT = p.ut;
                });
                
                const now = Date.now();
                if (now - this._lastLogTime > 2000) {
                    console.log(`[Radio-Diag v14.19] DOWNLINK (Worklet): Sync=${this._adaptiveRatio ? this._adaptiveRatio.toFixed(3) : 1}x Buffering=${this.isBuffering} Reservoir=${this.reservoirStatusMs.toFixed(1)}ms Packets=${this._packetCount}`);
                    this._packetCount = 0;
                    this._lastLogTime = now;
                }
                
                // CATCH-UP LOGIC:
                const tooFarAhead = this.reservoirStatusMs > 660; 
                if (tooFarAhead) { 
                    this.processor.port.postMessage({ type: 'force-snap', readPtr: -1 }); 
                    console.warn(`[Radio-Diag v14.19] Buffer overflow snap triggered. Reservoir was ${this.reservoirStatusMs.toFixed(1)}ms. Volume ducked to crossfade.`);
                }
            }
        }
    }
}

if (typeof window !== 'undefined') {
    window.RadioReceiver = RadioReceiver;
}
