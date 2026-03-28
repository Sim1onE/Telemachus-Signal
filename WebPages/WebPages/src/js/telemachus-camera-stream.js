/**
 * TelemachusCameraStream
 * 
 * Reusable utility to decode MJPEG streams from Telemachus, intercept frame metadata (X-KSP-UT),
 * and buffer playback. Uses Canvas API to avoid "blob avalanche" in network tabs.
 */
class TelemachusCameraStream {
    /**
     * @param {string} streamUrl - The URL to the /telemachus/cameras/stream/ endpoint
     * @param {HTMLImageElement|HTMLCanvasElement} displayElement - The <img> or <canvas> tag to draw the frames to
     * @param {Object} datalink - Object providing `.get('t.universalTime')` and `.get('comm.signalDelay')`
     */
    constructor(streamUrl, displayElement, datalink) {
        this.streamUrl = streamUrl;
        this.displayElement = displayElement;
        this.datalink = datalink;
        
        this.isCanvas = displayElement instanceof HTMLCanvasElement;
        if (this.isCanvas) {
            this.ctx = displayElement.getContext('2d');
        }

        this.frameBuffer = []; // Queue of { data: Blob|ImageBitmap, ut: float }
        this.isRunning = false;
        this.activeFetch = null;
        
        this.chunkParser = {
            buffer: new Uint8Array(0),
            searchingHeader: true,
            currentHeaders: {},
            contentLength: 0
        };
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.connectStream();
        this.playbackLoop();
    }

    stop() {
        this.isRunning = false;
        if (this.activeFetch) {
            this.activeFetch.abort();
            this.activeFetch = null;
        }
        this.cleanupBuffer();
        this.chunkParser.buffer = new Uint8Array(0);
    }

    cleanupBuffer() {
        this.frameBuffer.forEach(f => {
            if (f.url) URL.revokeObjectURL(f.url);
            if (f.bitmap && f.bitmap.close) f.bitmap.close();
        });
        this.frameBuffer = [];
    }

