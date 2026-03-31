class TelemachusRadio {
    constructor(host) {
        this.host = host || window.location.host;
        this.ws = null;
        this.audioCtx = null;
        this.stream = null;
        this.processor = null;
        this.isConnected = false;
        this.sampleRate = 22050; // Must match server
    }

    async connect() {
        return new Promise((resolve, reject) => {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            this.ws = new WebSocket(`${protocol}//${this.host}/audio`);
            this.ws.binaryType = 'arraybuffer';

            this.ws.onopen = () => {
                this.isConnected = true;
                console.log("Radio Uplink Connected");
                resolve();
            };

            this.ws.onerror = (err) => {
                console.error("Radio Connection Error", err);
                reject(err);
            };

            this.ws.onclose = () => {
                this.isConnected = false;
                console.log("Radio Uplink Disconnected");
                this.stopMic();
            };
        });
    }

    async startMic() {
        if (!this.isConnected) await this.connect();

        try {
            this.stream = await navigator.mediaDevices.getUserMedia({ audio: {
                sampleRate: this.sampleRate,
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true
            }});

            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: this.sampleRate
            });

            const source = this.audioCtx.createMediaStreamSource(this.stream);
            
            // ScriptProcessor handles 4096 samples per chunk (~185ms)
            // Smaller values like 2048 or 1024 reduce latency but might glitch
            this.processor = this.audioCtx.createScriptProcessor(2048, 1, 1);

            source.connect(this.processor);
            this.processor.connect(this.audioCtx.destination);

            this.processor.onaudioprocess = (e) => {
                if (!this.isConnected) return;

                const inputData = e.inputBuffer.getChannelData(0);
                const pcmData = new Int16Array(inputData.length);

                // Convert Float32 (-1.0 to 1.0) to PCM 16-bit
                for (let i = 0; i < inputData.length; i++) {
                    const s = Math.max(-1, Math.min(1, inputData[i]));
                    pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }

                // Send raw binary to KSP
                this.ws.send(pcmData.buffer);
            };

            console.log("Microphone Active - Streaming to KSP");
        } catch (err) {
            console.error("Error capturing microphone", err);
        }
    }

    stopMic() {
        if (this.processor) this.processor.disconnect();
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
        }
        if (this.audioCtx) this.audioCtx.close();
        
        this.processor = null;
        this.stream = null;
        this.audioCtx = null;
        console.log("Microphone Stopped");
    }
}
