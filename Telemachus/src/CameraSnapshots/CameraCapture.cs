using UnityEngine;
using System.Collections;
using System;
using System.Collections.Generic;
using System.Linq;

namespace Telemachus.CameraSnapshots
{
    public class CameraCapture : MonoBehaviour
    {
        public RenderTexture overviewTexture;
        public bool didRender;
        public byte[] imageBytes = null;
        public long lastFrameId = 0;
        public volatile bool mutex = false;
        public int renderOffsetFactor = 0;
        public int lastRequestTick = Environment.TickCount - 6000; // Force immediate render on first check
        private Texture2D persistentTexture = null;
        private float nextRenderTime = 0f;
        public static float DebugSignalOverride = -1f;
        public static float DebugDelayOverride = -1f;

        public double SignalStrength => currentSignalStrength;

        protected double currentSignalStrength
        {
            get
            {
                if (DebugSignalOverride >= 0f) return (double)DebugSignalOverride;

                return TelemachusSignalManager.GetActualSignalStrength(FlightGlobals.ActiveVessel);
            }
        }

        public virtual string cameraManagerName()
        {
            return "NA";
        }

        public virtual string cameraType()
        {
            return "NA";
        }

        public float customFOV = -1f;
        public float interpolatedFOV = -1f;

        public virtual float minFOV => 1f;
        public virtual float maxFOV => 120f;
        public virtual float defaultFOV => fovAngle;

        protected Dictionary<string, Camera> cameraDuplicates = new();
        protected List<string> activeCameras = new();
        protected static readonly string[] skippedCameras = { "UIMainCamera", "UIVectorCamera", "velocity camera" };

        public Dictionary<string, Camera> gameCameraMapping = new();


        protected string cameraContainerNamePrefix
        {
            get
            {
                return "TelemachusCameraContainer:" + cameraManagerName();
            }
        }

        protected const float fovAngle = 60f;
        protected const float aspect = 1.0f;
        public int cameraResolution = 300;

        protected bool skipFarCamera
        {
            get
            {
                // Copied from RasterPropMonitor: disables nearClipPlane math on KSP 1.9+
                return SystemInfo.graphicsDeviceVersion.StartsWith("Direct3D") &&
                       (Versioning.fetch.versionMinor >= 9 || Versioning.fetch.versionMajor > 1);
            }
        }

        protected void OnEnable()
        {
            Camera.onPostRender += disableCameraIfInList;
        }

        protected void OnDisable()
        {
            Camera.onPostRender -= disableCameraIfInList;
        }

        protected void OnDestroy()
        {
            if (persistentTexture != null) Destroy(persistentTexture);
        }

        private void disableCameraIfInList(Camera cam)
        {
            if (cameraDuplicates.ContainsValue(cam))
            {
                //PluginLogger.debug("DISABLE CAMERA:"+ cam.name);
                cam.enabled = false;
            }
        }

        protected virtual void LateUpdate()
        {
            if (CameraManager.Instance != null && HighLogic.LoadedSceneIsFlight && !mutex)
            {
                // Strict Real-time timing check
                if (Time.unscaledTime < nextRenderTime) return;

                mutex = true;
                duplicateAnyNewCameras();
                repositionCamera();
                StartCoroutine(newRender());
            }
        }

