using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using UnityEngine;

namespace Telemachus.CameraSnapshots
{
    public class RasterPropMonitorCameraCapture : CameraCapture
    {
        public RasterPropMonitorCamera rpmCamera;
        protected static string cameraManagerNamePrefix = "RPMCamera-";
        protected static readonly string[] camerasToSkipPositionTransform = { "GalaxyCamera", "Camera ScaledSpace", "Camera VE Underlay" };
        protected Regex _cameraSkipRegex;
        protected Regex cameraSkipRegex
        {
            get
            {
                if (_cameraSkipRegex == null)
                {
                    _cameraSkipRegex = new Regex("(" + String.Join("|", camerasToSkipPositionTransform) + ")$");
                }

                return _cameraSkipRegex;
            }
        }

        protected override bool ShouldSkipCamera(Camera camera)
        {
            if (base.ShouldSkipCamera(camera)) return true;
            // InternalCamera is the IVA cockpit. If we move its duplicate to the exterior of the ship,
            // it draws a tiny distant floating IVA box over the terrain.
            if (camera.name == "InternalCamera") return true;
            return false;
        }

        private float GetFieldFloat(string hullcamField, string rpmField, float fallback)
        {
            if (rpmCamera != null)
            {
                // Native Hullcam VDS FOV check!
                foreach (PartModule module in rpmCamera.part.Modules)
                {
                    if (module.moduleName == "MuMechModuleHullCamera" || module.moduleName == "HullCamera")
                    {
                        var field = module.Fields[hullcamField];
                        if (field != null && field.GetValue(module) != null)
                        {
                            return (float)field.GetValue(module);
                        }
                    }
                }

                object fovObj = rpmCamera.getRPMField(rpmField);
                if (fovObj != null)
                {
                    return (float)fovObj; // Default RPM FOV
                }
            }
            return fallback;
        }

        public override float minFOV => GetFieldFloat("cameraFoVMin", "cameraFoVMin", base.minFOV);
        public override float maxFOV => GetFieldFloat("cameraFoVMax", "cameraFoVMax", base.maxFOV);
        public override float defaultFOV => GetFieldFloat("cameraFoV", "cameraFoVMax", base.defaultFOV);



        public override string cameraManagerName()
        {
            return buildCameraManagerName(rpmCamera.cameraName);
        }

        public override string cameraType()
        {
            return "RasterPropMonitor";
        }

        protected bool builtCameraDuplicates = false;

        public static string buildCameraManagerName(string name)
        {
            return cameraManagerNamePrefix + name;
        }

        public override void additionalCameraUpdates(Camera dupliateCam, Camera gameCamera)
        {
            base.additionalCameraUpdates(dupliateCam, gameCamera);
            Transform actualCamTransform = rpmCamera.actualCamera;

            if (actualCamTransform != null)
            {
                if (!cameraSkipRegex.IsMatch(gameCamera.name))
                {
                    dupliateCam.transform.position = actualCamTransform.position;
                }
                dupliateCam.transform.rotation = actualCamTransform.rotation;
            }
            else
            {
                if (!cameraSkipRegex.IsMatch(gameCamera.name))
                {
                    dupliateCam.transform.position = rpmCamera.part.transform.position;
                }

                // Just in case to support JSITransparentPod.
                //cam.cullingMask &= ~(1 << 16 | 1 << 20);

                dupliateCam.transform.rotation = rpmCamera.part.transform.rotation;
                dupliateCam.transform.Rotate(rpmCamera.rotateCamera);
                // dupliateCam.transform.position += rpmCamera.translateCamera;
                dupliateCam.transform.Translate(rpmCamera.translateCamera, Space.Self);
            }
        }

        /*public override void additionalCameraUpdates(Camera cam)
        {
            if (!cameraSkipRegex.IsMatch(cam.name))
            {
                cam.transform.position = rpmCamera.part.transform.position;
            }

            // Just in case to support JSITransparentPod.
            //cam.cullingMask &= ~(1 << 16 | 1 << 20);

            cam.transform.rotation = rpmCamera.part.transform.rotation;
            cam.transform.Rotate(rpmCamera.rotateCamera);
            cam.transform.position += rpmCamera.translateCamera;
            
            base.additionalCameraUpdates(cam);
        }*/
    }
}
