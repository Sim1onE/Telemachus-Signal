/**
 * Radio Upstream Worklet (v14.23)
 * Handles Microphone capture, Resampling to 22050Hz, and Packetizing.
 * 
 * v14.23: Added 'Warm Mic' support with Internal Gating.
 *         The worklet now handles PTT via 'set-mute' messages.
 *         When muted, it continues to 'consume' audio to keep Browser AGC stable
 *         but discards all packets and resets resampler phase.
 */
import { RadioDSP } from '../shared/radio-dsp.js';

class RadioUpstreamWorklet extends AudioWorkletProcessor {
    constructor() {
        super();
        this.MIC_TARGET_SAMPLE_RATE = 22050;
        this.UPLINK_PACKET_SIZE = 1024;

        this.accumulator = new Int16Array(this.UPLINK_PACKET_SIZE);
        this.accPtr = 0;
        
        this.resamplePhase = 0;
        this.lastSample = 0;
        this.ratio = 48000 / this.MIC_TARGET_SAMPLE_RATE;
        
        this.isFirstBlock = true;
        this.currentGain = 0.0;
        this.muted = true; // Gated by default (v14.23)
        
        // --- v17.1 Shared DSP ---
        this.dsp = new RadioDSP(true);
        this.quality = 1.0;

        this.port.onmessage = (e) => {
            if (e.data.type === 'init') {
                this.ratio = e.data.ratio;
            }
            if (e.data.type === 'set-mute') {
                this.muted = e.data.muted;
                if (this.muted) {
                    // Reset internal resampler state when stopping to ensure next burst is clean
                    this.isFirstBlock = true;
                    this.currentGain = 0.0;
                    this.accPtr = 0;
                    this.dsp.reset();
                }
            }
            if (e.data.type === 'set-quality') {
                this.quality = e.data.quality;
            }
        };
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || input.length === 0) return true;
        
        const inputData = input[0]; 
        if (!inputData) return true;

        // v14.22 Cold Start Fix: Reset resampler phase on first block of a burst
        if (this.isFirstBlock && !this.muted) {
            this.resamplePhase = 0;
            this.lastSample = inputData[0];
            this.isFirstBlock = false;
        }

        let currentIdx = this.resamplePhase;

        while (currentIdx < inputData.length - 1) {
            const i0 = Math.floor(currentIdx);
            const i1 = i0 + 1;
            const frac = currentIdx - i0;
            
            const s0 = i0 < 0 ? this.lastSample : inputData[i0];
            const s1 = inputData[i1]; 
            
            let s = s0 + (s1 - s0) * frac;
            
            if (this.muted) {
                // Keep consuming samples to maintain resampler sync/timing but don't output anything.
                // Resetting accPtr here ensures no leaked audio.
                this.accPtr = 0;
            } else {
                this.currentGain = Math.min(1.0, this.currentGain + (1.0 / (this.MIC_TARGET_SAMPLE_RATE * 0.010))); // 10ms fade
                s *= this.currentGain;

                // --- Shared DSP Degradation ---
                s = this.dsp.apply(s, this.quality);

                const clamped = Math.max(-1, Math.min(1, s));
                this.accumulator[this.accPtr] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
                this.accPtr++;

                if (this.accPtr >= this.accumulator.length) {
                    const snapshot = new Uint8Array(this.accumulator.buffer.slice(0));
                    this.port.postMessage({ type: 'audio-packet', payload: snapshot }, [snapshot.buffer]);
                    this._sentPackets++;
                    this.accPtr = 0;
                }
            }

            currentIdx += this.ratio;
        }
        
        this.resamplePhase = currentIdx - inputData.length;
        this.lastSample = inputData[inputData.length - 1]; 

        return true; 
    }
}

registerProcessor('radio-upstream-worklet', RadioUpstreamWorklet);
