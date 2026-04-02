/**
 * Isolated Component (Composition Pattern)
 * Responsible entirely for managing microphone input and resampling.
 * Includes v14.5 Math/Physics Fixes.
 */

// --- CONFIGURATION CONSTANTS (v14.5) ---
const MIC_TARGET_SAMPLE_RATE = 22050; // KSP Audio Loop target frequency
const BROWSER_AUDIO_CHUNK_SIZE = 1024; // 1024 samples = ~21.3ms at 48000Hz (Smoother flow, no 85ms bursts)
const UPLINK_PACKET_SIZE = 1024; // Samples per WebSocket uncompressed packet
const DIAGNOSTIC_PACKET_LOG_INTERVAL = 50; // Log frequency

class RadioTransmitter {
    constructor(signalLink, audioCtx) {
        this.signalLink = signalLink;
        this.audioCtx = audioCtx;
        this.micStream = null;
        this.micProcessor = null;
        this.isTransmitting = false;
        
        // --- ACCUMULATOR STATE ---
        this.accumulator = new Int16Array(UPLINK_PACKET_SIZE);
        this.accPtr = 0;
        this.resamplePhase = 0;

        // --- DIAGNOSTICS (v14.6) ---
        this._sentPackets = 0;
        this._lastPacketTime = performance.now();
        this._intervalSum = 0;
        this.lastSample = 0; // Phase matching state
        console.log("[Radio-v14.6] Transmitter Initialized");
    }

    async startTransmission() {
        if (!this.signalLink || !this.signalLink.ws || this.signalLink.ws.readyState !== WebSocket.OPEN) return;
        if (this.isTransmitting) return; 

        try {
            this.isTransmitting = true;

            if (this.audioCtx.state === 'suspended') {
                await this.audioCtx.resume();
            }

            const constraints = { 
                audio: { 
                    echoCancellation: true, 
                    noiseSuppression: true, 
                    autoGainControl: true 
                } 
            };
            
            this.micStream = await navigator.mediaDevices.getUserMedia(constraints);
            const source = this.audioCtx.createMediaStreamSource(this.micStream);
            this.micProcessor = this.audioCtx.createScriptProcessor(BROWSER_AUDIO_CHUNK_SIZE, 1, 1);

            const inputSampleRate = this.audioCtx.sampleRate;
            this.resamplePhase = 0; 
            this._lastPacketTime = performance.now();

            source.connect(this.micProcessor);
            this.micProcessor.connect(this.audioCtx.destination);

            // Compute packet interval target mathematically for diagnostics
            const targetPacketIntervalMs = (UPLINK_PACKET_SIZE / MIC_TARGET_SAMPLE_RATE) * 1000;

            this.micProcessor.onaudioprocess = (e) => {
                if (!this.isTransmitting) return;
                
                const inputData = e.inputBuffer.getChannelData(0);
                const ratio = this.audioCtx.sampleRate / MIC_TARGET_SAMPLE_RATE;
                
                let currentIdx = this.resamplePhase;

                while (currentIdx < inputData.length - 1) {
                    const i0 = Math.floor(currentIdx);
                    const i1 = i0 + 1;
                    const frac = currentIdx - i0;
                    
                    const s0 = i0 < 0 ? this.lastSample : inputData[i0];
                    const s1 = inputData[i1]; // Safe because i0 is at least -1, so i1 >= 0
                    
                    const s = s0 + (s1 - s0) * frac;
                    const clamped = Math.max(-1, Math.min(1, s));
                    
                    this.accumulator[this.accPtr] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
                    this.accPtr++;

                    if (this.accPtr >= this.accumulator.length) {
                        const snapshot = new Uint8Array(this.accumulator.buffer.slice(0));
                        this.signalLink.queueUplink(PacketType.AUDIO_UPLINK, snapshot);
                        this.accPtr = 0;

                        // Precise Telemetry
                        this._sentPackets++;
                        const now = performance.now();
                        const interval = now - this._lastPacketTime;
                        this._intervalSum += interval;
                        this._lastPacketTime = now;

                        if (this._sentPackets >= DIAGNOSTIC_PACKET_LOG_INTERVAL) {
                            const avg = this._intervalSum / this._sentPackets;
                            console.log(`[Radio-v14.6] UPLINK Transmit: Avg Interval = ${avg.toFixed(2)}ms (Target: ${targetPacketIntervalMs.toFixed(2)}ms)`);
                            this._sentPackets = 0;
                            this._intervalSum = 0;
                        }
                    }

                    currentIdx += ratio;
                }
                
                this.resamplePhase = currentIdx - inputData.length;
                this.lastSample = inputData[inputData.length - 1]; // Store real last sample for next block interpolation
            };
        } catch (err) {
            console.error("[Radio-v14.6] Transmission Error:", err);
            this.stopTransmission();
            throw err;
        }
    }

    stopTransmission() {
        this.isTransmitting = false;
        
        if (this.micProcessor) {
            this.micProcessor.onaudioprocess = null;
            this.micProcessor.disconnect();
        }
        
        if (this.micStream) {
            this.micStream.getTracks().forEach(t => t.stop());
        }
        
        this.micProcessor = null;
        this.micStream = null;
    }
}

if (typeof window !== 'undefined') {
    window.RadioTransmitter = RadioTransmitter;
}