        public IEnumerator newRender()
        {
            int delta = Environment.TickCount - lastRequestTick;
            if (delta > 5000 || delta < 0) 
            {
                nextRenderTime = Time.unscaledTime + 1.0f;
                mutex = false;
                yield break;
            }

            double signal = currentSignalStrength;

            if (signal < 0.01)
            {
                nextRenderTime = Time.unscaledTime + 2.0f;
                mutex = false;
                yield break;
            }

            // --- DEEP SPACE DEGRADATION LOGIC ---
            // Calculate target resolution based on signal strength
            int targetRes = cameraResolution;
            if (signal < 0.08) targetRes /= 4;       // Critical Signal: Mosaic mode
            else if (signal < 0.25) targetRes /= 2;  // Low Signal: Grainy mode

            // Re-initialize texture if resolution changed due to signal flux
            if (overviewTexture == null || overviewTexture.width != targetRes)
            {
                if (overviewTexture != null) overviewTexture.Release();
                overviewTexture = new RenderTexture(targetRes, targetRes, 24);
                
                // Update all duplicate cameras to use the new texture
                foreach (var cam in cameraDuplicates.Values) {
                    cam.targetTexture = overviewTexture;
                }
            }

            // Render immediately in LateUpdate (no WaitForEndOfFrame)
            var sortedCameras = cameraDuplicates.Values.OrderBy(c => c.depth).ToList();
            foreach (Camera camera in sortedCameras)
            {
                camera.Render();
            }

            Texture2D texture = getTexture2DFromRenderTexture();
            
            // Adjust JPEG quality based on signal (very low for bad signal)
            int jpgQuality = (int)Mathf.Lerp(2f, 85f, (float)signal);
            this.imageBytes = texture.EncodeToJPG(jpgQuality);
            this.didRender = true;
            this.lastFrameId++;

            // Calculate next render slot (Framerate Reduction)
            // Signal 1.0 -> 30 FPS (0.033s)
            // Signal 0.3 -> 5 FPS (0.2s)
            // Signal 0.05 -> 0.5 FPS (2.0s)
            float baseWait = Mathf.Lerp(2.0f, 0.033f, (float)Mathf.Pow((float)signal, 0.7f)); // Non-linear curve for "dramatic" drop
            float offset = (delta < 2000) ? 0f : (0.05f * renderOffsetFactor);
            
            nextRenderTime = Time.unscaledTime + baseWait + offset;
            mutex = false;
            yield break;
        }

        public Texture2D getTexture2DFromRenderTexture()
        {
            if (persistentTexture == null || 
                persistentTexture.width != overviewTexture.width || 
                persistentTexture.height != overviewTexture.height)
            {
                if (persistentTexture != null) Destroy(persistentTexture);
                persistentTexture = new Texture2D(overviewTexture.width, overviewTexture.height, TextureFormat.RGB24, false);
            }

            RenderTexture.active = overviewTexture;
            persistentTexture.ReadPixels(new Rect(0, 0, overviewTexture.width, overviewTexture.height), 0, 0);
            persistentTexture.Apply();
            return persistentTexture;
        }

        protected virtual bool ShouldSkipCamera(Camera camera)
        {
            if (skippedCameras.Contains(camera.name)) return true;

            // Critical filter: do not duplicate cameras created by other mods (like RPM)
            // that render to their own Textures. This prevents infinite camera recursion!
            if (camera.targetTexture != null) return true;

            return false;
        }

        public void duplicateAnyNewCameras()
        {
            if (overviewTexture == null)
            {
                overviewTexture = new RenderTexture(cameraResolution, cameraResolution, 24);
            }

            List<string> currentlyActiveCameras = new List<string>();

            foreach (Camera camera in Camera.allCameras)
            {
                if (ShouldSkipCamera(camera))
                {
                    continue;
                }

                //PluginLogger.debug(cameraManagerName() +  " {" + verboseCameraDetails(camera) + "}");

                if (!cameraDuplicates.ContainsKey(camera.name))
                {
                    var cameraDuplicateGameObject = new GameObject(cameraContainerNamePrefix + camera.name);
                    Camera cameraDuplicate = cameraDuplicateGameObject.AddComponent<Camera>();
                    cameraDuplicates[camera.name] = cameraDuplicate;
                    cameraDuplicate.CopyFrom(camera);
                    cameraDuplicate.fieldOfView = GetFOV(camera);
                    cameraDuplicate.aspect = GetAspect(camera);

                    cameraDuplicate.targetTexture = this.overviewTexture;

                    // --- CULLING MASK FIX ---
                    // bit 10: ScaledSpace (Orbits), bit 24: MapUI, bit 31: MapOverlay
                    int maskToRemove = (1 << 10) | (1 << 24) | (1 << 31);
                    cameraDuplicate.cullingMask &= ~maskToRemove;

                    // Adjust near clip only for small parts/FX cameras like RPM does,
                    // but ONLY on KSP < 1.9 where this fix was needed to avoid Z-fighting.
                    if (!skipFarCamera && (camera.name == "Camera 00" || camera.name == "FXCamera"))
                    {
                        cameraDuplicate.nearClipPlane = cameraDuplicate.farClipPlane / 8192.0f;
                    }

                    //Now that the camera has been duplicated, add it to the list of active cameras
                    activeCameras.Add(camera.name);
                    if (!gameCameraMapping.ContainsKey(camera.name))
                    {
                        gameCameraMapping[camera.name] = camera;
                    }
                }

                //Mark the camera as enabled so it will be rendered again
                if (cameraDuplicates.ContainsKey(camera.name))
                {
                    cameraDuplicates[camera.name].enabled = false;
                }

                //Mark that the camera is currently active
                currentlyActiveCameras.Add(camera.name);
            }

            if (currentlyActiveCameras.Count > 0 && activeCameras.Count > 0)
            {
                IEnumerable<string> disabledCameras = activeCameras.Except(currentlyActiveCameras);
                foreach (string disabledCamera in disabledCameras)
                {
                    if (cameraDuplicates.ContainsKey(disabledCamera))
                    {
                        Destroy(cameraDuplicates[disabledCamera]);
                        cameraDuplicates.Remove(disabledCamera);
                    }
                }

                activeCameras = currentlyActiveCameras;
            }
        }


