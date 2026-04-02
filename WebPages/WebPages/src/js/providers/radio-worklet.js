/**
 * Radio Upstream Worklet (v14.22)
 * Handles Microphone capture, Resampling to 22050Hz, and Packetizing.
 * 
 * v14.22: Added Cold-Start Phase Reset and 10ms Soft Fade-in to prevent 
 *         PTT-start clicks and DC-offset 'thumps'.
 */
class RadioUpstreamWorklet extends AudioWorkletProcessor {
    constructor() {
        super();
        this.MIC_TARGET_SAMPLE_RATE = 22050;
        this.UPLINK_PACKET_SIZE = 1024;

        this.accumulator = new Int16Array(this.UPLINK_PACKET_SIZE);
        this.accPtr = 0;
        
        this.resamplePhase = 0;
        this.lastSample = 0;
        this.baseSampleRate = 48000; // Expected default
        this.ratio = 48000 / this.MIC_TARGET_SAMPLE_RATE;
        this.isFirstBlock = true;
        this.currentGain = 0.0; // Soft Fade-in for Cold Start

        this.port.onmessage = (e) => {
            if (e.data.ratio) {
                this.ratio = e.data.ratio;
            }
        };
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || input.length === 0) return true;
        
        const inputData = input[0]; 
        if (!inputData) return true;

        // v14.22 Cold Start Fix: Reset resampler phase on first block
        if (this.isFirstBlock) {
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
            
            // v14.22: Apply tiny 10ms fade-in to mask DC-offset jump at start of mic opening
            this.currentGain = Math.min(1.0, this.currentGain + (1.0 / (this.MIC_TARGET_SAMPLE_RATE * 0.010))); // 10ms fade
            s *= this.currentGain;

            const clamped = Math.max(-1, Math.min(1, s));
            
            this.accumulator[this.accPtr] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
            this.accPtr++;

            if (this.accPtr >= this.accumulator.length) {
                const snapshot = new Uint8Array(this.accumulator.buffer.slice(0));
                this.port.postMessage({ type: 'audio-packet', payload: snapshot }, [snapshot.buffer]);
                this.accPtr = 0;
            }

            currentIdx += this.ratio;
        }
        
        this.resamplePhase = currentIdx - inputData.length;
        this.lastSample = inputData[inputData.length - 1]; 

        return true; 
    }
}

registerProcessor('radio-upstream-worklet', RadioUpstreamWorklet);
