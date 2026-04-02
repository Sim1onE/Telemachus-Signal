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
        this.micSource = null;
        this.micProcessor = null;
        this.isTransmitting = false;
        this.workletInitted = false;
        
        // --- DIAGNOSTICS (v14.16 - Lifecycle Fix) ---
        this._sentPackets = 0;
        this._lastPacketTime = performance.now();
        this._intervalSum = 0;
        console.log("[Radio-v14.16] Transmitter Initialized");
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

            // --- v14.16: AUDIO WORKLET IMPLEMENTATION (Zero Jitter + Lifecycle Fix) ---
            if (!this.workletInitted) {
                await this.audioCtx.audioWorklet.addModule('../js/providers/radio-worklet.js');
                this.workletInitted = true;
            }

            this.micProcessor = new AudioWorkletNode(this.audioCtx, 'radio-upstream-worklet');
            
            // Set Dynamic Ratio for Resampling
            this.micProcessor.port.postMessage({ ratio: this.audioCtx.sampleRate / MIC_TARGET_SAMPLE_RATE });

            this.micSource = this.audioCtx.createMediaStreamSource(this.micStream);
            this.micSource.connect(this.micProcessor);
            this.micProcessor.connect(this.audioCtx.destination);

            const targetPacketIntervalMs = (UPLINK_PACKET_SIZE / MIC_TARGET_SAMPLE_RATE) * 1000;
            this._lastPacketTime = performance.now();

            this.micProcessor.port.onmessage = (e) => {
                if (!this.isTransmitting) return;

                if (e.data.type === 'audio-packet') {
                    // Send Binary Audio Snapshot via Websocket Ring
                    this.signalLink.queueUplink(PacketType.AUDIO_UPLINK, e.data.payload);

                    // Precise Telemetry
                    this._sentPackets++;
                    const now = performance.now();
                    const interval = now - this._lastPacketTime;
                    this._intervalSum += interval;
                    this._lastPacketTime = now;

                    if (this._sentPackets >= DIAGNOSTIC_PACKET_LOG_INTERVAL) {
                        const avg = this._intervalSum / this._sentPackets;
                        console.log(`[Radio-v14.16] UPLINK Transmit (Worklet): Avg Interval = ${avg.toFixed(2)}ms (Target: ${targetPacketIntervalMs.toFixed(2)}ms)`);
                        this._sentPackets = 0;
                        this._intervalSum = 0;
                    }
                }
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
            this.micProcessor.port.onmessage = null; // v14.16: Explicitly kill the listener!
            this.micProcessor.disconnect();
        }

        if (this.micSource) {
            this.micSource.disconnect();
        }
        
        if (this.micStream) {
            this.micStream.getTracks().forEach(t => t.stop());
        }
        
        this.micSource = null;
        this.micProcessor = null;
        this.micStream = null;
    }
}

if (typeof window !== 'undefined') {
    window.RadioTransmitter = RadioTransmitter;
}
