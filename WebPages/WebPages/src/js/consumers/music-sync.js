/**
 * Soundtrack Synchronization Module
 * Synchronizes local MP3 playback with KSP in-game music metadata.
 */
class MusicSync {
    constructor() {
        this.audioPath = '../audio/';
        this.currentTrack = null;
        this.audio = new Audio();
        this.isPlaying = false;
        this.isMuted = true;
        
        // v16.140: Sync precision increased to 1.5s for tighter musical alignment.
        this.syncThreshold = 1.5; 
        
        this.widget = null;
        this.elements = {};
        this.pendingSeekTime = -1;

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.init());
        } else {
            this.init();
        }
    }

    init() {
        this.bindElements();
        this.audio.loop = false; 
        
        const savedVol = localStorage.getItem('music-volume');
        this.audio.volume = savedVol !== null ? parseFloat(savedVol) : 0.5;
        if (this.elements.volume) this.elements.volume.value = this.audio.volume;
        this.audio.muted = this.isMuted;

        window.addEventListener('click', () => {
            if (this.audio.paused && this.isPlaying) {
                console.log("[MusicSync] Browser Unlocked: Attempting play.");
                this.audio.play().catch(() => {});
            }
        }, { once: true });

        this.audio.oncanplay = () => {
            if (this.pendingSeekTime >= 0) {
                this.audio.currentTime = this.pendingSeekTime;
                const target = this.pendingSeekTime;
                setTimeout(() => {
                    if (Math.abs(this.audio.currentTime - target) > 0.5) {
                        this.audio.currentTime = target;
                    }
                    this.pendingSeekTime = -1;
                }, 200);
            }
        };

        this.audio.onerror = (e) => {
            const trackName = this.currentTrack ? this.currentTrack.split('/').pop().toUpperCase() : 'UNKNOWN';
            this.showError(`MISSING: ${trackName}`);
        };

        this.waitForSignalLink();
    }

    waitForSignalLink() {
        if (window.app && window.app.signalLink) {
            window.app.signalLink.on('soundtrack', (packet) => {
                this.handleMetadata(packet.data);
            });
            window.app.signalLink.on('close', () => {
                this.stopPlayback();
                this.showError('SIGNAL LOST');
            });
            window.app.signalLink.on('open', () => {
                if (this.elements.name.textContent === 'SIGNAL LOST') {
                    this.elements.name.textContent = 'SILENCE';
                    this.elements.name.style.color = '';
                }
                // v18.11: No manual request needed, subscribeSoundtrack handles initial state
            });
        } else {
            setTimeout(() => this.waitForSignalLink(), 100);
        }
    }

    bindElements() {
        this.widget = document.getElementById('music-player-widget');
        if (!this.widget) return;
        this.elements.name = this.widget.querySelector('#music-name');
        this.elements.toggle = this.widget.querySelector('#music-toggle');
        this.elements.volume = this.widget.querySelector('#music-volume');
        this.elements.icon = this.elements.toggle ? this.elements.toggle.querySelector('.icon') : null;
        
        if (this.elements.toggle) {
            this.elements.toggle.onclick = () => this.toggleMute();
        }

        if (this.elements.volume) {
            this.elements.volume.oninput = (e) => {
                const vol = parseFloat(e.target.value);
                this.audio.volume = vol;
                localStorage.setItem('music-volume', vol);
            };
        }
    }

    showError(text) {
        if (this.elements.name) {
            this.elements.name.textContent = text;
            this.elements.name.style.color = '#ff4c4c';
            this.elements.name.style.textShadow = '0 0 5px rgba(255,76,76,0.5)';
        }
        this.widget.classList.remove('playing');
    }

    toggleMute() {
        this.isMuted = !this.isMuted;
        this.audio.muted = this.isMuted;
        if (this.isMuted) {
            this.elements.icon.textContent = '🔇';
            this.elements.toggle.classList.add('muted');
        } else {
            this.elements.icon.textContent = '🔊';
            this.elements.toggle.classList.remove('muted');
            if (this.audio.paused && this.isPlaying) {
                this.audio.play().catch(() => {});
            }
        }
    }

    handleMetadata(msg) {
        const { name, time, isPlaying } = msg;
        const normalizedName = (name || "").toLowerCase();

        if (normalizedName === 'radiosilence' || normalizedName === 'none' || !name) {
            this.stopPlayback();
            return;
        }

        if (name !== this.currentTrack) {
            this.currentTrack = name;
            let display = name.split('/').pop().replace('.mp3', '').toUpperCase();
            this.elements.name.textContent = display;
            this.elements.name.style.color = '';
            this.elements.name.style.textShadow = '';
            this.loadTrack(name, time);
        }

        this.isPlaying = isPlaying;

        if (this.isPlaying) {
            if (this.audio.paused && this.audio.src) {
                this.audio.play().then(() => this.widget.classList.add('playing')).catch(() => {});
            } else {
                this.widget.classList.add('playing');
            }
        } else if (!this.audio.paused) {
            this.audio.pause();
            this.widget.classList.remove('playing');
        }

        // v16.141: Sync Time with new 1.5s tolerance
        if (this.isPlaying && this.audio.readyState >= 2) {
            const diff = Math.abs(this.audio.currentTime - time);
            if (diff > this.syncThreshold) {
                console.log(`[MusicSync] Re-syncing offset: ${diff.toFixed(2)}s`);
                this.audio.currentTime = time + 0.2;
            }
        }
    }

    stopPlayback() {
        if (this.elements.name && !this.elements.name.style.color) {
            this.elements.name.textContent = 'SILENCE';
        }
        this.currentTrack = null;
        this.audio.pause();
        this.audio.src = '';
        this.widget.classList.remove('playing');
    }

    loadTrack(name, startTime) {
        let filename = name.split('/').pop();
        if (!filename.toLowerCase().endsWith('.mp3')) filename += '.mp3';
        const finalUrl = `${this.audioPath}${encodeURIComponent(filename)}`;
        this.audio.src = finalUrl;
        this.pendingSeekTime = startTime + 0.2;
        this.audio.load();
        if (this.isPlaying) {
            this.audio.play().catch(() => {});
        }
    }
}

window.MusicSync = new MusicSync();
