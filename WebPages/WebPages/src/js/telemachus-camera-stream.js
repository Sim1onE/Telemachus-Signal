/**
 * TelemachusCameraStream (WebSocket Edition)
 * 
 * Reusable utility to decode binary WebSocket streams from Telemachus,
 * intercept frame metadata (UT, Warp, Delay, FOV, Quality), and buffer playback.
 * 
 * Carbon copy of the original MJPEG logic, adapted for high-performance binary transport.
 */
class TelemachusCameraStream {
    /**
     * @param {string} streamUrl - The URL (ws://) to the /stream endpoint
     * @param {string} cameraName - The name of the sensor to subscribe to
     * @param {HTMLImageElement|HTMLCanvasElement} displayElement - Target element
     * @param {Object} datalink - Object providing `.get('t.universalTime')`
     */
    constructor(streamUrl, cameraName, displayElement, datalink) {
        this.streamUrl = streamUrl;
        this.cameraName = cameraName;
        this.displayElement = displayElement;
        this.datalink = datalink;

        this.isCanvas = displayElement instanceof HTMLCanvasElement;
        if (this.isCanvas) {
            this.ctx = displayElement.getContext('2d');
        }

        this.frameBuffer = []; // Queue of { bitmap: ImageBitmap, ut: float, ... }
        this.isRunning = false;
        this.ws = null;

        // Intercettazione istantanea (Network Layer)
        this.latestNetworkDelay = 0;
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.connectWebSocket();
        this.playbackLoop();
    }

    stop() {
        this.isRunning = false;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.cleanupBuffer();
    }

    cleanupBuffer() {
        this.frameBuffer.forEach(f => {
            if (f.url) URL.revokeObjectURL(f.url);
            if (f.bitmap && f.bitmap.close) f.bitmap.close();
        });
        this.frameBuffer = [];
    }

    connectWebSocket() {
        this.ws = new WebSocket(this.streamUrl);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            console.log("Stream: Connected. Subscribing to:", this.cameraName);
            this.ws.send(JSON.stringify({ camera: this.cameraName }));
        };

        this.ws.onmessage = async (e) => {
            if (!this.isRunning) return;

            const view = new DataView(e.data);
            const type = view.getUint8(0);

            if (type === 0) { // Video/Metadata Packet
                const kspUT = view.getFloat64(1, true);
                const kspWarp = view.getFloat64(9, true);
                const kspDelay = view.getFloat64(17, true);
                const kspFOV = view.getFloat64(25, true);
                const kspSignal = view.getUint8(33);

                // Intercettazione istantanea del delay (Network layer)
                this.latestNetworkDelay = kspDelay;

                // Decode Image
                const jpgBytes = new Uint8Array(e.data, 34);
                const blob = new Blob([jpgBytes], { type: 'image/jpeg' });

                try {
                    const bitmap = await createImageBitmap(blob);
                    this.frameBuffer.push({
                        bitmap: bitmap,
                        ut: kspUT,
                        warp: kspWarp,
                        delay: kspDelay,
                        fov: kspFOV,
                        signal: kspSignal
                    });
                } catch (err) {
                    console.error("Frame decoding failed", err);
                }
            }
        };

        this.ws.onclose = () => {
            if (this.isRunning) {
                console.warn("Stream connection lost, retrying in 2s...");
                setTimeout(() => { if (this.isRunning) this.connectWebSocket(); }, 2000);
            }
        };
    }

    sendCameraCommand(cmd) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(cmd));
        }
    }

    playbackLoop() {
        if (!this.isRunning) return;

        if (this.datalink && this.frameBuffer.length > 0) {
            // Logica originale: Calcolo del Delayed Timecode basato sull'UT reale del Datalink
            const universalTime = this.datalink.get ? this.datalink.get('t.universalTime') : Date.now();
            const currentDelay = this.latestNetworkDelay;
            const delayedTimecode = universalTime - currentDelay;

            let frameToDraw = null;
            let framesPoppedThisTick = 0;

            // --- DYNAMIC BURST CATCH-UP (Original Logic) ---
            while (this.frameBuffer.length > 0 && this.frameBuffer[0].ut <= delayedTimecode && framesPoppedThisTick < 10) {
                if (frameToDraw) {
                    if (frameToDraw.url) URL.revokeObjectURL(frameToDraw.url);
                    if (frameToDraw.bitmap && frameToDraw.bitmap.close) frameToDraw.bitmap.close();
                }
                frameToDraw = this.frameBuffer.shift();
                framesPoppedThisTick++;

                // Se siamo già "in orario", fermiamo il burst
                if (frameToDraw.ut > (delayedTimecode - 0.05)) break;
            }

            if (frameToDraw) {
                // Sincronizzazione metadati nel momento del DISEGNO
                if (frameToDraw.ut && this.datalink.syncFromStream) {
                    this.datalink.syncFromStream(
                        frameToDraw.ut,
                        frameToDraw.warp,
                        frameToDraw.delay,
                        frameToDraw.fov,
                        frameToDraw.signal
                    );
                }

                if (this.isCanvas) {
                    if (frameToDraw.bitmap) {
                        if (this.displayElement.width !== frameToDraw.bitmap.width || this.displayElement.height !== frameToDraw.bitmap.height) {
                            this.displayElement.width = frameToDraw.bitmap.width;
                            this.displayElement.height = frameToDraw.bitmap.height;
                        }
                        this.ctx.drawImage(frameToDraw.bitmap, 0, 0);
                        frameToDraw.bitmap.close();
                    }
                } else {
                    // Fallback img tag
                    if (frameToDraw.url) {
                        const oldUrl = this.displayElement.src;
                        this.displayElement.src = frameToDraw.url;
                        if (oldUrl.startsWith('blob:')) {
                            setTimeout(() => URL.revokeObjectURL(oldUrl), 100);
                        }
                    }
                }
            }
        }

        requestAnimationFrame(() => this.playbackLoop());
    }
}

if (typeof window !== 'undefined') {
    window.TelemachusCameraStream = TelemachusCameraStream;
}