        protected virtual float GetFOV(Camera gameCamera)
        {
            if (customFOV > 0 && !float.IsNaN(customFOV))
            {
                // Init if needed (should be already synced, but safety first)
                if (interpolatedFOV <= 0 || float.IsNaN(interpolatedFOV)) 
                    interpolatedFOV = gameCamera.fieldOfView;

                // Move towards target smoothly at 40 deg/sec
                interpolatedFOV = Mathf.MoveTowards(interpolatedFOV, customFOV, Time.unscaledDeltaTime * 40.0f);
                interpolatedFOV = Mathf.Clamp(interpolatedFOV, 1f, 175f);
                return interpolatedFOV;
            }

            // Continuously track the module's default FOV when not under Houston control
            // This ensures zero-jump transition when zooming starts.
            interpolatedFOV = defaultFOV; 
            if (float.IsNaN(interpolatedFOV) || interpolatedFOV <= 0) interpolatedFOV = 60f; // Ultimate fallback
            return interpolatedFOV;
        }

        protected virtual float GetAspect(Camera gameCamera)
        {
            return aspect;
        }

        public virtual void repositionCamera()
        {
            foreach (KeyValuePair<string, Camera> KVP in cameraDuplicates)
            {
                Camera cameraDuplicate = KVP.Value;
                Camera gameCamera = gameCameraMapping[KVP.Key];

                cameraDuplicate.transform.position = gameCamera.transform.position;
                cameraDuplicate.transform.rotation = gameCamera.transform.rotation;
                cameraDuplicate.fieldOfView = GetFOV(gameCamera);
                cameraDuplicate.aspect = GetAspect(gameCamera);

                additionalCameraUpdates(cameraDuplicate, gameCamera);
            }
        }

        public string verboseCameraDetails(Camera camera)
        {
            string[] debugProperties = {
                "CAMERA INFO: " + camera.name,
                "TARGET DISPLAY: " + camera.targetDisplay,
                "TARGET TEXTURE: " + camera.targetTexture,
                "RENDERING PATH: " + camera.renderingPath,
                "ACTUAL RENDER PATH: " + camera.actualRenderingPath,
                "CAMERA TYPE: " + camera.cameraType,
                "GAME OBJECT: " + camera.gameObject,
                "BG COLOR: " + camera.backgroundColor,
                "CULLING MASK: " + camera.cullingMask,
                "DEPTH: " + camera.depth,
                "HDR: " + camera.allowHDR,
                "POSITION: " + camera.transform.position,
                "ROT: " + camera.transform.rotation,
                "NEAR: " + camera.nearClipPlane,
                "FAR: " + camera.farClipPlane,
                "LOCAL EULER ANGLES: " + camera.transform.localEulerAngles,
                "LOCAL POSITION: " + camera.transform.localPosition,
                "LOCAL SCALE: " + camera.transform.localScale,
                "EULER ANGLES: " + camera.transform.eulerAngles
            };
            return String.Join("\n", debugProperties);
        }

        public void verboseCameraDebug(Camera camera)
        {
            PluginLogger.debug(verboseCameraDetails(camera));
        }


        public virtual void additionalCameraUpdates(Camera dupliateCam, Camera gameCamera) { }

        public virtual void debugCameraDetails(Camera cam)
        {
            PluginLogger.debug("CAMERA: " + cam.name + " POS: " + cam.transform.position + "; ROT: " + cam.transform.rotation + " ; NEAR:" + cam.nearClipPlane + "; FAR: " + cam.farClipPlane);
        }

        public virtual void BeforeRenderNewScreenshot() { }
    }
}