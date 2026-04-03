/**
 * Shared Radio DSP Logic (v17.0)
 * Centralized algorithms for audio degradation.
 */
export class RadioDSP {
    constructor(isTransmitter = false) {
        this.lpPrev = 0;
        this.isTransmitter = isTransmitter;
        this.staticHissLevel = isTransmitter ? 0.0 : 0.012; // v17.2: Reduced for comfort
    }

    apply(s, q) {
        // 1. Noise Injection (Non-linear white noise)
        const noiseScale = Math.pow(1.0 - q, 2.5); // v17.2: Steeper decline
        const whiteNoise = (Math.random() * 2 - 1) * (this.isTransmitter ? 0.12 : 0.18) * noiseScale;
        
        // 2. Bandwidth Limiting (Simple Low Pass)
        const alpha = Math.min(1.0, (this.isTransmitter ? 0.1 : 0.05) + q * 0.9);
        this.lpPrev = alpha * s + (1 - alpha) * this.lpPrev;
        s = this.lpPrev;

        // 3. Bit-Crushing (Quantization)
        const threshold = this.isTransmitter ? 0.7 : 0.6;
        if (q < threshold) {
            const bits = Math.max(3, (this.isTransmitter ? 4 : 3) + (q * 12));
            const steps = Math.pow(2, bits);
            s = Math.round(s * steps) / steps;
        }

        // 4. Mix
        const dryLevel = Math.max(0, q * 1.1 - 0.1);
        const hissScale = Math.pow(1.0 - q, 1.2); // v17.3: Hiss now goes to ZERO at 100% quality
        const hiss = (Math.random() * 2 - 1) * this.staticHissLevel * hissScale;
        
        return (s * dryLevel) + whiteNoise + hiss;
    }

    reset() {
        this.lpPrev = 0;
    }
}
