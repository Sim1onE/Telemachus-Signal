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
        
        // v14.23: Warm Mic Logic. Initialize hardware once and keep it alive 
        // to prevent OS/Browser AGC recalibration issues during fast PTT toggling.
        if (!this.micSource) {
            await this.initMic();
        }

        if (this.isTransmitting) return; 
        this.isTransmitting = true;
        
        if (this.micProcessor) {
            this.micProcessor.port.postMessage({ type: 'set-mute', muted: false });
        }
    }

    async initMic() {
        try {
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

            if (!this.workletInitted) {
                await this.audioCtx.audioWorklet.addModule('../js/providers/radio-worklet.js');
                this.workletInitted = true;
            }

            this.micProcessor = new AudioWorkletNode(this.audioCtx, 'radio-upstream-worklet');
            this.micProcessor.port.postMessage({ 
                type: 'init', 
                ratio: this.audioCtx.sampleRate / MIC_TARGET_SAMPLE_RATE 
            });

            this.micSource = this.audioCtx.createMediaStreamSource(this.micStream);
            this.micSource.connect(this.micProcessor);
            // Connect to destination at 0 gain just to keep the worklet clock running reliably
            const silentGain = this.audioCtx.createGain();
            silentGain.gain.value = 0;
            this.micProcessor.connect(silentGain);
            silentGain.connect(this.audioCtx.destination);

            this.micProcessor.port.onmessage = (e) => {
                if (e.data.type === 'audio-packet') {
                    if (!this.isTransmitting) return; // Guard
                    this.signalLink.queueUplink(PacketType.AUDIO_UPLINK, e.data.payload);

                    this._sentPackets++;
                    const now = performance.now();
                    const interval = now - this._lastPacketTime;
                    this._intervalSum += interval;
                    this._lastPacketTime = now;

                    if (this._sentPackets >= DIAGNOSTIC_PACKET_LOG_INTERVAL) {
                        const avg = this._intervalSum / this._sentPackets;
                        console.log(`[Radio-v14.23] UPLINK Transmit (Warm): Avg Interval = ${avg.toFixed(2)}ms`);
                        this._sentPackets = 0;
                        this._intervalSum = 0;
                    }
                }
            };
        } catch (err) {
            console.error("[Radio-v14.23] Mic Init Error:", err);
            throw err;
        }
    }

    stopTransmission() {
        this.isTransmitting = false;
        if (this.micProcessor) {
            this.micProcessor.port.postMessage({ type: 'set-mute', muted: true });
        }
    }
}

if (typeof window !== 'undefined') {
    window.RadioTransmitter = RadioTransmitter;
}
