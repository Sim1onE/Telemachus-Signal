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

        this.port.onmessage = (e) => {
            if (e.data.ratio) {
                this.ratio = e.data.ratio;
            }
        };
    }

    // Receive metadata from main thread
    static get parameterDescriptors() {
        return [];
    }

    process(inputs, outputs, parameters) {
        // We only care about the first input and its first channel (mono mic)
        const input = inputs[0];
        if (!input || input.length === 0) return true;
        
        const inputData = input[0]; 
        if (!inputData) return true;

        let currentIdx = this.resamplePhase;

        while (currentIdx < inputData.length - 1) {
            const i0 = Math.floor(currentIdx);
            const i1 = i0 + 1;
            const frac = currentIdx - i0;
            
            const s0 = i0 < 0 ? this.lastSample : inputData[i0];
            const s1 = inputData[i1]; 
            
            const s = s0 + (s1 - s0) * frac;
            const clamped = Math.max(-1, Math.min(1, s));
            
            this.accumulator[this.accPtr] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
            this.accPtr++;

            if (this.accPtr >= this.accumulator.length) {
                // Send fully packed 1024-sample packet back to main thread
                // We slice it to ensure we send a copy across the thread barrier
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
