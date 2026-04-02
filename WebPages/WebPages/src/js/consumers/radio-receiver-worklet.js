/**
 * Radio Downstream Worklet (v14.17)
 * Isolated Audio Thread for High-Fidelity Downlink Playback.
 * Handles Ring Buffer management, Resampling, and Crossfading.
 */
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

        this.port.onmessage = (e) => {
            const msg = e.data;
            if (msg.type === 'push-samples') {
                const samples = msg.payload;
                for (let i = 0; i < samples.length; i++) {
                    this.ringBuffer[this.writePtr] = samples[i];
                    this.writePtr = (this.writePtr + 1) % this.ringBuffer.length;
                }
            } else if (msg.type === 'set-sync') {
                this.adaptiveRatio = msg.ratio;
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
            }
        };
    }

    process(inputs, outputs, parameters) {
        const output = outputs[0][0];
        if (!output) return true;

        const bufSize = this.ringBuffer.length;
        const radioRate = 22050;
        const hardwareRate = sampleRate;
        const baseRatio = radioRate / hardwareRate;
        const finalRatio = baseRatio * this.adaptiveRatio;

        const TARGET_RESERVOIR_S = 0.200;

        // Monitor for stall
        if (this.writePtr === this.lastWritePtr) {
            this.stagnantCycles += output.length;
        } else {
            this.stagnantCycles = 0;
            this.lastWritePtr = this.writePtr;
        }

        for (let i = 0; i < output.length; i++) {
            let dist = (this.writePtr >= this.readPtr) ? (this.writePtr - this.readPtr) : (bufSize - this.readPtr + this.writePtr);
            const currentReservoirS = dist / radioRate;

            // Buffering Logic
            if (this.isBuffering) {
                // If we have enough cushion OR the server has clearly stopped but we still have a tiny bit of audio
                const hasEnoughCushion = currentReservoirS > TARGET_RESERVOIR_S;
                const forceFlush = this.stagnantCycles > hardwareRate * 0.1 && dist > 5;
                if (hasEnoughCushion || forceFlush) {
                    this.isBuffering = false;
                }
            } else {
                if (dist < 2) {
                    this.isBuffering = true;
                }
            }

            const targetGain = this.isBuffering ? 0.0 : 1.0;
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

        // Periodic Telemetry
        if (Math.random() < 0.02) {
            let dist = (this.writePtr >= this.readPtr) ? (this.writePtr - this.readPtr) : (bufSize - this.readPtr + this.writePtr);
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