    async connectStream() {
        while (this.isRunning) {
            try {
                const controller = new AbortController();
                this.activeFetch = controller;
                
                const response = await fetch(this.streamUrl, {
                    signal: controller.signal,
                    cache: 'no-store'
                });

                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                
                const reader = response.body.getReader();
                
                while (this.isRunning) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    this.appendAndParse(value);
                }
            } catch (e) {
                if (e.name === 'AbortError') return;
                console.warn("TelemachusCameraStream connection lost, retrying in 2s...", e);
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    }

    appendAndParse(chunk) {
        let newBuffer = new Uint8Array(this.chunkParser.buffer.length + chunk.length);
        newBuffer.set(this.chunkParser.buffer);
        newBuffer.set(chunk, this.chunkParser.buffer.length);
        this.chunkParser.buffer = newBuffer;
        this.processBuffer();
    }

    async processBuffer() {
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        
        while (this.chunkParser.buffer.length > 0) {
            if (this.chunkParser.searchingHeader) {
                const headerEndStr = "\r\n\r\n";
                const strBuffer = decoder.decode(this.chunkParser.buffer);
                const headerEndIdx = strBuffer.indexOf(headerEndStr);

                if (headerEndIdx === -1) return;

                const headerStr = strBuffer.substring(0, headerEndIdx);
                const lines = headerStr.split('\r\n');
                let contentLength = 0;
                let kspUT = 0;

                lines.forEach(line => {
                    const lowerLine = line.toLowerCase();
                    if (lowerLine.startsWith('content-length:')) {
                        contentLength = parseInt(line.split(':')[1].trim(), 10);
                    } else if (lowerLine.startsWith('x-ksp-ut:')) {
                        kspUT = parseFloat(line.split(':')[1].trim());
                    } else if (lowerLine.startsWith('x-ksp-warp:')) {
                        this.chunkParser.kspWarp = parseFloat(line.split(':')[1].trim());
                    } else if (lowerLine.startsWith('x-ksp-delay:')) {
                        this.chunkParser.kspDelay = parseFloat(line.split(':')[1].trim());
                    }
                });

                this.chunkParser.contentLength = contentLength;
                this.chunkParser.kspUT = kspUT;
                this.chunkParser.searchingHeader = false;

                const headerByteLen = encoder.encode(headerStr).length + 4; 
                this.chunkParser.buffer = this.chunkParser.buffer.slice(headerByteLen);
            } else {
                if (this.chunkParser.contentLength > 0 && this.chunkParser.buffer.length >= this.chunkParser.contentLength) {
                    const imgBytes = this.chunkParser.buffer.slice(0, this.chunkParser.contentLength);
                    const blob = new Blob([imgBytes], { type: 'image/jpeg' });
                    
                    // Optimization: convert to ImageBitmap immediately if on a modern browser
                    // and using canvas. This avoids creating blob URLs in the registry.
                    if (this.isCanvas && typeof createImageBitmap !== 'undefined') {
                        const bitmap = await createImageBitmap(blob);
                        this.frameBuffer.push({ 
                            bitmap: bitmap, 
                            ut: this.chunkParser.kspUT,
                            warp: this.chunkParser.kspWarp || 1,
                            delay: this.chunkParser.kspDelay || 0
                        });
                    } else {
                        const url = URL.createObjectURL(blob);
                        this.frameBuffer.push({ 
                            url: url, 
                            ut: this.chunkParser.kspUT,
                            warp: this.chunkParser.kspWarp || 1,
                            delay: this.chunkParser.kspDelay || 0
                        });
                    }

                    this.chunkParser.buffer = this.chunkParser.buffer.slice(this.chunkParser.contentLength);
                    this.chunkParser.searchingHeader = true;
                    this.chunkParser.contentLength = 0;
                } else {
                    return;
                }
            }
        }
    }

    playbackLoop() {
        if (!this.isRunning) return;

        if (this.datalink && this.frameBuffer.length > 0) {
            const universalTime = this.datalink.get ? this.datalink.get('t.universalTime') : Date.now();
            const delay = this.datalink.get ? (this.datalink.get('comm.signalDelay') || 0) : 0;
            const delayedTimecode = universalTime - delay;

            let frameToDraw = null;
            while (this.frameBuffer.length > 0 && this.frameBuffer[0].ut <= delayedTimecode) {
                if (frameToDraw) {
                    // Dispose of skipped frame
                    if (frameToDraw.url) URL.revokeObjectURL(frameToDraw.url);
                    if (frameToDraw.bitmap && frameToDraw.bitmap.close) frameToDraw.bitmap.close();
                }
                frameToDraw = this.frameBuffer.shift();
            }

            if (frameToDraw) {
                // Instantly update the master clock/warp if the stream provides it
                if (frameToDraw.ut && this.datalink.syncFromStream) {
                    this.datalink.syncFromStream(frameToDraw.ut, frameToDraw.warp, frameToDraw.delay);
                }

                if (this.isCanvas) {
                    // Draw to canvas
                    if (frameToDraw.bitmap) {
                        this.displayElement.width = frameToDraw.bitmap.width;
                        this.displayElement.height = frameToDraw.bitmap.height;
                        this.ctx.drawImage(frameToDraw.bitmap, 0, 0);
                        frameToDraw.bitmap.close();
                    } else {
                        // Fallback for non-bitmap frames
                        const img = new Image();
                        img.onload = () => {
                            this.displayElement.width = img.width;
                            this.displayElement.height = img.height;
                            this.ctx.drawImage(img, 0, 0);
                            URL.revokeObjectURL(frameToDraw.url);
                        };
                        img.src = frameToDraw.url;
                    }
                } else {
                    // Draw to img tag
                    const oldUrl = this.displayElement.src;
                    this.displayElement.src = frameToDraw.url;
                    // Revoke old URL only after it has been replaced to avoid flicker
                    if (oldUrl.startsWith('blob:')) {
                        // Minimal delay to ensure browser finished drawing previous frame
                        setTimeout(() => URL.revokeObjectURL(oldUrl), 100);
                    }
                }
            }
            
            if (this.frameBuffer.length > 100) {
                const drop = this.frameBuffer.shift();
                if (drop.url) URL.revokeObjectURL(drop.url);
                if (drop.bitmap && drop.bitmap.close) drop.bitmap.close();
            }
        }

        requestAnimationFrame(() => this.playbackLoop());
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = TelemachusCameraStream;
} else if (typeof window !== 'undefined') {
    window.TelemachusCameraStream = TelemachusCameraStream;
}
