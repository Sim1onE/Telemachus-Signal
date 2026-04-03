/**
 * Radio Downstream Worklet (v14.19)
 * Isolated Audio Thread for High-Fidelity Downlink Playback.
 * Handles Ring Buffer management, Resampling, Adaptive Sync, and Crossfading.
 * 
 * v14.19: Moved Adaptive P-Controller INSIDE the worklet for instant feedback.
 *         Main thread was too slow/stale with its 2% random telemetry sampling.
 */
import { RadioDSP } from '../shared/radio-dsp.js';

class RadioDownstreamWorklet extends AudioWorkletProcessor {
    constructor() {
        super();
        const radioRate = 22050;
        const bufferSize = radioRate * 5; // 5s reservoir
        this.ringBuffer = new Float32Array(bufferSize);
        this.writePtr = 0;
        this.readPtr = 0;
        this.isBuffering = true;
        this.currentGain = 0.0;
        this.adaptiveRatio = 1.0;
        this.lastOutputSample = 0.0;
        
        // Tracking stall state
        this.stagnantCycles = 0;
        this.lastWritePtr = -1;
        
        // --- v17.1 Shared DSP ---
        this.dsp = new RadioDSP(false);
        this.quality = 1.0;
        
        // Telemetry throttle
        this.telemetryCounter = 0;

        this.port.onmessage = (e) => {
            const msg = e.data;
            if (msg.type === 'push-samples') {
                const samples = msg.payload;
                const q = (msg.quality !== undefined) ? msg.quality : this.quality;
                this.quality = q;

                for (let i = 0; i < samples.length; i++) {
                    const s = this.dsp.apply(samples[i], q);
                    this.ringBuffer[this.writePtr] = s;
                    this.writePtr = (this.writePtr + 1) % this.ringBuffer.length;
                }
            } else if (msg.type === 'force-snap') {
                // Graceful snap: Cut gain instantly and jump pointer
                let targetReadPtr = msg.readPtr;
                if (targetReadPtr === -1) {
                    const radioRate = 22050;
                    targetReadPtr = (this.writePtr - Math.floor(radioRate * 0.25) + this.ringBuffer.length) % this.ringBuffer.length;
                }
                this.readPtr = targetReadPtr;
                this.currentGain = 0.0;
                this.isBuffering = false;
            } else if (msg.type === 'set-mute') {
                this.isApplicationMuted = msg.payload;
            }
        };
        this.isApplicationMuted = true; // Initial state matches RadioReceiver
    }

    process(inputs, outputs, parameters) {
        const output = outputs[0][0];
        if (!output) return true;

        const bufSize = this.ringBuffer.length;
        const radioRate = 22050;
        const hardwareRate = sampleRate;
        const baseRatio = radioRate / hardwareRate;

        const TARGET_RESERVOIR_S = 0.250; // Aligned to user request (250ms) for v14.25 stability tuning

        // Monitor for stall
        if (this.writePtr === this.lastWritePtr) {
            this.stagnantCycles += output.length;
        } else {
            this.stagnantCycles = 0;
            this.lastWritePtr = this.writePtr;
        }

        // --- v14.19: ADAPTIVE P-CONTROLLER (Inside Worklet) ---
        // Compute once per process() block (every 2.67ms at 128 samples/48kHz)
        // This is ~375x more responsive than the old 2% random telemetry from Main Thread.
        let dist = (this.writePtr >= this.readPtr) ? (this.writePtr - this.readPtr) : (bufSize - this.readPtr + this.writePtr);
        const currentReservoirS = dist / radioRate;

        if (!this.isBuffering) {
            const errorS = currentReservoirS - TARGET_RESERVOIR_S;
            this.adaptiveRatio = Math.max(0.95, Math.min(1.05, 1.0 + (errorS * 0.20)));
        }
        
        const finalRatio = baseRatio * this.adaptiveRatio;

        for (let i = 0; i < output.length; i++) {
            dist = (this.writePtr >= this.readPtr) ? (this.writePtr - this.readPtr) : (bufSize - this.readPtr + this.writePtr);

            // Buffering Logic
            if (this.isBuffering) {
                const hasEnoughCushion = (dist / radioRate) > TARGET_RESERVOIR_S;
                const forceFlush = this.stagnantCycles > hardwareRate * 0.1 && dist > 5;
                if (hasEnoughCushion || forceFlush) {
                    this.isBuffering = false;
                }
            } else {
                if (dist < 2) {
                    this.isBuffering = true;
                }
            }

            const targetGain = (this.isBuffering || this.isApplicationMuted) ? 0.0 : 1.0;
            this.currentGain = Math.max(0, Math.min(1, this.currentGain + (targetGain - this.currentGain) * 0.002));

            // Phase matched extraction
            const i0 = Math.floor(this.readPtr);
            const i1 = (i0 + 1) % bufSize;
            const frac = this.readPtr - i0;
            const s0 = this.ringBuffer[i0];
            const s1 = this.ringBuffer[i1];
            
            const sampleValue = (s0 + (s1 - s0) * frac);
            output[i] = sampleValue * this.currentGain;

            // Only advance if data remains
            if (!this.isBuffering) {
                this.readPtr = (this.readPtr + finalRatio) % bufSize;
            }
            
            // Phase Fracture Detection
            const delta = Math.abs(output[i] - this.lastOutputSample);
            if (this.currentGain > 0.9 && delta > 0.4) {
                this.port.postMessage({ type: 'click-detected', delta: delta });
            }

            this.lastOutputSample = output[i];
        }

        // Periodic Telemetry (every ~50 blocks = ~133ms)
        this.telemetryCounter++;
        if (this.telemetryCounter >= 50) {
            this.telemetryCounter = 0;
            dist = (this.writePtr >= this.readPtr) ? (this.writePtr - this.readPtr) : (bufSize - this.readPtr + this.writePtr);
            this.port.postMessage({
                type: 'telemetry',
                reservoirMs: (dist / radioRate) * 1000,
                isBuffering: this.isBuffering,
                ratio: this.adaptiveRatio
            });
        }

        return true;
    }
}

registerProcessor('radio-downstream-worklet', RadioDownstreamWorklet);
