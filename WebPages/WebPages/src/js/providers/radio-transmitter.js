/**
 * Isolated Component (Composition Pattern)
 * Responsible entirely for managing microphone input and resampling to 22050Hz.
 * It exposes startTransmission/stopTransmission for the UI to use, completely
 * decoupling the DOM from the Data.
 */
class RadioTransmitter {
    constructor(signalLink, audioCtx) {
        this.signalLink = signalLink;
        this.audioCtx = audioCtx;
        this.micStream = null;
        this.micProcessor = null;
        this.isTransmitting = false;
    }

    async startTransmission() {
        if (!this.signalLink || !this.signalLink.ws || this.signalLink.ws.readyState !== WebSocket.OPEN) return;
        if (this.isTransmitting) return; 

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error("HTTPS REQ.");
        }

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
            this.micProcessor = this.audioCtx.createScriptProcessor(4096, 1, 1);

            const targetSampleRate = 22050;
            const inputSampleRate = this.audioCtx.sampleRate;
            const resampleRatio = inputSampleRate / targetSampleRate;

            source.connect(this.micProcessor);
            this.micProcessor.connect(this.audioCtx.destination);

            this.micProcessor.onaudioprocess = (e) => {
                if (!this.isTransmitting) return;
                
                const inputData = e.inputBuffer.getChannelData(0);
                let pcm;

                // Software resampling (Linear Interpolation)
                if (Math.abs(resampleRatio - 1) < 0.01) {
                    pcm = new Int16Array(inputData.length);
                    for (let i = 0; i < inputData.length; i++) {
                        const s = Math.max(-1, Math.min(1, inputData[i]));
                        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                    }
                } else {
                    const outputLength = Math.floor(inputData.length / resampleRatio);
                    pcm = new Int16Array(outputLength);
                    for (let i = 0; i < outputLength; i++) {
                        const sourceIndex = i * resampleRatio;
                        const index0 = Math.floor(sourceIndex);
                        const index1 = Math.min(index0 + 1, inputData.length - 1);
                        const frac = sourceIndex - index0;
                        
                        const s0 = inputData[index0];
                        const s1 = inputData[index1];
                        const s = s0 + (s1 - s0) * frac;
                        
                        const clamped = Math.max(-1, Math.min(1, s));
                        pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
                    }
                }

                // Push to the Unified Uplink Queue 
                // The Synchronizer will handle delaying it by N seconds 
                // before dropping it on the wire.
                this.signalLink.queueUplink(PacketType.AUDIO_UPLINK, new Uint8Array(pcm.buffer));
            };
        } catch (err) {
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
        
        if (this.audioCtx) {
            this.audioCtx.close().catch(() => {});
        }
        
        this.micProcessor = null;
        this.micStream = null;
        this.audioCtx = null;
    }
}

if (typeof window !== 'undefined') {
    window.RadioTransmitter = RadioTransmitter;
}
