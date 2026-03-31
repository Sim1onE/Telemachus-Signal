/**
 * Isolated Component (Composition Pattern)
 * This class uses the TelemachusSignalLink, but does NOT inherit from it.
 * Its only job is to decode JPEG byte chunks to a Canvas and create the "Fast-Forward" effect.
 */
class CameraReceiver {
    constructor(signalLink, displayElement, datalink) {
        this.signalLink = signalLink;
        this.displayElement = displayElement;
        this.datalink = datalink;

        this.isCanvas = displayElement instanceof HTMLCanvasElement;
        if (this.isCanvas) {
            this.ctx = displayElement.getContext('2d');
        }

        // The isolated time-buffer given to this specific receiver
        this.buffer = new DownlinkSynchronizer();
        this.isRunning = false;

        // Subscribe to Type 0 (Video) packets flowing out of the main Hub
        this.signalLink.on(PacketType.VIDEO_DOWNLINK, this.handleIncomingVideo.bind(this));
    }

    start(sensorName) {
        this.isRunning = true;
        // Ask KSP to start streaming video for this sensor
        this.signalLink.sendSystemCommand({ camera: sensorName });
        this.playbackLoop();
    }

    stop() {
        this.isRunning = false;
        
        // Clean up memory
        this.buffer.buffer.forEach(f => {
            if (f.payload.bitmap && f.payload.bitmap.close) f.payload.bitmap.close();
        });
        
        this.buffer.clear();
    }

    // Fired instantly when the hub reads the 34-byte header
    async handleIncomingVideo(metadata, rawData) {
        if (!this.isRunning) return;

        // Skip the 34-byte header, read the JPEG
        const jpgBytes = new Uint8Array(rawData, 34);
        const blob = new Blob([jpgBytes], { type: 'image/jpeg' });

        try {
             // Hardware Accelerated JPG decoding off the main thread
             const bitmap = await createImageBitmap(blob);
             
             // Queue the frame in the synchronizer for delayed playback
             this.buffer.pushPacket(
                 metadata.ut, metadata.warp, metadata.delay, 
                 metadata.fov, metadata.quality, 
                 { bitmap }
             );
        } catch (err) {
             console.error("[CameraReceiver] Frame decoding fault:", err);
        }
    }

    playbackLoop() {
        if (!this.isRunning) return;

        if (this.datalink && this.buffer.buffer.length > 0) {
            
            // 1. Calculate Master Clock
            const universalTime = this.datalink.get ? this.datalink.get('t.universalTime') : Date.now();
            
            // 2. Obtain Instant Delay from the Link
            const currentDelay = this.signalLink.latestNetworkDelay;
            
            // 3. Subtract to find the exact historical moment we should be presenting
            const delayedTimecode = universalTime - currentDelay;

            // 4. Extract all frames that are older than our target presentation moment
            const expiredFrames = this.buffer.popReady(delayedTimecode);
            
            // ---------------------------------------------------------------------
            // DYNAMIC BURST CATCH-UP LOGIC
            // If the delay suddenly drops (e.g. 10s to 0s), popReady() returns a burst.
            // We draw up to `burstLimit` frames per tick sequentially to mimic Fast-Forward.
            // ---------------------------------------------------------------------
            
            let frameToDraw = null;
            const burstLimit = 10;
            const drawCount = Math.min(expiredFrames.length, burstLimit);
            
            // Return surplus frames back to the top of the queue if the burst is too large
            if (expiredFrames.length > burstLimit) {
                 const surplus = expiredFrames.slice(burstLimit);
                 this.buffer.buffer.unshift(...surplus);
            }

            for(let i=0; i < drawCount; i++) {
                 // Close bitmaps of previous frames in the burst to free up memory instantly
                 if (frameToDraw && frameToDraw.payload.bitmap && frameToDraw.payload.bitmap.close) {
                     frameToDraw.payload.bitmap.close();
                 }
                 frameToDraw = expiredFrames[i];
            }

            if (frameToDraw) {
                // Instantly sync UI metadata (FOV, Quality bars) as the frame is displayed
                if (frameToDraw.ut && this.datalink.syncFromStream) {
                    this.datalink.syncFromStream(
                        frameToDraw.ut,
                        frameToDraw.warp,
                        frameToDraw.delay,
                        frameToDraw.fov,
                        frameToDraw.quality
                    );
                }

                // Render
                if (this.isCanvas && frameToDraw.payload.bitmap) {
                    // Update canvas resolution dynamically if Signal Quality alters the incoming jpeg size
                    if (this.displayElement.width !== frameToDraw.payload.bitmap.width || this.displayElement.height !== frameToDraw.payload.bitmap.height) {
                        this.displayElement.width = frameToDraw.payload.bitmap.width;
                        this.displayElement.height = frameToDraw.payload.bitmap.height;
                    }
                    this.ctx.drawImage(frameToDraw.payload.bitmap, 0, 0);
                    frameToDraw.payload.bitmap.close();
                }
            }
        }

        requestAnimationFrame(() => this.playbackLoop());
    }
}

// Export
if (typeof window !== 'undefined') {
    window.CameraReceiver = CameraReceiver;
}
